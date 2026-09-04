// Field Live control plane (logic).
//
// The relay carries video; this carries decisions. Kept free of Express so it can
// be unit-tested, and free of storage so the same code runs against R2 or the
// local-dev fallback.
//
// The one rule that shapes everything here: the relay holds no credentials. It
// asks us about every publisher and every viewer, so a stream key never leaves
// the database it was issued from.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VIEWER_TTL_SECONDS = 300;
export const MASTER_PART_SIZE = 8 * 1024 * 1024;

const SECRET = () => process.env.DM_LIVE_SECRET || process.env.DM_MEDIA_SECRET || 'dev-live-secret';

// ── identifiers and keys ────────────────────────────────────────────────────

export function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function newStreamKey() {
  return randomBytes(24).toString('base64url');
}

export function slugifyPath(input, fallback) {
  const base = String(input || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || fallback;
}

export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;   // timingSafeEqual throws on mismatch
  return timingSafeEqual(ab, bb);
}

// ── viewer tokens ───────────────────────────────────────────────────────────
// Short-lived grants so a playlist can be handed to a browser without a session.
// Segments stay unsigned and cacheable: that is the documented trade-off, and it
// is what keeps origin bandwidth flat as viewers multiply.

function sign(payload) {
  return createHmac('sha256', SECRET()).update(payload).digest('base64url');
}

export function mintViewerToken(streamId, ttlSeconds = VIEWER_TTL_SECONDS, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${streamId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyViewerToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [streamId, expRaw, mac] = parts;
  if (!constantTimeEqual(mac, sign(`${streamId}.${expRaw}`))) return { ok: false, reason: 'bad_signature' };
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, streamId, exp };
}

/** The relay proves it is the relay with a shared secret, not a network position. */
export function relayTokenValid(supplied) {
  const expected = process.env.DM_RELAY_TOKEN;
  if (!expected) return false;              // fail closed when unconfigured
  return constantTimeEqual(supplied ?? '', expected);
}

// ── relay addressing ────────────────────────────────────────────────────────

export function relayConfig(env = process.env) {
  return {
    host: env.DM_RELAY_HOST || 'localhost',
    srtPort: Number(env.DM_RELAY_SRT_PORT || 8890),
    rtmpPort: Number(env.DM_RELAY_RTMP_PORT || 1935),
    playbackBase: env.DM_PLAYBACK_BASE || 'http://localhost:8888',
  };
}

/** Ingest and playback URLs are derived from config, never stored. */
export function withUrls(stream, env = process.env) {
  const r = relayConfig(env);
  const key = stream.stream_key;
  return {
    ...stream,
    urls: {
      // MediaMTX SRT streamid grammar: publish:<path>:<user>:<pass>
      srt: `srt://${r.host}:${r.srtPort}?streamid=publish:${stream.path}:publish:${key}&pkt_size=1316`,
      rtmp: `rtmp://${r.host}:${r.rtmpPort}/${stream.path}?user=publish&pass=${encodeURIComponent(key)}`,
      hls: `${r.playbackBase}/${stream.path}/index.m3u8`,
    },
  };
}

export function playbackUrl(stream, env = process.env, ttl) {
  const r = relayConfig(env);
  const token = mintViewerToken(stream.id, ttl);
  return { url: `${r.playbackBase}/${stream.path}/index.m3u8?token=${token}`, token, expires_in: ttl ?? VIEWER_TTL_SECONDS };
}

// ── streams ─────────────────────────────────────────────────────────────────

