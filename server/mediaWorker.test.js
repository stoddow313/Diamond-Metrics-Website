// Media pipeline acceptance: probe reads real metadata (incl. effective FPS),
// the proxy is CFR at the declared rate, and the queue drives feed states
// uploaded → queued → ready with idempotent job rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TEST_DB = `/tmp/dm-media-test-${process.pid}.db`;
const MEDIA_DIR = `/tmp/dm-media-test-${process.pid}-store`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_MEDIA_DIR = MEDIA_DIR;
process.env.DM_STORAGE = 'local';

const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const { db } = await import('./db.js');
const { probeFile, processNextMediaJob } = await import('./mediaWorker.js');
const { localPathFor } = await import('./storage.js');

let feedId, clipPath;

before(() => {
  // 2-second 60 fps synthetic clip with burned-in frame counter.
  clipPath = path.join(os.tmpdir(), `dm-synth-${process.pid}.mp4`);
  // Burned-in frame numbers without font deps: geq encodes the frame index
  // into pixel luma; datascope renders those values as readable hex text.
  // Frame N displays hex(N) in every cell — the frame-accuracy ground truth.
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=black:size=32x8:rate=60:duration=2',
    '-vf', "geq=lum='N':cb=128:cr=128,datascope=size=640x360:mode=color2:components=1",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', clipPath,
  ], { stdio: 'pipe' });

  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  const job = db.prepare(
    "INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-20', ?)"
  ).run(baseball, team, order).lastInsertRowid;

  feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status) VALUES (?, 'Behind Home', '', 'synth.mp4', 'uploading')"
  ).run(job).lastInsertRowid;
  const key = `originals/${feedId}/source.mp4`;
  db.prepare('UPDATE cmd_video_feeds SET storage_key = ? WHERE id = ?').run(key, feedId);
  fs.mkdirSync(path.dirname(localPathFor(key)), { recursive: true });
  fs.copyFileSync(clipPath, localPathFor(key));
  db.prepare("UPDATE cmd_video_feeds SET status='queued' WHERE id=?").run(feedId);
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'probe')").run(feedId);
});

after(() => {
  db.close();
  fs.rmSync(clipPath, { force: true });
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('probe reads duration, dimensions, and effective FPS from real media', async () => {
  const meta = await probeFile(clipPath);
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 360);
  assert.ok(Math.abs(meta.duration_s - 2) < 0.1, `duration ${meta.duration_s}`);
  assert.ok(Math.abs(meta.effective_fps - 60) < 0.5, `fps ${meta.effective_fps}`);
  assert.equal(meta.vfr, 0, 'synthetic CFR clip is not flagged VFR');
});

test('queue drives probe → proxy → ready with a CFR proxy rendition', async () => {
  while (await processNextMediaJob(db)) { /* drain */ }
  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id=?').get(feedId);
  assert.equal(feed.status, 'ready', feed.error);
  assert.ok(Math.abs(feed.effective_fps - 60) < 0.5);

  const renditions = db.prepare('SELECT * FROM cmd_media_renditions WHERE feed_id=?').all(feedId);
  const proxy = renditions.find(r => r.kind === 'proxy');
  const thumbs = renditions.find(r => r.kind === 'thumbnails');
  assert.ok(proxy && thumbs, 'proxy + thumbnails exist');
  assert.ok(fs.existsSync(localPathFor(proxy.storage_key)), 'proxy object stored');

  const proxyMeta = await probeFile(localPathFor(proxy.storage_key));
  assert.equal(proxyMeta.height, 360, 'no upscale past source');
  assert.ok(Math.abs(proxyMeta.effective_fps - 60) < 0.5, 'proxy is CFR at source rate');

  // footage_received emitted exactly once on first ready feed
  const events = db.prepare("SELECT event_key FROM cmd_notifications WHERE event_key='footage_received'").all();
  assert.equal(events.length, 1);

  // job rows are idempotent — re-inserting the same kind is ignored
  db.prepare("INSERT OR IGNORE INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'probe')").run(feedId);
  const probes = db.prepare("SELECT COUNT(*) c FROM cmd_media_jobs WHERE feed_id=? AND kind='probe'").get(feedId).c;
  assert.equal(probes, 1);
});

test('a 4K source on a small instance fails fast with an actionable error — it must never reach ffmpeg', async () => {
  process.env.DM_TRANSCODE_MEMORY_MB = '512';   // pin a starter-sized box
  const feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, codec, effective_fps) VALUES (1, '4K', 'originals/x/4k.mp4', 'x.mp4', 'processing', 3840, 2160, 'hevc', 119.88)"
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'proxy')").run(feedId);
  await processNextMediaJob(db);
  const jobRow = db.prepare("SELECT * FROM cmd_media_jobs WHERE feed_id = ? AND kind='proxy'").get(feedId);
  assert.equal(jobRow.status, 'failed', 'permanent failure — no retry loop');
  assert.match(jobRow.error, /1080p/);
  assert.match(jobRow.error, /Upgrade the instance/);
  const feedRow = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(feedId);
  assert.equal(feedRow.status, 'failed');
  delete process.env.DM_TRANSCODE_MEMORY_MB;
});

test('memory detection: explicit override wins, otherwise the real limit is used', async () => {
  const { availableMemoryMb } = await import('./mediaWorker.js');
  process.env.DM_TRANSCODE_MEMORY_MB = '2048';
  assert.equal(availableMemoryMb(), 2048, 'override honoured');
  delete process.env.DM_TRANSCODE_MEMORY_MB;
  // Unset: reports something real and positive (cgroup limit in a container,
  // host memory otherwise) — never a hardcoded guess that blocks a big box.
  assert.ok(availableMemoryMb() > 0);
});

test('proxy preserves native frame rate and caps height at 1080p without upscaling', async () => {
  const { PROXY_MAX_HEIGHT } = await import('./mediaWorker.js');
  assert.equal(PROXY_MAX_HEIGHT, 1080);

  // A 480p source must stay 480p — the cap is a ceiling, not a target.
  const small = path.join(MEDIA_DIR, 'originals/50/source.mp4');
  fs.mkdirSync(path.dirname(small), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', small], { stdio: 'ignore' });
  const feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps, duration_s) VALUES (1, 'SD', 'originals/50/source.mp4', 'sd.mp4', 'processing', 854, 480, 30, 1)"
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind) VALUES (?, 'proxy')").run(feedId);
  await processNextMediaJob(db);
  const r = db.prepare("SELECT * FROM cmd_media_renditions WHERE feed_id = ? AND kind='proxy'").get(feedId);
  assert.equal(r.height, 480, 'no upscaling');
  assert.equal(Math.round(r.fps), 30, 'native rate preserved');
});

test('re-processing replaces the proxy rather than stacking a stale duplicate', async () => {
  const feedId = db.prepare("SELECT id FROM cmd_video_feeds WHERE original_name = 'sd.mp4'").get().id;
  const before = db.prepare("SELECT id FROM cmd_media_renditions WHERE feed_id=? AND kind='proxy'").get(feedId).id;
  db.prepare("INSERT INTO cmd_media_jobs (feed_id, kind, params_hash) VALUES (?, 'proxy', 'v2')").run(feedId);
  await processNextMediaJob(db);
  const rows = db.prepare("SELECT id FROM cmd_media_renditions WHERE feed_id=? AND kind='proxy' ORDER BY id").all(feedId);
  assert.equal(rows.length, 1, 'exactly one proxy — the old unreferenced row is gone');
  assert.notEqual(rows[0].id, before, 'and it is the freshly encoded one');
});
