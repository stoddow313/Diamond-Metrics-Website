// Recipe-based capture QA. The reported defect: Command accepted a 720p feed
// as READY for Rookie timing, which requires 1080p/30 minimum. The
// requirement was documented in prose and enforced nowhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-capture-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { evaluateFeed, assessCapture, CAPTURE_SPECS, unavailableReasonFor } = await import('./captureSpec.js');
const { computeQaFlags } = await import('./releaseLogic.js');

let jobId, reviewerId;
const addFeed = (w, h, fps, name) => db.prepare(
  "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps) VALUES (?, 'BH', 'k', ?, 'ready', ?, ?, ?)"
).run(jobId, name, w, h, fps).lastInsertRowid;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('O')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'T', 't')").run(org).lastInsertRowid;
  reviewerId = db.prepare("INSERT INTO admins (email, password_hash, name, role) VALUES ('r@t.t','x','R','reviewer')").run().lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email) VALUES ('rookie','R','c@t.t')").run().lastInsertRowid;
  for (const c of ['home_to_first', 'steal_time', 'pitch_velocity_radar', 'ninety_ft_speed']) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, c);
  }
  const sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?,?,'2026-08-27',?)").run(sport, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent) VALUES (?, 1)').run(jobId);
});
after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('720p is blocking for Rookie timing — the exact reported defect', () => {
  const issues = evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1280, height: 720, effective_fps: 60 });
  const blocking = issues.filter(i => i.severity === 'blocking');
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].code, 'resolution_below_minimum');
  assert.match(blocking[0].detail, /1080p minimum/);
});

test('30 fps warns but does not block; below 30 blocks', () => {
  const at30 = evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 30 });
  assert.equal(at30.filter(i => i.severity === 'blocking').length, 0, '30 fps meets the minimum');
  const warn = at30.find(i => i.code === 'frame_rate_below_preferred');
  assert.ok(warn, 'but is below the preferred 60');
  assert.match(warn.detail, /±33 ms/);

  const at24 = evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 24 });
  assert.equal(at24.filter(i => i.code === 'frame_rate_below_minimum').length, 1);
});

test('1080p60 is clean, and radar metrics never depend on the video', () => {
  assert.deepEqual(evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 60 }), []);
  assert.deepEqual(evaluateFeed(CAPTURE_SPECS.pitch_velocity_radar, { width: 640, height: 480, effective_fps: 15 }), []);
});

test('a job with only a 720p feed blocks approval; a 1080p feed alongside it satisfies the metric', () => {
  addFeed(1280, 720, 60, 'handheld-720.mp4');
  let assess = assessCapture(db, jobId);
  const h2f = assess.find(a => a.metric_code === 'home_to_first');
  assert.equal(h2f.status, 'blocked');
  assert.equal(unavailableReasonFor(h2f), 'insufficient_capture_quality');
  assert.ok(computeQaFlags(db, jobId).some(f => f.level === 'blocking' && /capture requirements not met/.test(f.label)),
    'approval is gated on capture, not just on review');

  // A second, adequate angle satisfies it — one bad feed must not veto a good one.
  addFeed(1920, 1080, 59.94, 'behind-home-1080.mp4');
  assess = assessCapture(db, jobId);
  const better = assess.find(a => a.metric_code === 'home_to_first');
  assert.equal(better.status, 'ok');
  assert.equal(better.best_feed.name, 'behind-home-1080.mp4');
  assert.ok(!computeQaFlags(db, jobId).some(f => f.level === 'blocking' && /capture/.test(f.code)));
});

test('an audited override unblocks a metric and stays visible as a warning', () => {
  // Drop back to only the inadequate feed.
  db.prepare("DELETE FROM cmd_video_feeds WHERE original_name = 'behind-home-1080.mp4'").run();
  assert.equal(assessCapture(db, jobId).find(a => a.metric_code === 'home_to_first').status, 'blocked');

  db.prepare("INSERT INTO cmd_capture_overrides (job_id, metric_code, note, actor_id) VALUES (?, 'home_to_first', 'Only angle available; runner clearly visible.', ?)").run(jobId, reviewerId);
  const a = assessCapture(db, jobId).find(x => x.metric_code === 'home_to_first');
  assert.equal(a.status, 'overridden');
  assert.equal(a.override.note, 'Only angle available; runner clearly visible.');

  const flags = computeQaFlags(db, jobId);
  assert.ok(!flags.some(f => f.level === 'blocking' && f.code === 'capture_home_to_first'), 'no longer blocks');
  assert.ok(flags.some(f => f.level === 'warning' && /overridden/.test(f.label)), 'but is still surfaced');
});

test('derived metrics defer to their source and are never independently blocked', () => {
  const derived = assessCapture(db, jobId).find(a => a.metric_code === 'ninety_ft_speed');
  assert.equal(derived.status, 'not_applicable');
  assert.equal(derived.derived_from, 'home_to_first');
});

test('NTSC rates count as their nominal value — 59.94 is 60, 29.97 is 30', () => {
  // Otherwise every standard camera nags on every job forever.
  assert.deepEqual(evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 59.94 }), []);
  const ntsc30 = evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 29.97 });
  assert.equal(ntsc30.filter(i => i.severity === 'blocking').length, 0, '29.97 meets the 30 minimum');
  // The tolerance must not be wide enough to let 30 masquerade as 60.
  assert.ok(evaluateFeed(CAPTURE_SPECS.home_to_first, { width: 1920, height: 1080, effective_fps: 30 })
    .some(i => i.code === 'frame_rate_below_preferred'));
});