export function createStream(db, { job_id, label, consent = 'team' }, env = process.env) {
  if (!job_id) throw httpError(400, 'job_id is required');
  if (!['team', 'private'].includes(consent)) throw httpError(400, 'consent must be team or private');

  const id = newId('ls');
  const stream = {
    id,
    job_id: String(job_id),
    label: label ? String(label) : null,
    // Readable in relay logs and recording keys; the suffix makes it unique
    // without a retry loop.
    path: `live/${slugifyPath(label || job_id, 'game')}-${id.slice(-6)}`,
    stream_key: newStreamKey(),
    status: 'created',
    consent,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    recording_prefix: null,
  };

  db.prepare(
    `INSERT INTO cmd_live_streams (id, job_id, label, path, stream_key, status, consent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(stream.id, stream.job_id, stream.label, stream.path, stream.stream_key,
        stream.status, stream.consent, stream.created_at);

  addEvent(db, stream.id, 'created', { job_id: stream.job_id }, 'api');
  return withUrls(stream, env);
}

export const getStream = (db, id) =>
  db.prepare('SELECT * FROM cmd_live_streams WHERE id = ?').get(id) || null;

export const getStreamByPath = (db, path) =>
  db.prepare('SELECT * FROM cmd_live_streams WHERE path = ?').get(path) || null;

export const listStreams = (db, { jobId } = {}) => jobId
  ? db.prepare('SELECT * FROM cmd_live_streams WHERE job_id = ? ORDER BY created_at DESC').all(jobId)
  : db.prepare('SELECT * FROM cmd_live_streams ORDER BY created_at DESC LIMIT 200').all();

export function endStream(db, id) {
  const stream = getStream(db, id);
  if (!stream) throw httpError(404, 'stream not found');
  if (stream.status === 'ended') return stream;
  db.prepare('UPDATE cmd_live_streams SET status = ?, ended_at = ? WHERE id = ?')
    .run('ended', new Date().toISOString(), id);
  addEvent(db, id, 'ended', {}, 'api');
  return getStream(db, id);
}

// ── the relay's auth hook ───────────────────────────────────────────────────

/** One MediaMTX auth decision. 2xx allows, anything else denies. */
export function authorize(db, req, now = Date.now()) {
  const action = req.action;
  if (action !== 'publish' && action !== 'read') {
    // The relay's own API and metrics stay on loopback and are not delegated.
    return { allow: false, reason: `action ${action} not delegated` };
  }

  const stream = getStreamByPath(db, String(req.path || ''));
  if (!stream) return { allow: false, reason: 'unknown path' };
  if (stream.status === 'ended') return { allow: false, reason: 'stream ended', stream };

  if (action === 'publish') {
    const supplied = req.password || req.token || '';
    return constantTimeEqual(supplied, stream.stream_key)
      ? { allow: true, stream }
      : { allow: false, reason: 'bad stream key', stream };
  }

  const token = req.token || query(req.query).get('token') || '';
  const verdict = verifyViewerToken(token, now);
  if (!verdict.ok) return { allow: false, reason: `viewer token ${verdict.reason}`, stream };
  if (verdict.streamId !== stream.id) return { allow: false, reason: 'token is for another stream', stream };
  return { allow: true, stream };
}

function query(raw) {
  try { return new URLSearchParams(String(raw || '')); } catch { return new URLSearchParams(); }
}

// ── events ──────────────────────────────────────────────────────────────────

export function addEvent(db, streamId, kind, detail = {}, source = 'relay', at = new Date().toISOString()) {
  db.prepare('INSERT INTO cmd_live_events (stream_id, kind, at, detail, source) VALUES (?, ?, ?, ?, ?)')
    .run(streamId, kind, at, JSON.stringify(detail ?? {}), source);
}

export const listEvents = (db, streamId) =>
  db.prepare('SELECT * FROM cmd_live_events WHERE stream_id = ? ORDER BY id').all(streamId)
    .map((row) => ({ ...row, detail: safeParse(row.detail) }));

/** runOnAvailable / runOnUnavailable land here, keyed by path — all the relay knows. */
export function recordRelayState(db, path, state, detail = {}) {
  const stream = getStreamByPath(db, path);
  if (!stream) throw httpError(404, `no stream for path ${path}`);
  if (state !== 'live' && state !== 'offline') throw httpError(400, 'state must be live or offline');

  const at = new Date().toISOString();
  addEvent(db, stream.id, state, detail, 'relay', at);

  if (state === 'live') {
    // started_at is the first time it ever went live and survives reconnects,
    // or every drop would restart the session clock and flatter availability.
    if (!stream.started_at) {
      db.prepare('UPDATE cmd_live_streams SET status = ?, started_at = ? WHERE id = ?').run('live', at, stream.id);
    } else {
      db.prepare('UPDATE cmd_live_streams SET status = ? WHERE id = ?').run('live', stream.id);
    }
  } else if (stream.status !== 'ended') {
    db.prepare('UPDATE cmd_live_streams SET status = ? WHERE id = ?').run('offline', stream.id);
  }
  return getStream(db, stream.id);
}

// ── availability, computed from the relay's own timestamps ──────────────────

/**
 * Availability and reconnect times. This is evidence, not bookkeeping: it is what
 * the acceptance table is scored from, and the relay's clock is the only honest
 * source for it — the phone cannot know when it stopped being received.
 */
export function sessionReport(db, streamId, now = Date.now()) {
  const stream = getStream(db, streamId);
  if (!stream) throw httpError(404, 'stream not found');
  const events = listEvents(db, streamId).filter((e) => e.kind === 'live' || e.kind === 'offline');

  const endedAt = stream.ended_at ? Date.parse(stream.ended_at) : now;
  const startedAt = stream.started_at ? Date.parse(stream.started_at) : null;

  let liveMs = 0;
  let openedAt = null;
  let lastOfflineAt = null;
  const outages = [];

  for (const e of events) {
    const t = Date.parse(e.at);
    if (e.kind === 'live') {
      if (lastOfflineAt !== null) {
        outages.push({ from: new Date(lastOfflineAt).toISOString(), to: e.at, seconds: (t - lastOfflineAt) / 1000 });
        lastOfflineAt = null;
      }
      if (openedAt === null) openedAt = t;
    } else if (openedAt !== null) {
      liveMs += t - openedAt;
      openedAt = null;
      lastOfflineAt = t;
    }
  }
  if (openedAt !== null) liveMs += endedAt - openedAt;   // still publishing

  const sessionMs = startedAt === null ? 0 : Math.max(0, endedAt - startedAt);
  const reconnects = outages.map((o) => o.seconds);

  return {
    stream_id: streamId,
    status: stream.status,
    started_at: stream.started_at,
    ended_at: stream.ended_at,
    session_seconds: sessionMs / 1000,
    live_seconds: liveMs / 1000,
    availability: sessionMs > 0 ? liveMs / sessionMs : null,
    outages,
    reconnect_count: reconnects.length,
    worst_reconnect_seconds: reconnects.length ? Math.max(...reconnects) : null,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return {}; }
}
