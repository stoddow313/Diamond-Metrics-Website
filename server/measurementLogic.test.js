// M4 acceptance: frame math, derived 90-ft speed, unavailable pathway,
// remeasure supersedes, module gating, and results wiring — the appendix
// Home-to-First / Steal recipes as executable contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-measure-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const { computeElapsed, ninetyFtSpeedMph, createAttempt, saveMeasurement, markUnavailable } = await import('./measurementLogic.js');

let jobId, playerId, feedId;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  playerId = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('runner', 'R', 'Unner')").run().lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of ['home_to_first', 'steal_time', 'ninety_ft_speed']) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, code);
  }
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-21', ?)").run(baseball, team, order).lastInsertRowid;
  feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps) VALUES (?, 'BH', 'k', 'f.mp4', 'ready', 59.94)"
  ).run(jobId).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps) VALUES (?, 'proxy', 'p', 60)").run(feedId);
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('frame math: elapsed from effective FPS; order and bounds enforced', () => {
  assert.equal(computeElapsed({ startFrame: 60, endFrame: 332, fps: 60 }), 272 / 60);
  assert.throws(() => computeElapsed({ startFrame: 100, endFrame: 100, fps: 60 }), /must follow/);
  assert.throws(() => computeElapsed({ startFrame: 100, endFrame: 90, fps: 60 }), /must follow/);
  assert.throws(() => computeElapsed({ startFrame: 0.5, endFrame: 10, fps: 60 }), /integers/);
  assert.ok(Math.abs(ninetyFtSpeedMph(4.5) - 13.636) < 0.01, 'appendix 90-ft formula');
});

test('valid home-to-first: measurement + timed result + derived 90-ft result', () => {
  const attempt = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: playerId, feed_id: feedId }, 1);
  const m = saveMeasurement(db, attempt.id, { start_frame: 60, end_frame: 332 }, 1);
  assert.equal(m.fps_used, 60, 'measures against the proxy rendition fps, not source');
  assert.ok(Math.abs(m.elapsed_s - 4.5333) < 0.001);

  const results = db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_kind='measurement' AND evidence_id=? ORDER BY metric_code").all(m.id);
  assert.deepEqual(results.map(r => r.metric_code), ['home_to_first', 'ninety_ft_speed']);
  assert.equal(results[0].method, 'frame_timed');
  assert.ok(Math.abs(results[1].value - ninetyFtSpeedMph(m.elapsed_s)) < 0.001, 'derived rides the parent');

  // Remeasure supersedes: one measurement per attempt, results refreshed.
  const m2 = saveMeasurement(db, attempt.id, { start_frame: 60, end_frame: 320 }, 1);
  assert.equal(m2.id, m.id);
  const after2 = db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_id=?").get(m.id).c;
  assert.equal(after2, 2, 'no duplicate results on remeasure');
});

test('steal: outcome-independent timing; unavailable pathway creates a reasoned unavailable result', () => {
  const failedSteal = createAttempt(db, jobId, { attempt_type: 'steal', player_id: playerId, feed_id: feedId, outcome: 'out' }, 1);
  const m = saveMeasurement(db, failedSteal.id, { start_frame: 100, end_frame: 310 }, 1);
  assert.ok(m.elapsed_s > 0, 'failed attempts still time (appendix rule)');

  const blocked = createAttempt(db, jobId, { attempt_type: 'steal', player_id: playerId, feed_id: feedId }, 1);
  const um = markUnavailable(db, blocked.id, { reason: 'base_not_visible' }, 1);
  const result = db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_id=? AND evidence_kind='measurement'").get(um.id);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.value, null, 'no fabricated time');
  assert.equal(result.unavailable_reason, 'base_not_visible');

  assert.throws(() => markUnavailable(db, blocked.id, { reason: 'made_up' }, 1), /reason must be/);
  assert.throws(() => markUnavailable(db, blocked.id, { reason: 'other_with_note' }, 1), /requires a note/);
});

test('guards: module gating and feed readiness', () => {
  const order2 = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('custom', 'Custom')").run().lastInsertRowid;
  db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, 'pitch_velocity_radar', 10)").run(order2);
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  const team = db.prepare('SELECT team_id FROM cmd_jobs WHERE id = ?').get(jobId).team_id;
  const job2 = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-22', ?)").run(baseball, team, order2).lastInsertRowid;
  assert.throws(() => createAttempt(db, job2, { attempt_type: 'steal', player_id: playerId }, 1), /not activated/);

  const badFeed = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status) VALUES (?, 'BH', 'k2', 'f2.mp4', 'processing')"
  ).run(jobId).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps) VALUES (?, 'proxy', 'p2', 60)").run(badFeed);
  const attempt = createAttempt(db, jobId, { attempt_type: 'steal', player_id: playerId, feed_id: badFeed }, 1);
  assert.throws(() => saveMeasurement(db, attempt.id, { start_frame: 1, end_frame: 50 }, 1), /requires a ready/);
});
