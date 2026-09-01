// Media worker: polls cmd_media_jobs and runs ffprobe/ffmpeg. Runs inline in
// dev (DM_INLINE_WORKER=1, default outside production) and as a dedicated
// Render background worker in prod (node server/worker.js).
//
// probe  → technical inspection: duration, codec, dimensions, rotation,
//          nominal + effective FPS, VFR flag (roadmap §2.2). Frame-timed
//          metrics stay blocked until a CFR proxy exists.
// proxy  → ≤1080p H.264 constant-frame-rate faststart proxy + thumbnail.
// clip   → evidence clip from a rendition with pre/post-roll (used from M4).
//
// Every job terminates. A feed sat in PROCESSING for days in production
// because one ffmpeg read against R2 never returned and nothing — not the
// encoder, not the gateway, not the queue — had a timeout or a watchdog.
// Now: ffmpeg reports progress over a pipe and is killed when it stops
// (stall watchdog); reads carry an I/O timeout; the queue sweeps jobs whose
// heartbeat has gone quiet; and a job that fails three times lands in a
// terminal 'failed' state carrying the specific reason, with a Retry that
// re-runs the pipeline against the stored original — never a re-upload.
import { log, captureError } from './observability.js';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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

// Liveness thresholds. STALL_MS is how long the encoder may go without
// reporting a single progress line before it is killed — generous enough
// for a slow 4K decode to produce its first frame, tight enough that an
// operator sees a clear failure within minutes instead of a spinner for
// days. Encode *speed* never trips it: a 14-hour full-game transcode still
// reports progress every half second. IO_TIMEOUT_S bounds one blocked read
// against the storage gateway.
export const STALL_MS = Number(process.env.DM_MEDIA_STALL_MS || 5 * 60 * 1000);
export const IO_TIMEOUT_S = Number(process.env.DM_MEDIA_IO_TIMEOUT_S || 30);
export const MAX_ATTEMPTS = 3;

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
      const { stdout } = await run(bin, ['-version'], { maxBuffer: 1024 * 1024, timeout: 15_000 });
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

// rw_timeout is a libavformat protocol option (microseconds): one read that
// blocks longer than this fails instead of hanging the process forever. It
// applies to http inputs (the gateway) and is inert for plain files.
const ioTimeoutArgs = () => ['-rw_timeout', String(Math.round(IO_TIMEOUT_S * 1_000_000))];

