// Media-processing reliability: every job terminates. A production feed sat
// in PROCESSING for days because one ffmpeg read never returned and nothing
// had a timeout or a watchdog. These tests pin the guarantees that replaced
// that: a stalled encoder is killed with a specific reason, quiet jobs are
// reaped, failures are terminal after three attempts, and Retry re-enters
// the pipeline against the stored original.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';

const TEST_DB = `/tmp/dm-media-rel-${process.pid}.db`;
const MEDIA_DIR = `/tmp/dm-media-rel-${process.pid}-store`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_MEDIA_DIR = MEDIA_DIR;
process.env.DM_STORAGE = 'local';
process.env.DM_LOG_SILENT = '1';

const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const { db } = await import('./db.js');
const {
  runFfmpeg, cancelMediaJob, sweepStalledJobs, enqueueMediaJob, requeueFeedProcessing,
  processNextMediaJob, recoverOrphanedJobs, MAX_ATTEMPTS,
} = await import('./mediaWorker.js');
const { pipeUpstream } = await import('./mediaGateway.js');
const { localPathFor } = await import('./storage.js');

const scripts = [];
function fakeBin(body) {
  const p = path.join(os.tmpdir(), `dm-fake-ffmpeg-${process.pid}-${scripts.length}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  scripts.push(p);
  return p;
}

let jobId;
function newFeed(fields = {}) {
  const cols = { job_id: jobId, label: 'BH', storage_key: '', original_name: 'clip.mp4', status: 'processing', ...fields };
  const keys = Object.keys(cols);
  const id = db.prepare(`INSERT INTO cmd_video_feeds (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => cols[k])).lastInsertRowid;
  if (!fields.storage_key) db.prepare('UPDATE cmd_video_feeds SET storage_key=? WHERE id=?').run(`originals/${id}/source.mp4`, id);
  return id;
}
const feedRow = id => db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(id);
const jobRows = feedId => db.prepare('SELECT * FROM cmd_media_jobs WHERE feed_id=? ORDER BY id').all(feedId);

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-31', ?)").run(baseball, team, order).lastInsertRowid;
});

