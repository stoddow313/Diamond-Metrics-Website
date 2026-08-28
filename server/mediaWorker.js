// Media worker: polls cmd_media_jobs and runs ffprobe/ffmpeg. Runs inline in
// dev (DM_INLINE_WORKER=1, default outside production) and as a dedicated
// Render background worker in prod (node server/worker.js).
//
// probe  → technical inspection: duration, codec, dimensions, rotation,
//          nominal + effective FPS, VFR flag (roadmap §2.2). Frame-timed
//          metrics stay blocked until a CFR proxy exists.
// proxy  → 720p H.264 constant-frame-rate faststart proxy + thumbnail strip.
// clip   → evidence clip from a rendition with pre/post-roll (used from M4).
import { log, captureError } from './observability.js';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { putObject, storageMode } from './storage.js';
import { gatewayUrlFor } from './mediaGateway.js';
import { emitJobEvent } from './notifications.js';

const run = promisify(execFile);

// Binary resolution, in order: an explicit env override, the static binaries
// installed as dependencies (this is what production uses — Render's Node
// runtime has no system ffmpeg), then whatever is on PATH. The bundled
// packages ship a per-platform binary as an optional dependency, so `npm ci`
// installs the right one with no download step at build time.
function resolveBinary(envVar, installerPkg, fallback) {
  // The bundled binary wins unless the override points at a file that really
  // exists. A stale `FFMPEG_PATH=ffmpeg` (a bare PATH lookup) would otherwise
  // shadow a working bundled binary with one Render does not have.
  const override = process.env[envVar];
  if (override && path.isAbsolute(override) && fs.existsSync(override)) return override;
  try {
    const { path: binPath } = createRequire(import.meta.url)(installerPkg);
    // Some environments skip install scripts, which is where the +x comes
    // from; restore it rather than failing on the first job.
    try { fs.accessSync(binPath, fs.constants.X_OK); } catch { fs.chmodSync(binPath, 0o755); }
    return binPath;
  } catch {
    return override || fallback;   // last resort: whatever is on PATH
  }
}

// Review-proxy ceiling. 1080p keeps cleat/base detail legible for picking
// the exact contact frame — 720p smeared it on wide drone shots. Sources
// below this are never upscaled.
export const PROXY_MAX_HEIGHT = Number(process.env.DM_PROXY_MAX_HEIGHT || 1080);

// Memory available to this process, in MB. Inside a container Node reports
// the cgroup limit (0 when unconstrained), so upgrading the Render instance
// lifts the transcode ceiling automatically — no env var to remember and no
// silent 4K refusal on a box that can handle it. The override exists for
// pinning behaviour in tests or forcing a lower ceiling deliberately.
export function availableMemoryMb() {
  const override = Number(process.env.DM_TRANSCODE_MEMORY_MB);
  if (Number.isFinite(override) && override > 0) return override;
  const constrained = process.constrainedMemory?.() || 0;
  return Math.floor((constrained > 0 ? constrained : os.totalmem()) / 1024 / 1024);
}

export const FFMPEG = resolveBinary('FFMPEG_PATH', '@ffmpeg-installer/ffmpeg', 'ffmpeg');
export const FFPROBE = resolveBinary('FFPROBE_PATH', '@ffprobe-installer/ffprobe', 'ffprobe');

// Reported on /command/ops so the pipeline can be verified without uploading.
export async function ffmpegStatus() {
  const probeOne = async (label, bin) => {
    try {
      const { stdout } = await run(bin, ['-version'], { maxBuffer: 1024 * 1024 });
      return { ok: true, path: bin, version: stdout.split('\n')[0].replace(/ Copyright.*$/, '') };
    } catch (err) {
      return { ok: false, path: bin, error: String(err?.message || err).split('\n')[0] };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probeOne('ffmpeg', FFMPEG), probeOne('ffprobe', FFPROBE)]);
  return { ok: ffmpeg.ok && ffprobe.ok, ffmpeg, ffprobe };
}

const parseRate = s => {
  if (!s || s === '0/0') return null;
  const [num, den] = String(s).split('/').map(Number);
  return den ? num / den : Number(num) || null;
};

export async function probeFile(filePath) {
  const { stdout } = await run(FFPROBE, [
    '-probesize', '10M', '-analyzeduration', '10M',
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,side_data_list:format=duration',
    '-of', 'json', filePath,
  ]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] || {};
  const duration = Number(stream.duration) || Number(info.format?.duration) || null;
  const nominal = parseRate(stream.r_frame_rate);
  let effective = parseRate(stream.avg_frame_rate);
  if (!effective && stream.nb_frames && duration) effective = Number(stream.nb_frames) / duration;
  const rotation = (stream.side_data_list || []).find(d => d.rotation != null)?.rotation || 0;
  // VFR heuristic: nominal vs average drift beyond 1% flags variable frame rate.
  const vfr = nominal && effective ? Math.abs(nominal - effective) / nominal > 0.01 : false;
  return {
    duration_s: duration, codec: stream.codec_name || '',
    width: stream.width || null, height: stream.height || null,
    rotation: Math.abs(Number(rotation) || 0),
    nominal_fps: nominal, effective_fps: effective, vfr: vfr ? 1 : 0,
  };
}

