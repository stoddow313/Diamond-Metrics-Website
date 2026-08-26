// Command media routes (M2): feed registration, resumable multipart upload
// (R2 presigned parts in prod, API-relayed parts in local dev), completion →
// probe/proxy pipeline, playback URLs, and role-gated local media streaming.
import { ENV, log } from './observability.js';
import express from 'express';
import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { createUpload, presignPart, appendLocalPart, completeUpload, abortUpload, listUploadedParts, playbackUrl, localPathFor, storageMode, storageReady, missingStorageConfig } from './storage.js';

// Local-mode playback: <video> cannot send auth headers, so local URLs carry
// a short-TTL HMAC token — the same trust model as R2 presigned GETs.
const MEDIA_SECRET = process.env.DM_MEDIA_SECRET || randomBytes(32).toString('hex');
const MEDIA_TTL_S = 900;

function signMediaKey(key, exp) {
  return createHmac('sha256', MEDIA_SECRET).update(`${key}:${exp}`).digest('hex');
}

async function signedPlaybackUrl(key) {
  if (storageMode !== 'local') return playbackUrl(key);   // R2 presigned GET
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  return `/api/command/media/${encodeURIComponent(key)}?exp=${exp}&sig=${signMediaKey(key, exp)}`;
}

export const PART_SIZE = 50 * 1024 * 1024;   // 50 MB parts