after(() => {
  db.close();
  for (const s of scripts) fs.rmSync(s, { force: true });
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// ── Supervised ffmpeg ──────────────────────────────────────────────────────
test('an encoder that stops reporting progress is killed with a specific reason', async () => {
  const bin = fakeBin(`printf 'frame=12\\nout_time_ms=400000\\nprogress=continue\\n'\nsleep 30`);
  const started = Date.now();
  await assert.rejects(
    runFfmpeg([], { bin, stallMs: 1500, label: 'proxy encode' }),
    err => {
      assert.equal(err.code, 'stalled');
      assert.match(err.message, /proxy encode stalled/);
      assert.match(err.message, /last output 0\.4s, frame 12/);
      assert.match(err.message, /killed/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10000, 'killed promptly, not after the 30 s sleep');
});

test('a crashing encoder surfaces the stderr tail, not a command line', async () => {
  const bin = fakeBin(`echo 'Input #0, mov, from ...' 1>&2\necho 'moov atom not found' 1>&2\nexit 1`);
  await assert.rejects(runFfmpeg(['-i', 'http://127.0.0.1:1/very/long/presigned?token=' + 'x'.repeat(600)], { bin, stallMs: 0, label: 'proxy encode' }), err => {
    assert.equal(err.code, 'exit');
    assert.match(err.message, /exited with code 1/);
    assert.match(err.message, /moov atom not found/);
    assert.ok(!err.message.includes('xxxxxxxx'), 'the URL is not in the stored reason');
    return true;
  });
});

test('progress callbacks carry output time and frame; a clean exit resolves', async () => {
  const bin = fakeBin(`printf 'frame=3\\nout_time_ms=100000\\nprogress=continue\\n'\nprintf 'frame=6\\nout_time_ms=200000\\nprogress=end\\n'`);
  const seen = [];
  const result = await runFfmpeg([], { bin, stallMs: 2000, onProgress: p => seen.push(p) });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].frame, 6);
  assert.ok(Math.abs(seen[1].out_time_s - 0.2) < 1e-9);
  assert.equal(result.progress.frame, 6);
});

test('a run this process owns can be cancelled by media job id', async () => {
  const bin = fakeBin('sleep 30');
  const pending = runFfmpeg([], { bin, stallMs: 0, jobId: 987654 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(cancelMediaJob(987654, 'cancelled — processing was retried'), true);
  await assert.rejects(pending, err => err.code === 'cancelled' && /retried/.test(err.message));
  assert.equal(cancelMediaJob(987654), false, 'registry entry is gone once settled');
});

// ── Gateway teardown ───────────────────────────────────────────────────────
test('gateway destroys the upstream R2 read when the client disconnects (the socket leak)', async () => {
  const upstream = new PassThrough();
  const client = new PassThrough();
  pipeUpstream(upstream, client);
  upstream.write('partial');
  assert.equal(upstream.destroyed, false);
  client.destroy();                        // ffmpeg seeks: drops the connection
  await new Promise(r => setImmediate(r)); // 'close' fires on the next tick
  assert.equal(upstream.destroyed, true, 'upstream body is torn down with the client');
});

// ── Queue bookkeeping ──────────────────────────────────────────────────────
test('enqueueMediaJob re-arms a finished row instead of silently doing nothing', () => {
  const feedId = newFeed({ width: 1920, height: 1080 });
  assert.equal(enqueueMediaJob(db, feedId, 'proxy'), 'inserted');
  assert.equal(enqueueMediaJob(db, feedId, 'proxy'), 'already_active', 'queued row is left alone');
  db.prepare("UPDATE cmd_media_jobs SET status='failed', attempts=3, error='x' WHERE feed_id=?").run(feedId);
  assert.equal(enqueueMediaJob(db, feedId, 'proxy'), 'requeued');
  const j = jobRows(feedId)[0];
  assert.equal(j.status, 'queued');
  assert.equal(j.attempts, 0);
  assert.equal(j.error, '');
  db.prepare("UPDATE cmd_media_jobs SET status='running' WHERE feed_id=?").run(feedId);
  assert.equal(enqueueMediaJob(db, feedId, 'proxy'), 'already_active', 'never resets a running job');
  db.prepare("UPDATE cmd_media_jobs SET status='done' WHERE feed_id=?").run(feedId);
});

test('sweep: a quiet running job is requeued with the reason, and fails terminally after three attempts', () => {
  const feedId = newFeed();
  const ins = db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts, started_at, heartbeat_at) VALUES (?, 'proxy', 'running', ?, datetime('now','-20 minutes'), datetime('now','-11 minutes'))");
  const j1 = ins.run(feedId, 1).lastInsertRowid;

  assert.equal(sweepStalledJobs(db, { stallMs: 60 * 60 * 1000 }), 0, 'inside the threshold: untouched');
  assert.equal(sweepStalledJobs(db, { stallMs: 5 * 60 * 1000 }), 1);
  let j = db.prepare('SELECT * FROM cmd_media_jobs WHERE id=?').get(j1);
  assert.equal(j.status, 'queued');
  assert.match(j.error, /no progress reported for \d+s/);
  assert.match(j.error, /attempt 1 of 3 — retrying/);
  assert.equal(feedRow(feedId).status, 'retrying');

  db.prepare("UPDATE cmd_media_jobs SET status='running', attempts=? , heartbeat_at=datetime('now','-11 minutes') WHERE id=?").run(MAX_ATTEMPTS, j1);
  assert.equal(sweepStalledJobs(db, { stallMs: 5 * 60 * 1000 }), 1);
  j = db.prepare('SELECT * FROM cmd_media_jobs WHERE id=?').get(j1);
  assert.equal(j.status, 'failed', 'terminal');
  assert.ok(j.finished_at, 'terminal failure closes the timing window');
  const feed = feedRow(feedId);
  assert.equal(feed.status, 'failed');
  assert.match(feed.error, /failed 3 of 3 attempts/);
});

test('orphan recovery at boot follows the same rule', () => {
  const feedId = newFeed();
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts) VALUES (?, 'probe', 'running', 1)").run(feedId);
  assert.equal(recoverOrphanedJobs(db), 1);
  assert.equal(jobRows(feedId)[0].status, 'queued');
  assert.match(feedRow(feedId).error, /worker process restarted/);
});

test('Retry processing: a probed feed restarts at the proxy, a raw one at the probe; ready and uploading refuse', () => {
  // Stuck exactly like production feed 22: probe done, proxy running forever.
  const stuck = newFeed({ width: 720, height: 1280, duration_s: 17.7, effective_fps: 30 });
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts) VALUES (?, 'probe', 'done', 1)").run(stuck);
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts, claim_token, started_at) VALUES (?, 'proxy', 'running', 1, 'old', datetime('now','-3 hours'))").run(stuck);
  const r = requeueFeedProcessing(db, stuck);
  assert.equal(r.stage, 'proxy');
  assert.equal(r.feed.status, 'queued');
  const rows = jobRows(stuck);
  assert.equal(rows.find(x => x.kind === 'probe').status, 'done', 'probe result is kept');
  const proxy = rows.find(x => x.kind === 'proxy');
  assert.equal(proxy.status, 'queued');
  assert.equal(proxy.attempts, 0);
  assert.equal(proxy.claim_token, null, 'the old run can no longer write this row');
  assert.equal(rows.length, 2, 'no duplicate job rows');

  const raw = newFeed({ status: 'failed', error: 'boom' });
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts, error) VALUES (?, 'probe', 'failed', 3, 'boom')").run(raw);
  assert.equal(requeueFeedProcessing(db, raw).stage, 'probe');
  assert.equal(jobRows(raw)[0].status, 'queued');
  assert.equal(feedRow(raw).error, '');

  const ready = newFeed({ status: 'ready' });
  assert.throws(() => requeueFeedProcessing(db, ready), /ready — nothing to retry/);
  const uploading = newFeed({ status: 'uploading' });
  assert.throws(() => requeueFeedProcessing(db, uploading), /still uploading/);
});

