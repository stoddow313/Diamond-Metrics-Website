// Proxy scratch space. Render evicts an instance whose /tmp passes 2 GB,
// and a 1080p60 review proxy passes that at about 55 minutes of game: in
// October 2026 the 65- and 103-minute games encoded for ~2 h, were evicted
// (taking the API down), retried, and were evicted again — nine times in a
// day. Now a proxy that will not fit is refused before encoding with the
// reason, DM_MEDIA_SCRATCH_DIR points the encode at a disk with room, and
// partial proxies a killed run left behind are cleared at start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DB = `/tmp/dm-media-scratch-${process.pid}.db`;
const MEDIA_DIR = `/tmp/dm-media-scratch-${process.pid}-store`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_MEDIA_DIR = MEDIA_DIR;
process.env.DM_STORAGE = 'local';
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { estimateProxyBytes, scratchProblem, scratchLimitBytes, clearScratch, enqueueMediaJob, processNextMediaJob } = await import('./mediaWorker.js');

const GB = 1024 ** 3;
after(() => {
  db.close();
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// The three production games, all 1080p60.
const game = durationS => estimateProxyBytes({ durationS, height: 1080, fps: 60 });

test('the size estimate matches what production produced (~4.75 Mbps at 1080p60) with a margin', () => {
  assert.ok(game(2493) > 1.4 * GB && game(2493) < 2 * GB, '41.5-minute game fits under 2 GB');
  assert.ok(game(3933) > 2.3 * GB, '65.5-minute game is over 2 GB (it was evicted at ~91%)');
  assert.ok(game(6201) > 3.6 * GB, '103-minute game');
  assert.ok(estimateProxyBytes({ durationS: 3933, height: 720, fps: 30 }) < game(3933) / 4, 'smaller sources scale down');
  assert.equal(estimateProxyBytes({ durationS: 3933, height: 2160, fps: 60 }), game(3933), 'capped at the 1080p proxy height');
});

test('Render /tmp is capped at 2 GB unless a scratch directory is configured', () => {
  assert.equal(scratchLimitBytes({ RENDER: 'true' }), 2 * GB);
  assert.equal(scratchLimitBytes({ RENDER: 'true', DM_MEDIA_SCRATCH_DIR: '/var/data/scratch' }), Infinity);
  assert.equal(scratchLimitBytes({}), Infinity, 'local runs are bounded only by free space');
  assert.equal(scratchLimitBytes({ RENDER: 'true', DM_MEDIA_SCRATCH_LIMIT_MB: '500' }), 500 * 1024 * 1024);
});

test('a proxy that will not fit is refused with the reason; one that fits is not', () => {
  const tmp = { freeBytes: 50 * GB, limitBytes: 2 * GB, dir: '/tmp' };
  assert.equal(scratchProblem({ ...tmp, needBytes: game(2493) }), null);
  const msg = scratchProblem({ ...tmp, needBytes: game(3933) });
  assert.match(msg, /needs about 2\.\d GB of scratch space, and \/tmp has room for 2\.0 GB \(Render caps \/tmp at 2 GB\)/);
  assert.match(msg, /DM_MEDIA_SCRATCH_DIR/);
  // A 20 GB persistent disk holding a small database takes the 103-minute game.
  assert.equal(scratchProblem({ freeBytes: 19 * GB, limitBytes: Infinity, dir: '/var/data/scratch', needBytes: game(6201) }), null);
  // The database's share of a shared disk is kept free.
  assert.match(scratchProblem({ freeBytes: game(6201) + 100 * 1024 * 1024, limitBytes: Infinity, dir: '/var/data/scratch', needBytes: game(6201) }), /room for/);
});

test('start-up clears partial proxies a killed run left, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-scratch-'));
  for (const f of ['dm-proxy-24.mp4', 'dm-thumb-24.jpg', 'dm-proxy-25.mp4', 'dm.db', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.equal(clearScratch(dir), 3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dm.db', 'notes.txt']);
  assert.equal(clearScratch(path.join(dir, 'missing')), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

let jobId;
before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-10-10', ?)").run(baseball, team, order).lastInsertRowid;
});

test('pipeline: a 65-minute 1080p60 game on capped scratch fails at once, permanently, with the reason — no encode, no eviction loop', async () => {
  process.env.DM_MEDIA_SCRATCH_LIMIT_MB = '2048';
  try {
    const feedId = db.prepare(
      `INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, duration_s, width, height, nominal_fps, effective_fps, codec)
       VALUES (?, 'BH', 'originals/x/source.mp4', '14U Silver final.mp4', 'processing', 3932.88, 1920, 1080, 60, 60.01, 'h264')`
    ).run(jobId).lastInsertRowid;
    enqueueMediaJob(db, feedId, 'proxy');
    const started = Date.now();
    await processNextMediaJob(db);
    assert.ok(Date.now() - started < 5000, 'refused before any encoding');
    const job = db.prepare("SELECT * FROM cmd_media_jobs WHERE feed_id = ? AND kind = 'proxy'").get(feedId);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 1, 'no retries spent on a run that cannot fit');
    const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(feedId);
    assert.equal(feed.status, 'failed');
    assert.match(feed.error, /needs about 2\.\d GB of scratch space/);
  } finally {
    delete process.env.DM_MEDIA_SCRATCH_LIMIT_MB;
  }
});