export function mountCommandMediaRoutes(app, { db, requireInternal }) {
  const audit = (jobId, actorId, action, note) =>
    db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, ?, ?)")
      .run(jobId, actorId, action, note);

  // Register a feed + open an upload session. Idempotent: same job +
  // content hash + size returns the existing feed instead of duplicating.
  app.post('/api/command/jobs/:id/feeds', requireInternal, async (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    if (!b.original_name) return res.status(400).json({ error: 'original_name is required' });
    // Mirror of the client-side media policy (src/lib/mediaPolicy.js).
    const MAX_UPLOAD_BYTES = 128 * 1024 ** 3;
    if (b.size_bytes && b.size_bytes > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: `File is ${(b.size_bytes / 1024 ** 3).toFixed(1)} GB — above the 128 GB limit. Split the recording or re-encode before uploading.` });
    }

    // Guard: in production the local backend writes to the same small disk as
    // the database. One real game file would fill it and take the public API
    // down with it, so refuse the upload instead of failing catastrophically.
    if (!storageReady) {
      return res.status(503).json({ error: `Media storage is misconfigured — missing ${missingStorageConfig.join(', ')}. Set these in the Render dashboard and restart.` });
    }
    if (storageMode !== 'r2' && ENV === 'production') {
      return res.status(503).json({
        error: 'Media storage is not configured. Set DM_STORAGE=r2 and the R2_* variables before uploading footage — the local backend shares the database disk and would fill it.',
      });
    }

    // Content-hash dedupe, but only against a feed that actually made it.
    // A feed still in 'uploading' (or one that failed) is the remains of an
    // interrupted transfer — a dropped connection partway through a 2-hour
    // game file. Treating that as a duplicate would hand back a broken feed
    // and refuse the re-upload forever, so those get a fresh upload session
    // against the same row instead.
    const RESUMABLE = ['uploading', 'failed'];
    let reuseFeedId = null;
    if (b.content_hash && b.size_bytes) {
      const existing = db.prepare(
        'SELECT * FROM cmd_video_feeds WHERE job_id = ? AND content_hash = ? AND size_bytes = ?'
      ).get(job.id, b.content_hash, b.size_bytes);
      if (existing && !RESUMABLE.includes(existing.status)) {
        return res.json({ feed: existing, upload: null, duplicate: true });
      }
      if (existing) reuseFeedId = existing.id;
    }

    let feedId;
    if (reuseFeedId) {
      const prior = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(reuseFeedId);
      // A live multipart session can resume where it stopped: hand back the
      // same uploadId plus the parts R2 already holds, so the client skips
      // them instead of re-sending a half-finished 10 GB transfer.
      if (prior.upload_id && storageMode === 'r2') {
        try {
          const uploaded = await listUploadedParts(prior.storage_key, prior.upload_id);
          db.prepare("UPDATE cmd_video_feeds SET status = 'uploading', error = '', updated_at = datetime('now') WHERE id = ?").run(reuseFeedId);
          log('info', 'upload_resumed', { feed_id: reuseFeedId, job_id: job.id, name: prior.original_name, size: prior.size_bytes, parts_done: uploaded.length });
          return res.status(201).json({
            feed: db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(reuseFeedId),
            upload: { mode: 'r2', uploadId: prior.upload_id, part_size: PART_SIZE, uploaded_parts: uploaded },
            resumed: true,
          });
        } catch {
          // Session expired or aborted on R2's side — fall through to a fresh one.
        }
      }
      db.prepare("UPDATE cmd_video_feeds SET status = 'uploading', error = '', updated_at = datetime('now') WHERE id = ?").run(reuseFeedId);
      feedId = reuseFeedId;
    } else {
      feedId = db.prepare(
        `INSERT INTO cmd_video_feeds (job_id, label, capture_profile_key, storage_key, original_name, size_bytes, content_hash, recording_notes, created_by)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`
      ).run(job.id, String(b.label || 'Behind Home'), String(b.capture_profile_key || ''), String(b.original_name),
        b.size_bytes ?? null, String(b.content_hash || ''), String(b.recording_notes || ''), req.internal.id).lastInsertRowid;
    }
    const ext = (String(b.original_name).match(/\.[A-Za-z0-9]+$/) || ['.mp4'])[0].toLowerCase();
    const storageKey = `originals/${feedId}/source${ext}`;
    db.prepare('UPDATE cmd_video_feeds SET storage_key = ? WHERE id = ?').run(storageKey, feedId);

    try {
      const session = await createUpload(storageKey);
      db.prepare('UPDATE cmd_video_feeds SET upload_id = ? WHERE id = ?').run(session.uploadId || null, feedId);
      audit(job.id, req.internal.id, 'feed_registered', `${b.label || 'Behind Home'} — ${b.original_name}`);
      log('info', 'upload_started', { feed_id: feedId, job_id: job.id, name: String(b.original_name), size: b.size_bytes ?? null, parts: b.size_bytes ? Math.ceil(b.size_bytes / PART_SIZE) : null });
      res.status(201).json({
        feed: db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(feedId),
        upload: { mode: session.mode, uploadId: session.uploadId || null, part_size: PART_SIZE },
      });
    } catch (err) {
      db.prepare('DELETE FROM cmd_video_feeds WHERE id = ?').run(feedId);
      log('error', 'upload_session_failed', { job_id: job.id, name: String(b.original_name), message: String(err.message) });
      res.status(500).json({ error: `Upload session failed: ${err.message}` });
    }
  });

  // R2 mode: presigned URL per part (browser PUTs directly to R2).
  app.post('/api/command/feeds/:id/parts/presign', requireInternal, async (req, res) => {
    const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    const { uploadId, partNumber } = req.body || {};
    if (!uploadId || !partNumber) return res.status(400).json({ error: 'uploadId and partNumber are required' });
    try {
      res.json({ url: await presignPart(feed.storage_key, uploadId, Number(partNumber)) });
    } catch (err) {
      res.status(500).json({ error: `Presign failed: ${err.message}` });
    }
  });

  // Local mode: parts stream through the API onto disk (dev only).
  app.post('/api/command/feeds/:id/parts/:partNumber', requireInternal,
    express.raw({ type: '*/*', limit: '64mb' }),
    (req, res) => {
      const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(req.params.id);
      if (!feed) return res.status(404).json({ error: 'Feed not found' });
      if (storageMode !== 'local') return res.status(400).json({ error: 'Direct part upload is local-dev only; use presigned parts' });
      appendLocalPart(feed.storage_key, req.body);
      res.json({ ok: true, received: req.body.length });
    });

  app.post('/api/command/feeds/:id/complete', requireInternal, async (req, res) => {
    const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    try {
      await completeUpload(feed.storage_key, req.body?.uploadId, req.body?.parts || []);
      db.prepare("UPDATE cmd_video_feeds SET status='queued', upload_id=NULL, updated_at=datetime('now') WHERE id=?").run(feed.id);
      log('info', 'upload_completed', { feed_id: feed.id, job_id: feed.job_id, name: feed.original_name, size: feed.size_bytes, parts: (req.body?.parts || []).length });
      db.prepare("INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'probe')").run(feed.id);
      audit(feed.job_id, req.internal.id, 'feed_uploaded', feed.original_name);
      res.json({ feed: db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(feed.id) });
    } catch (err) {
      res.status(500).json({ error: `Upload completion failed: ${err.message}` });
    }
  });

  // Abort is now an explicit user cancel only — transient failures keep the
  // feed row and the R2 session so the transfer can resume (see register).
  app.post('/api/command/feeds/:id/abort', requireInternal, async (req, res) => {
    const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    await abortUpload(feed.storage_key, req.body?.uploadId || feed.upload_id);
    db.prepare("DELETE FROM cmd_video_feeds WHERE id = ? AND status = 'uploading'").run(feed.id);
    log('info', 'upload_aborted', { feed_id: feed.id, job_id: feed.job_id, name: feed.original_name, reason: String(req.body?.reason || 'client_abort') });
    res.json({ ok: true });
  });

  // Safe retry for failed processing — no duplicate feed records (§2.2).
  app.post('/api/command/feeds/:id/retry', requireInternal, (req, res) => {
    const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!['failed', 'retrying'].includes(feed.status)) return res.status(400).json({ error: `Feed is ${feed.status}; nothing to retry` });
    // A human clicking Retry means "try again for real" — reset the counter,
    // or jobs whose attempts burned out under a since-fixed defect go
    // straight back to terminal failure on the next orphan sweep.
    db.prepare("UPDATE cmd_media_jobs SET status='queued', error='', attempts=0 WHERE feed_id=? AND status='failed'").run(feed.id);
    db.prepare("INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'probe')").run(feed.id);
    db.prepare("UPDATE cmd_video_feeds SET status='queued', error='', updated_at=datetime('now') WHERE id=?").run(feed.id);
    res.json({ feed: db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(feed.id) });
  });

  // Feed detail: metadata + renditions + short-TTL playback URLs.
  app.get('/api/command/feeds/:id', requireInternal, async (req, res) => {
    const feed = db.prepare(
      `SELECT f.*, j.team_id, t.name AS team_name, j.game_date
       FROM cmd_video_feeds f JOIN cmd_jobs j ON j.id = f.job_id JOIN teams t ON t.id = j.team_id
       WHERE f.id = ?`
    ).get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    // Newest first: callers take the first 'proxy' they find, which must be
    // the current one after a re-encode.
    const renditions = db.prepare('SELECT * FROM cmd_media_renditions WHERE feed_id = ? ORDER BY id DESC').all(feed.id);
    const withUrls = await Promise.all(renditions.map(async r => ({ ...r, url: await signedPlaybackUrl(r.storage_key) })));
    const jobs = db.prepare('SELECT kind, status, attempts, error FROM cmd_media_jobs WHERE feed_id = ? ORDER BY id').all(feed.id);
    res.json({ feed, renditions: withUrls, media_jobs: jobs });
  });

  app.get('/api/command/jobs/:id/feeds', requireInternal, (req, res) => {
    res.json({
      feeds: db.prepare('SELECT * FROM cmd_video_feeds WHERE job_id = ? ORDER BY id').all(req.params.id),
    });
  });

  // Local-dev media streaming with Range support, role-gated.
  app.get('/api/command/media/*key', (req, res) => {
    if (storageMode !== 'local') return res.status(404).json({ error: 'Local media serving is disabled in R2 mode' });
    // Express 5 named wildcard: segments arrive as an array.
    const key = decodeURIComponent(Array.isArray(req.params.key) ? req.params.key.join('/') : String(req.params.key || ''));
    // Auth: short-TTL signed URL (video elements) or an internal bearer session.
    const { exp, sig } = req.query;
    const signed = exp && sig && Number(exp) > Date.now() / 1000 && sig === signMediaKey(key, exp);
    if (!signed) {
      return requireInternal(req, res, () => streamMedia(req, res, key));
    }
    return streamMedia(req, res, key);
  });

  function streamMedia(req, res, key) {
    const filePath = localPathFor(key);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Media not found' });
    res.sendFile(filePath, { acceptRanges: true });
  }
}