async function handleProbe(db, job, feed) {
  // Stream through the localhost gateway — downloading a full-game original
  // to the instance is what OOM-killed production, and static ffmpeg builds
  // can't be trusted with https (the linux one fails on R2 URLs outright).
  const src = await gatewayUrlFor(feed.storage_key);
  const meta = await probeFile(src);
  db.prepare(
    `UPDATE cmd_video_feeds SET duration_s=?, codec=?, width=?, height=?, rotation=?, nominal_fps=?, effective_fps=?, vfr=?,
     status='processing', updated_at=datetime('now') WHERE id=?`
  ).run(meta.duration_s, meta.codec, meta.width, meta.height, meta.rotation, meta.nominal_fps, meta.effective_fps, meta.vfr, feed.id);
  // Chain the proxy job.
  db.prepare("INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'proxy')").run(feed.id);
}

function proxyProbeDuration(feed) {
  return Number(feed.duration_s) > 0 ? Number(feed.duration_s) : 0;
}

async function handleProxy(db, job, feed) {
  // Capability guard: decoding 4K needs more RAM than a small instance has —
  // the decoder's reference buffers alone OOM-killed a 512 MB container
  // twice, taking the public API down with it. Refuse with an actionable
  // error instead of crashing.
  if ((feed.width || 0) * (feed.height || 0) > 1920 * 1088 && availableMemoryMb() < 2048) {
    throw Object.assign(
      new Error(`source is ${feed.width}x${feed.height} ${String(feed.codec || '').toUpperCase()} — transcoding above 1080p needs a >=2 GB instance (this one has ${availableMemoryMb()} MB). Upgrade the instance, or upload a <=1080p export of this footage.`),
      { permanent: true },
    );
  }
  const src = await gatewayUrlFor(feed.storage_key);
  // Frame rate: preserve the source's real rate. A 120 fps camera exists to
  // resolve 8 ms instead of 17 ms, and halving it threw away exactly the
  // precision the customer paid for. DM_PROXY_MAX_FPS re-imposes a ceiling
  // (by exact halving, so the frame mapping stays integral) when a long
  // full-game encode at native rate is not worth the wall-clock.
  let targetFps = feed.effective_fps || feed.nominal_fps || 30;
  const fpsCeiling = Number(process.env.DM_PROXY_MAX_FPS || 0);
  if (fpsCeiling > 0) while (targetFps > fpsCeiling) targetFps = targetFps / 2;
  targetFps = Math.round(targetFps * 100) / 100;
  log('info', 'proxy_encode_started', {
    feed_id: feed.id, source: `${feed.width}x${feed.height}@${feed.effective_fps}`,
    target_fps: targetFps, target_height: Math.min(PROXY_MAX_HEIGHT, feed.height || PROXY_MAX_HEIGHT),
    duration_s: feed.duration_s,
  });
  const outPath = path.join(os.tmpdir(), `dm-proxy-${feed.id}.mp4`);
  const thumbPath = path.join(os.tmpdir(), `dm-thumb-${feed.id}.jpg`);

  // CFR proxy: normalizes VFR originals so frame math is defensible; the
  // measured rendition's FPS is what measurements record (TDR §2).
  await run(FFMPEG, [
    '-y', '-i', src,
    '-threads', '2',
    '-vf', `scale=-2:'min(${PROXY_MAX_HEIGHT},ih)'`, '-r', String(targetFps), '-vsync', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath,
  ], { maxBuffer: 64 * 1024 * 1024 });
  // Mid-clip poster thumbnail — robust for any duration (strip variant later).
  const mid = Math.max(0, (proxyProbeDuration(feed) / 2));
  await run(FFMPEG, ['-y', '-ss', String(mid), '-i', outPath, '-frames:v', '1', '-vf', 'scale=320:-2', thumbPath], { maxBuffer: 64 * 1024 * 1024 });

  const proxyMeta = await probeFile(outPath);
  const proxyKey = `renditions/${feed.id}/proxy.mp4`;
  const thumbKey = `renditions/${feed.id}/thumbs.jpg`;
  await putObject(proxyKey, outPath);
  await putObject(thumbKey, thumbPath);

  // Re-processing (a quality upgrade, a retry) must replace this feed's
  // renditions rather than stack a second 'proxy' row: consumers picked the
  // oldest, so a regenerated proxy would have been written and then ignored.
  // Renditions cited by an existing measurement are left in place — that
  // evidence link is the audit trail — and selection prefers the newest.
  db.prepare(
    `DELETE FROM cmd_media_renditions
      WHERE feed_id = ? AND id NOT IN (SELECT rendition_id FROM cmd_measurements WHERE rendition_id IS NOT NULL)`
  ).run(feed.id);
  const insRendition = db.prepare(
    'INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insRendition.run(feed.id, 'proxy', proxyKey, proxyMeta.effective_fps || targetFps, proxyMeta.width, proxyMeta.height, proxyMeta.duration_s);
  insRendition.run(feed.id, 'thumbnails', thumbKey, null, null, null, null);
  db.prepare("UPDATE cmd_video_feeds SET status='ready', error='', updated_at=datetime('now') WHERE id=?").run(feed.id);

  // First ready feed on a job → customer "footage received".
  const readyCount = db.prepare("SELECT COUNT(*) c FROM cmd_video_feeds WHERE job_id=? AND status='ready'").get(feed.job_id).c;
  if (readyCount === 1) emitJobEvent(db, { jobId: feed.job_id, eventKey: 'footage_received' });

  fs.rmSync(outPath, { force: true });
  fs.rmSync(thumbPath, { force: true });
}

// Clip generation is exercised from M4 when events exist; the queue kind is
// reserved so idempotency and retry semantics are already in place.
async function handleClip() { /* no-op until M4 */ }

export async function processNextMediaJob(db) {
  const job = db.prepare("SELECT * FROM cmd_media_jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
  if (!job) return false;
  const claimed = db.prepare(
    "UPDATE cmd_media_jobs SET status='running', attempts=attempts+1, started_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='queued'"
  ).run(job.id);
  if (claimed.changes === 0) return true;   // raced; try again next tick

  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(job.feed_id);
  try {
    if (!feed) throw new Error('feed missing');
    if (job.kind === 'probe') await handleProbe(db, job, feed);
    else if (job.kind === 'proxy') await handleProxy(db, job, feed);
    else if (job.kind === 'clip') await handleClip();
    else throw new Error(`unknown media job kind ${job.kind}`);
    db.prepare("UPDATE cmd_media_jobs SET status='done', error='', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(job.id);
  } catch (err) {
    const retryable = !err.permanent && job.attempts < 3;
    // Prefer the stderr TAIL: exec errors prefix the whole command line, and
    // a 500-char presigned URL used to crowd the real ffmpeg error out of
    // the stored message entirely.
    const detail = String(err.stderr || err.message || err).trim().slice(-500);
    // A retried job goes back to 'queued' and re-stamps started_at when it
    // is next claimed; only a terminal failure closes the timing window.
    db.prepare(`UPDATE cmd_media_jobs SET status=?, error=?, ${retryable ? '' : "finished_at=datetime('now'),"} updated_at=datetime('now') WHERE id=?`)
      .run(retryable ? 'queued' : 'failed', detail, job.id);
    captureError(err, { event: 'media_job_failed', component: 'media_worker', job_id: job.id, kind: job.kind, attempt: job.attempts + 1, retryable, detail });
    if (feed) {
      db.prepare("UPDATE cmd_video_feeds SET status=?, error=?, updated_at=datetime('now') WHERE id=?")
        .run(retryable ? 'retrying' : 'failed', detail, feed.id);
    }
  }
  return true;
}

// A media job claimed by an instance that crashed stays 'running' forever —
// nothing re-picks it and the feed shows 'processing' until doomsday. This
// process is the only worker, so anything 'running' at boot is an orphan.
// attempts was already counted at claim time: three crashes = terminal fail.
export function recoverOrphanedJobs(db) {
  const orphans = db.prepare("SELECT id, feed_id, kind, attempts FROM cmd_media_jobs WHERE status = 'running'").all();
  for (const o of orphans) {
    if (o.attempts >= 3) {
      db.prepare("UPDATE cmd_media_jobs SET status='failed', error='crashed the worker 3 times — likely resource exhaustion', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(o.id);
      db.prepare("UPDATE cmd_video_feeds SET status='failed', error='processing crashed repeatedly — see media job', updated_at=datetime('now') WHERE id=?").run(o.feed_id);
    } else {
      db.prepare("UPDATE cmd_media_jobs SET status='queued', updated_at=datetime('now') WHERE id=?").run(o.id);
    }
    log('warn', 'media_job_orphan_recovered', { job_id: o.id, feed_id: o.feed_id, kind: o.kind, attempts: o.attempts, terminal: o.attempts >= 3 });
  }
  return orphans.length;
}

export function startInlineWorker(db, { intervalMs = 3000 } = {}) {
  recoverOrphanedJobs(db);
  const tick = async () => {
    try { while (await processNextMediaJob(db)) { /* drain */ } }
    catch (err) { captureError(err, { event: 'media_worker_tick_failed', component: 'media_worker' }); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log('info', 'media_worker_started', { interval_ms: intervalMs, storage: storageMode });
  return timer;
}
