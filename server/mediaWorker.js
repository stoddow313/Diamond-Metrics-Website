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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fetchToScratch, putObject, localPathFor, storageMode } from './storage.js';
import { emitJobEvent } from './notifications.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';

const parseRate = s => {
  if (!s || s === '0/0') return null;
  const [num, den] = String(s).split('/').map(Number);
  return den ? num / den : Number(num) || null;
};

export async function probeFile(filePath) {
  const { stdout } = await run(FFPROBE, [
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
  const scratch = path.join(os.tmpdir(), `dm-probe-${feed.id}${path.extname(feed.storage_key) || '.mp4'}`);
  const src = await fetchToScratch(feed.storage_key, scratch);
  const meta = await probeFile(src);
  db.prepare(
    `UPDATE cmd_video_feeds SET duration_s=?, codec=?, width=?, height=?, rotation=?, nominal_fps=?, effective_fps=?, vfr=?,
     status='processing', updated_at=datetime('now') WHERE id=?`
  ).run(meta.duration_s, meta.codec, meta.width, meta.height, meta.rotation, meta.nominal_fps, meta.effective_fps, meta.vfr, feed.id);
  if (src !== localPathFor(feed.storage_key)) fs.rmSync(scratch, { force: true });
  // Chain the proxy job.
  db.prepare("INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'proxy')").run(feed.id);
}

function proxyProbeDuration(feed) {
  return Number(feed.duration_s) > 0 ? Number(feed.duration_s) : 0;
}

async function handleProxy(db, job, feed) {
  const scratchIn = path.join(os.tmpdir(), `dm-in-${feed.id}${path.extname(feed.storage_key) || '.mp4'}`);
  const src = await fetchToScratch(feed.storage_key, scratchIn);
  const targetFps = Math.round(feed.effective_fps || feed.nominal_fps || 30);
  const outPath = path.join(os.tmpdir(), `dm-proxy-${feed.id}.mp4`);
  const thumbPath = path.join(os.tmpdir(), `dm-thumb-${feed.id}.jpg`);

  // CFR proxy: normalizes VFR originals so frame math is defensible; the
  // measured rendition's FPS is what measurements record (TDR §2).
  await run(FFMPEG, [
    '-y', '-i', src,
    '-vf', "scale=-2:'min(720,ih)'", '-r', String(targetFps), '-vsync', 'cfr',
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
  if (src !== localPathFor(feed.storage_key)) fs.rmSync(scratchIn, { force: true });
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
    const retryable = job.attempts < 3;
    // A retried job goes back to 'queued' and re-stamps started_at when it
    // is next claimed; only a terminal failure closes the timing window.
    db.prepare(`UPDATE cmd_media_jobs SET status=?, error=?, ${retryable ? '' : "finished_at=datetime('now'),"} updated_at=datetime('now') WHERE id=?`)
      .run(retryable ? 'queued' : 'failed', String(err.message).slice(0, 500), job.id);
    captureError(err, { event: 'media_job_failed', component: 'media_worker', job_id: job.id, kind: job.kind, attempt: job.attempts + 1, retryable });
    if (feed) {
      db.prepare("UPDATE cmd_video_feeds SET status=?, error=?, updated_at=datetime('now') WHERE id=?")
        .run(retryable ? 'retrying' : 'failed', String(err.message).slice(0, 500), feed.id);
    }
  }
  return true;
}

export function startInlineWorker(db, { intervalMs = 3000 } = {}) {
  const tick = async () => {
    try { while (await processNextMediaJob(db)) { /* drain */ } }
    catch (err) { captureError(err, { event: 'media_worker_tick_failed', component: 'media_worker' }); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log('info', 'media_worker_started', { interval_ms: intervalMs, storage: storageMode });
  return timer;
}