export async function probeFile(filePath, { timeoutMs = 120_000 } = {}) {
  const { stdout } = await run(FFPROBE, [
    ...ioTimeoutArgs(),
    '-probesize', '10M', '-analyzeduration', '10M',
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,side_data_list:format=duration',
    '-of', 'json', filePath,
  ], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
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

// ── Supervised ffmpeg ──────────────────────────────────────────────────────
// Child processes this process owns, keyed by media job id, so a stalled or
// retried job can be killed rather than abandoned.
const RUNNING = new Map();

// Runs ffmpeg with `-progress` on stdout and kills it if no progress line
// arrives for stallMs. Resolves with the stderr tail and last progress;
// rejects with err.code 'stalled' | 'cancelled' | 'exit' | 'spawn'.
export function runFfmpeg(args, { bin = FFMPEG, stallMs = STALL_MS, onProgress, label = 'ffmpeg', jobId = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(Object.assign(err, { code: 'spawn' }));
    }
    let stderrTail = '';
    let stdoutBuf = '';
    const last = { out_time_s: 0, frame: 0, at: Date.now() };
    let settled = false;
    let stallTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (jobId != null) RUNNING.delete(jobId);
      fn(value);
    };
    const armStall = () => {
      clearTimeout(stallTimer);
      if (!(stallMs > 0)) return;
      stallTimer = setTimeout(() => {
        const idleS = Math.round((Date.now() - last.at) / 1000);
        finish(reject, Object.assign(
          new Error(`${label} stalled — no encoder progress for ${idleS}s (last output ${last.out_time_s.toFixed(1)}s, frame ${last.frame}); process killed`),
          { code: 'stalled', progress: { ...last } },
        ));
        child.kill('SIGKILL');
      }, stallMs);
      stallTimer.unref?.();
    };
    if (jobId != null) {
      RUNNING.set(jobId, {
        pid: child.pid, label, startedAt: Date.now(),
        cancel: reason => { finish(reject, Object.assign(new Error(reason), { code: 'cancelled' })); child.kill('SIGKILL'); },
      });
    }
    child.stdout.on('data', d => {
      stdoutBuf += d;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1).trim();
        // out_time_ms is microseconds in every ffmpeg release (a long-lived
        // naming quirk); newer builds add out_time_us with the same value.
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) last.out_time_s = n / 1e6;
        } else if (k === 'frame') {
          last.frame = Number(v) || last.frame;
        } else if (k === 'progress') {          // end of one progress block
          last.at = Date.now();
          armStall();
          try { onProgress?.({ ...last }); } catch { /* reporting must never kill the encode */ }
        }
      }
    });
    child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-4000); });
    child.on('error', err => finish(reject, Object.assign(err, { code: err.code === 'ENOENT' ? 'spawn' : (err.code || 'spawn'), stderr: stderrTail })));
    child.on('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stderr: stderrTail, progress: { ...last } });
      const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || 'no error output';
      finish(reject, Object.assign(
        new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${tail}`),
        { code: 'exit', stderr: stderrTail },
      ));
    });
    armStall();
  });
}

// Kill a job this process is running. Returns false when the job is not ours
// (a dedicated worker on another instance owns it — the heartbeat sweep will
// reap it there).
export function cancelMediaJob(jobId, reason = 'cancelled') {
  const owned = RUNNING.get(Number(jobId));
  if (!owned) return false;
  owned.cancel(reason);
  return true;
}

export const runningMediaJobs = () => [...RUNNING.entries()].map(([id, r]) => ({ job_id: id, pid: r.pid, label: r.label, started_at: r.startedAt }));

// ── Queue helpers ──────────────────────────────────────────────────────────
const RESET_COLUMNS = "status='queued', error='', attempts=0, claim_token=NULL, heartbeat_at=NULL, progress_pct=NULL, progress_s=NULL, started_at=NULL, finished_at=NULL, updated_at=datetime('now')";

// Queue a job, or re-arm one that already exists in a finished state. The
// table is UNIQUE on (feed_id, kind, params_hash), so a bare INSERT OR IGNORE
// silently did nothing when a prior proxy row existed — which is exactly how
// a re-probed feed could sit in 'processing' with no proxy ever queued.
export function enqueueMediaJob(db, feedId, kind, paramsHash = '') {
  const ins = db.prepare('INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind, params_hash) VALUES (?, ?, ?)').run(feedId, kind, paramsHash);
  if (ins.changes > 0) return 'inserted';
  const reset = db.prepare(
    `UPDATE cmd_media_jobs SET ${RESET_COLUMNS} WHERE feed_id=? AND kind=? AND params_hash=? AND status IN ('failed', 'done')`
  ).run(feedId, kind, paramsHash);
  return reset.changes > 0 ? 'requeued' : 'already_active';
}

// "Retry processing": re-run the pipeline for a feed against the original
// already in storage. Cancels a run this process owns, resets its jobs, and
// re-enters at the right stage — a probed feed restarts at the proxy.
export function requeueFeedProcessing(db, feedId) {
  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(feedId);
  if (!feed) throw Object.assign(new Error('Feed not found'), { status: 404 });
  if (feed.status === 'uploading') throw Object.assign(new Error('Feed is still uploading — nothing to retry yet'), { status: 400 });
  if (feed.status === 'ready') throw Object.assign(new Error('Feed is ready — nothing to retry'), { status: 400 });

  for (const j of db.prepare("SELECT id FROM cmd_media_jobs WHERE feed_id=? AND status='running'").all(feedId)) {
    cancelMediaJob(j.id, 'cancelled — processing was retried');
  }
  db.prepare(`UPDATE cmd_media_jobs SET ${RESET_COLUMNS} WHERE feed_id=? AND status IN ('failed', 'running', 'queued')`).run(feedId);

  const probed = db.prepare("SELECT 1 FROM cmd_media_jobs WHERE feed_id=? AND kind='probe' AND status='done'").get(feedId);
  const stage = probed && feed.width ? 'proxy' : 'probe';
  enqueueMediaJob(db, feedId, stage);
  db.prepare("UPDATE cmd_video_feeds SET status='queued', error='', updated_at=datetime('now') WHERE id=?").run(feedId);
  log('info', 'media_retry_requested', { feed_id: feedId, job_id: feed.job_id, from_status: feed.status, stage });
  return { feed: db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(feedId), stage };
}

// ── Handlers ───────────────────────────────────────────────────────────────
async function handleProbe(db, job, feed) {
  // Stream through the localhost gateway — downloading a full-game original
  // to the instance is what OOM-killed production, and static ffmpeg builds
  // can't be trusted with https (the linux one fails on R2 URLs outright).
  const src = await gatewayUrlFor(feed.storage_key);
  const meta = await probeFile(src);
  db.prepare(
    `UPDATE cmd_video_feeds SET duration_s=?, codec=?, width=?, height=?, rotation=?, nominal_fps=?, effective_fps=?, vfr=?, updated_at=datetime('now') WHERE id=?`
  ).run(meta.duration_s, meta.codec, meta.width, meta.height, meta.rotation, meta.nominal_fps, meta.effective_fps, meta.vfr, feed.id);
  return { meta };
}

async function handleProxy(db, job, feed, { stallMs }) {
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
  const duration = Number(feed.duration_s) > 0 ? Number(feed.duration_s) : 0;
  log('info', 'proxy_encode_started', {
    feed_id: feed.id, media_job_id: job.id, source: `${feed.width}x${feed.height}@${feed.effective_fps}`,
    target_fps: targetFps, target_height: Math.min(PROXY_MAX_HEIGHT, feed.height || PROXY_MAX_HEIGHT),
    duration_s: feed.duration_s, stall_ms: stallMs,
  });
  const outPath = path.join(os.tmpdir(), `dm-proxy-${feed.id}.mp4`);
  const thumbPath = path.join(os.tmpdir(), `dm-thumb-${feed.id}.jpg`);

  // Heartbeat: progress lands on the job row (throttled) so the UI can show
  // "42% · 7.4 s of 17.7 s" and the sweep can tell alive from wedged.
  let lastBeat = 0;
  const beat = db.prepare("UPDATE cmd_media_jobs SET heartbeat_at=datetime('now'), progress_pct=?, progress_s=?, updated_at=datetime('now') WHERE id=?");
  const onProgress = p => {
    const now = Date.now();
    if (now - lastBeat < 1000) return;
    lastBeat = now;
    const pct = duration ? Math.min(0.99, p.out_time_s / duration) : null;
    beat.run(pct, p.out_time_s, job.id);
  };

  try {
    // CFR proxy: normalizes VFR originals so frame math is defensible; the
    // measured rendition's FPS is what measurements record (TDR §2).
    await runFfmpeg([
      ...ioTimeoutArgs(), '-y', '-i', src,
      '-threads', '2',
      '-vf', `scale=-2:'min(${PROXY_MAX_HEIGHT},ih)'`, '-r', String(targetFps), '-vsync', 'cfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath,
    ], { stallMs, onProgress, label: 'proxy encode', jobId: job.id });
    // Mid-clip poster thumbnail — robust for any duration (strip variant later).
    await runFfmpeg(['-y', '-ss', String(Math.max(0, duration / 2)), '-i', outPath, '-frames:v', '1', '-vf', 'scale=320:-2', thumbPath],
      { stallMs: Math.min(stallMs || 60_000, 60_000), label: 'thumbnail', jobId: job.id });

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
  } finally {
    fs.rmSync(outPath, { force: true });
    fs.rmSync(thumbPath, { force: true });
  }
}

// Clip generation is exercised from M4 when events exist; the queue kind is
// reserved so idempotency and retry semantics are already in place.
async function handleClip() { /* no-op until M4 */ }

// ── Queue loop ─────────────────────────────────────────────────────────────
export async function processNextMediaJob(db, { stallMs = STALL_MS } = {}) {
  const job = db.prepare("SELECT * FROM cmd_media_jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
  if (!job) return false;
  // The claim token makes every later write conditional: if an analyst hits
  // Retry while this run is mid-encode, the reset row belongs to the new
  // run and this one's outcome is discarded instead of clobbering it.
  const token = randomUUID();
  const claimed = db.prepare(
    "UPDATE cmd_media_jobs SET status='running', attempts=attempts+1, claim_token=?, started_at=datetime('now'), heartbeat_at=datetime('now'), progress_pct=NULL, progress_s=NULL, finished_at=NULL, updated_at=datetime('now') WHERE id=? AND status='queued'"
  ).run(token, job.id);
  if (claimed.changes === 0) return true;   // raced; try again next tick
  const attempt = job.attempts + 1;

  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(job.feed_id);
  const settle = (fields) => db.prepare(
    `UPDATE cmd_media_jobs SET ${fields}, updated_at=datetime('now') WHERE id=? AND claim_token=? AND status='running'`
  );
  try {
    if (!feed) throw Object.assign(new Error('feed record is missing'), { permanent: true });
    if (job.kind === 'probe') {
      await handleProbe(db, job, feed);
    } else if (job.kind === 'proxy') {
      await handleProxy(db, job, feed, { stallMs });
    } else if (job.kind === 'clip') {
      await handleClip();
    } else {
      throw Object.assign(new Error(`unknown media job kind ${job.kind}`), { permanent: true });
    }
    const done = settle("status='done', error='', progress_pct=1, finished_at=datetime('now')").run(job.id, token);
    if (done.changes === 0) {
      log('warn', 'media_job_superseded', { job_id: job.id, kind: job.kind, feed_id: job.feed_id, note: 'row was reset while running; result discarded' });
      return true;
    }
    if (job.kind === 'probe') {
      db.prepare("UPDATE cmd_video_feeds SET status='processing', error='', updated_at=datetime('now') WHERE id=?").run(feed.id);
      enqueueMediaJob(db, feed.id, 'proxy');   // chain — re-arms a stale proxy row too
    } else if (job.kind === 'proxy') {
      db.prepare("UPDATE cmd_video_feeds SET status='ready', error='', updated_at=datetime('now') WHERE id=?").run(feed.id);
      // First ready feed on a job → customer "footage received".
      const readyCount = db.prepare("SELECT COUNT(*) c FROM cmd_video_feeds WHERE job_id=? AND status='ready'").get(feed.job_id).c;
      if (readyCount === 1) emitJobEvent(db, { jobId: feed.job_id, eventKey: 'footage_received' });
      log('info', 'proxy_encode_finished', { feed_id: feed.id, media_job_id: job.id, attempt });
    }
  } catch (err) {
    if (err.code === 'cancelled') {
      log('info', 'media_job_cancelled', { job_id: job.id, kind: job.kind, feed_id: job.feed_id, reason: err.message });
      return true;   // whoever cancelled already rewrote the row
    }
    const retryable = !err.permanent && attempt < MAX_ATTEMPTS;
    // Prefer the stderr TAIL: exec errors prefix the whole command line, and
    // a 500-char presigned URL used to crowd the real ffmpeg error out of
    // the stored message entirely.
    const raw = err.code === 'stalled' || err.code === 'exit' ? err.message : String(err.stderr || err.message || err);
    const detail = raw.trim().slice(-500);
    // A retried job goes back to 'queued' and re-stamps started_at when it
    // is next claimed; only a terminal failure closes the timing window.
    const wrote = settle(retryable ? "status='queued', error=?" : "status='failed', error=?, finished_at=datetime('now')").run(detail, job.id, token);
    captureError(err, { event: 'media_job_failed', component: 'media_worker', job_id: job.id, kind: job.kind, attempt, retryable, code: err.code || null, detail });
    if (wrote.changes > 0 && feed) {
      const reason = retryable
        ? `${detail} (attempt ${attempt} of ${MAX_ATTEMPTS} — retrying)`
        : `${detail}${err.permanent ? '' : ` (failed ${attempt} of ${MAX_ATTEMPTS} attempts)`}`;
      db.prepare("UPDATE cmd_video_feeds SET status=?, error=?, updated_at=datetime('now') WHERE id=?")
        .run(retryable ? 'retrying' : 'failed', reason, feed.id);
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
  for (const o of orphans) failOrRequeue(db, o, 'the worker process restarted mid-run (out of memory, deploy, or crash)');
  return orphans.length;
}

// Jobs whose heartbeat has gone quiet. Owned jobs are normally reaped by the
// in-process watchdog; the sweep is the backstop for a job whose child
// handle was lost, or a dedicated worker that died holding the claim.
export function sweepStalledJobs(db, { stallMs = STALL_MS } = {}) {
  const stale = db.prepare(
    "SELECT id, feed_id, kind, attempts, (strftime('%s','now') - strftime('%s', COALESCE(heartbeat_at, started_at, updated_at))) AS quiet_s FROM cmd_media_jobs WHERE status='running'"
  ).all().filter(j => j.quiet_s * 1000 >= stallMs);
  let reaped = 0;
  for (const j of stale) {
    const owned = RUNNING.get(j.id);
    if (owned) {
      // Give the watchdog its own window first; only force past 2× the threshold.
      if (j.quiet_s * 1000 < stallMs * 2) continue;
      owned.cancel(`no encoder progress for ${Math.round(j.quiet_s)}s — killed by the queue sweep`);
    }
    failOrRequeue(db, j, `no progress reported for ${Math.round(j.quiet_s)}s (worker stopped or wedged)`);
    reaped += 1;
  }
  return reaped;
}

function failOrRequeue(db, j, why) {
  const terminal = j.attempts >= MAX_ATTEMPTS;
  if (terminal) {
    const msg = `${why} — failed ${j.attempts} of ${MAX_ATTEMPTS} attempts`;
    db.prepare("UPDATE cmd_media_jobs SET status='failed', error=?, claim_token=NULL, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='running'").run(msg, j.id);
    db.prepare("UPDATE cmd_video_feeds SET status='failed', error=?, updated_at=datetime('now') WHERE id=?").run(msg, j.feed_id);
  } else {
    const msg = `${why} (attempt ${j.attempts} of ${MAX_ATTEMPTS} — retrying)`;
    db.prepare("UPDATE cmd_media_jobs SET status='queued', error=?, claim_token=NULL, heartbeat_at=NULL, updated_at=datetime('now') WHERE id=? AND status='running'").run(msg, j.id);
    db.prepare("UPDATE cmd_video_feeds SET status='retrying', error=?, updated_at=datetime('now') WHERE id=?").run(msg, j.feed_id);
  }
  log('warn', 'media_job_reaped', { job_id: j.id, feed_id: j.feed_id, kind: j.kind, attempts: j.attempts, terminal, why });
}

export function startInlineWorker(db, { intervalMs = 3000, stallMs = STALL_MS } = {}) {
  recoverOrphanedJobs(db);
  let draining = false;
  const tick = async () => {
    try { sweepStalledJobs(db, { stallMs }); }
    catch (err) { captureError(err, { event: 'media_sweep_failed', component: 'media_worker' }); }
    if (draining) return;   // one drain loop at a time; a long encode must not stack a second
    draining = true;
    try { while (await processNextMediaJob(db, { stallMs })) { /* drain */ } }
    catch (err) { captureError(err, { event: 'media_worker_tick_failed', component: 'media_worker' }); }
    finally { draining = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log('info', 'media_worker_started', { interval_ms: intervalMs, stall_ms: stallMs, io_timeout_s: IO_TIMEOUT_S, storage: storageMode });
  return timer;
}