test('a superseded run cannot overwrite the row that replaced it', async () => {
  // Claim a job, then reset it (as Retry would) before the run "finishes".
  const feedId = newFeed({ width: 640, height: 360, effective_fps: 30, duration_s: 1 });
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, status, attempts, claim_token) VALUES (?, 'proxy', 'running', 1, 'stale-token')").run(feedId);
  const wrote = db.prepare("UPDATE cmd_media_jobs SET status='done' WHERE feed_id=? AND claim_token='some-other-token' AND status='running'").run(feedId);
  assert.equal(wrote.changes, 0);
  requeueFeedProcessing(db, feedId);
  const j = jobRows(feedId).find(x => x.kind === 'proxy');
  assert.equal(j.status, 'queued');
  const late = db.prepare("UPDATE cmd_media_jobs SET status='done' WHERE id=? AND claim_token=? AND status='running'").run(j.id, 'stale-token');
  assert.equal(late.changes, 0, 'stale claim writes nothing');
});

// ── End to end: forced stall, automatic retry, READY ───────────────────────
// Bookkeeping tests above leave queued rows for feeds with no real file;
// park them so the pipeline tests process only their own jobs.
const quiesceQueue = () => db.prepare("UPDATE cmd_media_jobs SET status='done' WHERE status IN ('queued', 'running')").run();

test('pipeline: a stalled first attempt is retried automatically and the feed still lands READY', async () => {
  quiesceQueue();
  const clip = path.join(os.tmpdir(), `dm-rel-clip-${process.pid}.mp4`);
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { stdio: 'ignore' });
  const feedId = newFeed({ status: 'queued' });
  const key = feedRow(feedId).storage_key;
  fs.mkdirSync(path.dirname(localPathFor(key)), { recursive: true });
  fs.copyFileSync(clip, localPathFor(key));
  enqueueMediaJob(db, feedId, 'probe');

  await processNextMediaJob(db);                       // probe
  assert.equal(feedRow(feedId).status, 'processing');
  const proxyRow = () => jobRows(feedId).find(x => x.kind === 'proxy');
  assert.equal(proxyRow().status, 'queued', 'probe chained the proxy');

  // Attempt 1 with an impossible stall budget: the watchdog fires before the
  // first progress line, exactly what a wedged read looks like from outside.
  await processNextMediaJob(db, { stallMs: 5 });
  let feed = feedRow(feedId);
  assert.equal(feed.status, 'retrying', feed.error);
  assert.match(feed.error, /stalled — no encoder progress/);
  assert.match(feed.error, /attempt 1 of 3 — retrying/);
  assert.equal(proxyRow().status, 'queued');

  // Attempt 2 with a sane budget succeeds; the terminal state carries no stale error.
  await processNextMediaJob(db);
  feed = feedRow(feedId);
  assert.equal(feed.status, 'ready', feed.error);
  assert.equal(feed.error, '');
  const j = proxyRow();
  assert.equal(j.status, 'done');
  assert.equal(j.attempts, 2);
  assert.equal(j.progress_pct, 1);
  assert.ok(j.finished_at);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_media_renditions WHERE feed_id=? AND kind='proxy'").get(feedId).c, 1);
  fs.rmSync(clip, { force: true });
  for (const f of fs.readdirSync(os.tmpdir()).filter(n => n === `dm-proxy-${feedId}.mp4` || n === `dm-thumb-${feedId}.jpg`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), `dm-proxy-${feedId}.mp4`)), 'temp proxy cleaned up');
});

test('pipeline: three stalls in a row end in a terminal Failed state with the reason, not a fourth spin', async () => {
  quiesceQueue();
  const clip = path.join(os.tmpdir(), `dm-rel-clip2-${process.pid}.mp4`);
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], { stdio: 'ignore' });
  const feedId = newFeed({ status: 'processing', width: 320, height: 240, effective_fps: 30, duration_s: 1 });
  const key = feedRow(feedId).storage_key;
  fs.mkdirSync(path.dirname(localPathFor(key)), { recursive: true });
  fs.copyFileSync(clip, localPathFor(key));
  enqueueMediaJob(db, feedId, 'proxy');
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await processNextMediaJob(db, { stallMs: 5 });
  const feed = feedRow(feedId);
  assert.equal(feed.status, 'failed');
  assert.match(feed.error, /stalled/);
  assert.match(feed.error, /failed 3 of 3 attempts/);
  const j = jobRows(feedId)[0];
  assert.equal(j.status, 'failed');
  assert.equal(await processNextMediaJob(db), false, 'nothing left queued — no infinite loop');
  // …and Retry brings it back with a clean counter.
  requeueFeedProcessing(db, feedId);
  await processNextMediaJob(db);
  assert.equal(feedRow(feedId).status, 'ready');
  fs.rmSync(clip, { force: true });
});
