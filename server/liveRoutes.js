// Field Live control plane (routes).
//
// Three callers, three ways of proving who they are, because they are genuinely
// different principals:
//
//   Command UI   requireInternal — staff managing a job
//   the phone    the stream key it was issued — no login flow on the device yet
//   the relay    DM_RELAY_TOKEN — a machine, not a person
//
// Video never passes through here. Live copies go relay → R2 directly; masters
// go phone → R2 by presigned part. This service only ever moves decisions.
import express from 'express';
import { log, alertOps } from './observability.js';
import {
  createUpload, presignPart, appendLocalPart, completeUpload,
  listUploadedParts, storageMode, storageReady, missingStorageConfig,
} from './storage.js';
import {
  createStream, getStream, listStreams, endStream, withUrls, playbackUrl,
  authorize, recordRelayState, addEvent, listEvents, sessionReport,
  relayTokenValid, httpError, MASTER_PART_SIZE, newId,
} from './liveLogic.js';

// Who may fetch a playback URL. Defaults to requiring a session: an open
// endpoint hands anyone with a stream id a viewable link to a youth game.
const PLAYBACK_ACCESS = process.env.DM_LIVE_PLAYBACK_ACCESS || 'authenticated';

export function mountLiveRoutes(app, { db, requireInternal, currentUser }) {
  const r = express.Router();

  // ── who is calling ────────────────────────────────────────────────────────

  // MediaMTX cannot set headers on its auth call, so that one secret arrives in
  // the query string; our own hooks use a bearer header.
  function requireRelay(req, res, next) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (relayTokenValid(bearer ?? req.query.relay_token)) return next();
    log('warn', 'live_relay_auth_failed', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'relay token required' });
  }

  // The phone holds no session, but it does hold the key for its own stream —
  // which is exactly the claim it needs to make.
  function requireStreamKey(req, res, next) {
    const stream = getStream(db, req.params.id ?? req.params.streamId);
    if (!stream) return res.status(404).json({ error: 'stream not found' });
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (supplied !== stream.stream_key) return res.status(401).json({ error: 'stream key required' });
    req.liveStream = stream;
    next();
  }

  function requireViewer(req, res, next) {
    if (PLAYBACK_ACCESS === 'public') return next();
    if (currentUser?.(req)) return next();
    return res.status(401).json({ error: 'Sign in to watch this stream' });
  }

  // ── Command: issuing and managing streams ─────────────────────────────────

  r.post('/streams', requireInternal, (req, res) => {
    const stream = createStream(db, req.body || {});
    log('info', 'live_stream_created', { stream_id: stream.id, job_id: stream.job_id });
    res.status(201).json(stream);
  });

  r.get('/streams', requireInternal, (req, res) => {
    res.json(listStreams(db, { jobId: req.query.job_id }).map((s) => withUrls(s)));
  });

  r.post('/streams/:id/end', requireInternal, (req, res) => {
    res.json(withUrls(endStream(db, req.params.id)));
  });

  // Full detail, keys included — staff only.
  r.get('/streams/:id', requireInternal, (req, res) => {
    const stream = getStream(db, req.params.id);
    if (!stream) throw httpError(404, 'stream not found');
    res.json({
      ...withUrls(stream),
      events: listEvents(db, stream.id),
      report: sessionReport(db, stream.id),
      masters: listMasters(db, stream.id),
    });
  });

  // What a viewer page may know: no key, no ingest URLs.
  r.get('/streams/:id/public', requireViewer, (req, res) => {
    const stream = getStream(db, req.params.id);
    if (!stream) throw httpError(404, 'stream not found');
    res.json({
      id: stream.id,
      label: stream.label,
      status: stream.status,
      consent: stream.consent,
      started_at: stream.started_at,
      ended_at: stream.ended_at,
    });
  });

  r.get('/streams/:id/playback', requireViewer, (req, res) => {
    const stream = getStream(db, req.params.id);
    if (!stream) throw httpError(404, 'stream not found');
    res.json(playbackUrl(stream));
  });

  // ── the relay ─────────────────────────────────────────────────────────────

  r.post('/auth', requireRelay, (req, res) => {
    const body = req.body || {};
    const verdict = authorize(db, body);
    // A successful viewer read is not worth a row: MediaMTX authorises once per
    // HLS session and clients re-sign, so logging them buries live/offline under
    // hundreds of entries. Publishes and every denial are kept.
    if (verdict.stream && (body.action === 'publish' || !verdict.allow)) {
      addEvent(db, verdict.stream.id,
        verdict.allow ? `auth_${body.action}_ok` : `auth_${body.action}_denied`,
        { protocol: body.protocol, ip: body.ip, reason: verdict.reason ?? null }, 'relay');
    }
    if (!verdict.allow) return res.status(401).json({ error: verdict.reason });
    res.status(200).json({ ok: true });
  });

  r.post('/events', requireRelay, (req, res) => {
    const { path, state, ...detail } = req.body || {};
    const stream = recordRelayState(db, path, state, detail);
    log('info', 'live_state', { stream_id: stream.id, state, job_id: stream.job_id });
    res.json({ ok: true, status: stream.status });
  });

  r.post('/recordings', requireRelay, (req, res) => {
    const { path, segment, duration } = req.body || {};
    const stream = listStreams(db).find((s) => s.path === path);
    if (!stream) throw httpError(404, `no stream for path ${path}`);
    db.prepare('UPDATE cmd_live_streams SET recording_prefix = ? WHERE id = ?').run(`${stream.path}/`, stream.id);
    addEvent(db, stream.id, 'segment', { segment, duration }, 'relay');
    res.json({ ok: true });
  });

  // The relay's disk check. Disk filling is the failure that loses a tournament
  // and it is otherwise completely silent.
  r.post('/alerts', requireRelay, (req, res) => {
    const { kind, ...fields } = req.body || {};
    log('warn', 'live_relay_alert', { kind, ...fields });
    alertOps(`Field Live relay: ${kind}`, fields);
    res.json({ ok: true });
  });

  // ── the phone ─────────────────────────────────────────────────────────────

  r.post('/streams/:id/samples', requireStreamKey, (req, res) => {
    db.prepare('INSERT INTO cmd_live_samples (stream_id, at, payload) VALUES (?, ?, ?)')
      .run(req.liveStream.id, new Date().toISOString(), JSON.stringify(req.body || {}));
    res.status(202).json({ ok: true });
  });

  // Master upload: presigned parts straight to R2. At 22 GB a game these bytes
  // must not pass through this process.
  r.post('/streams/:id/masters', requireStreamKey, async (req, res, next) => {
    try {
      if (!storageReady) {
        throw httpError(503, `Media storage is not configured: ${missingStorageConfig.join(', ')}`);
      }
      const { filename, bytes, part_size, expected_fps } = req.body || {};
      const total = Number(bytes);
      if (!filename) throw httpError(400, 'filename is required');
      if (!Number.isFinite(total) || total <= 0) throw httpError(400, 'bytes must be a positive number');
      const partSize = Number(part_size) > 0 ? Number(part_size) : MASTER_PART_SIZE;

      // Idempotent on (stream, file, size): the phone may be retrying because the
      // response to its previous call was lost, and a duplicate master on a job
      // is worse than a redundant request.
      const existing = db.prepare(
        `SELECT * FROM cmd_live_masters
         WHERE stream_id = ? AND filename = ? AND bytes = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(req.liveStream.id, filename, total);

      if (existing?.status === 'complete') {
        return res.json({ ...describeMaster(db, existing, []), resumed: true, already_complete: true });
      }
      if (existing) {
        const parts = await listUploadedParts(existing.storage_key, existing.upload_id);
        return res.json({ ...describeMaster(db, existing, parts), resumed: true, already_complete: false });
      }

      const id = newId('mst');
      const storageKey = `live-masters/${req.liveStream.id}/${filename}`;
      const upload = await createUpload(storageKey);
      db.prepare(
        `INSERT INTO cmd_live_masters
           (id, stream_id, filename, bytes, part_size, parts_total, status, created_at,
            storage_key, upload_id, expected_fps)
         VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`
      ).run(id, req.liveStream.id, filename, total, partSize, Math.ceil(total / partSize),
            new Date().toISOString(), storageKey, upload.uploadId ?? null,
            Number(expected_fps) > 0 ? Number(expected_fps) : null);

      addEvent(db, req.liveStream.id, 'master_upload_started', { filename, bytes: total }, 'api');
      res.status(201).json({ ...describeMaster(db, getMaster(db, id), []), resumed: false, already_complete: false });
    } catch (err) { next(err); }
  });

  r.post('/masters/:masterId/parts/:part/presign', requireMasterKey(db), async (req, res, next) => {
    try {
      const master = req.liveMaster;
      const n = Number(req.params.part);
      if (!Number.isInteger(n) || n < 1 || n > master.parts_total) {
        throw httpError(400, `part must be between 1 and ${master.parts_total}`);
      }
      if (storageMode === 'local') return res.json({ mode: 'local' });
      res.json({ mode: 'r2', url: await presignPart(master.storage_key, master.upload_id, n) });
    } catch (err) { next(err); }
  });

  // Local-dev only: no R2 to presign against, so relay the bytes.
  r.put('/masters/:masterId/parts/:part', requireMasterKey(db),
    express.raw({ type: '*/*', limit: '64mb' }),
    (req, res) => {
      if (storageMode !== 'local') {
        throw httpError(400, 'Direct part upload is local-dev only; use presigned parts');
      }
      appendLocalPart(req.liveMaster.storage_key, req.body);
      res.json({ ok: true });
    });

  r.post('/masters/:masterId/complete', requireMasterKey(db), async (req, res, next) => {
    try {
      const master = req.liveMaster;
      if (master.status === 'complete') return res.json(describeMaster(db, master, []));
      await completeUpload(master.storage_key, master.upload_id, req.body?.parts || []);
      db.prepare('UPDATE cmd_live_masters SET status = ?, completed_at = ? WHERE id = ?')
        .run('complete', new Date().toISOString(), master.id);
      addEvent(db, master.stream_id, 'master_upload_complete',
        { filename: master.filename, bytes: master.bytes }, 'api');
      log('info', 'live_master_uploaded',
        { stream_id: master.stream_id, master_id: master.id, bytes: master.bytes });
      res.json(describeMaster(db, getMaster(db, master.id), []));
    } catch (err) { next(err); }
  });

  app.use('/api/live', r);
  log('info', 'live_routes_mounted', { playback_access: PLAYBACK_ACCESS, storage: storageMode });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The phone proves ownership of a master through its stream's key. */
function requireMasterKey(db) {
  return (req, res, next) => {
    const master = getMaster(db, req.params.masterId);
    if (!master) return res.status(404).json({ error: 'master upload not found' });
    const stream = getStream(db, master.stream_id);
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!stream || supplied !== stream.stream_key) {
      return res.status(401).json({ error: 'stream key required' });
    }
    req.liveMaster = master;
    next();
  };
}

const getMaster = (db, id) =>
  db.prepare('SELECT * FROM cmd_live_masters WHERE id = ?').get(id) || null;

const listMasters = (db, streamId) =>
  db.prepare('SELECT * FROM cmd_live_masters WHERE stream_id = ? ORDER BY created_at DESC')
    .all(streamId).map((row) => describeMaster(db, row, []));

function describeMaster(db, row, uploadedParts) {
  return {
    id: row.id,
    stream_id: row.stream_id,
    filename: row.filename,
    bytes: row.bytes,
    part_size: row.part_size,
    parts_total: row.parts_total,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    expected_fps: row.expected_fps,
    uploaded_parts: uploadedParts.map((p) => p.partNumber),
    upload_id: row.upload_id,
  };
}
