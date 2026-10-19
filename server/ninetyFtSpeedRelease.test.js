// 90-ft speed (derived from home-to-first) reaches the profile. It used to
// have no profile key, so a release published the home-to-first time and left
// the derived speeds 'approved' forever; jobs released that way are caught up
// at boot, once, with the parent they derive from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-ninety-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { createAttempt, saveMeasurement } = await import('./measurementLogic.js');
const { decideResult, releaseMetrics, backfillPublishedRollups, computeQaFlags } = await import('./releaseLogic.js');
const { speedRollup } = await import('./metricRelease.js');
const { VALID_METRIC_KEYS } = await import('./metricCatalog.js');

let reviewer, sport, team;
before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Canyon')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  reviewer = db.prepare("INSERT INTO admins (email, password_hash, name, role) VALUES ('rev@t.t','x','Rev','reviewer')").run().lastInsertRowid;
  sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
});
after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// A Rookie job with one runner timed home-to-first twice (4.5 s and 5.0 s at 59.94 fps).
let n = 0;
function timedJob(codes = ['home_to_first', 'ninety_ft_speed']) {
  n += 1;
  const runner = db.prepare('INSERT INTO players (slug, first_name, last_name) VALUES (?, ?, ?)').run(`kyon-${n}`, 'Kyon', `Jones${n}`).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email) VALUES ('rookie','Rookie','coach@club.test')").run().lastInsertRowid;
  for (const c of codes) db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, c);
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, game_type, opponent_label, order_id) VALUES (?, ?, '2026-10-11', 'game', 'Vice', ?)").run(sport, team, order).lastInsertRowid;
  db.prepare("INSERT INTO cmd_consent (job_id, media_consent, sharing_scope) VALUES (?, 1, 'customer')").run(job);
  const feed = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps, duration_s) VALUES (?, 'BH', ?, 'g.mp4', 'ready', 1920, 1080, 59.94, 7200)").run(job, `k${n}`).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height) VALUES (?, 'proxy', ?, 59.94, 1920, 1080)").run(feed, `p${n}`);
  for (const [a, b] of [[1000, 1270], [5000, 5300]]) {
    const at = createAttempt(db, job, { attempt_type: 'home_to_first', player_id: runner, feed_id: feed }, reviewer);
    saveMeasurement(db, at.id, { start_frame: a, end_frame: b }, reviewer);
  }
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id = ? AND status = 'draft'").all(job)) decideResult(db, r.id, { decision: 'approved' }, reviewer);
  return { job, runner };
}
const entry = (job, runner, key) => db.prepare('SELECT s.* FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?').get(job, runner, key);
const statuses = (job, code) => db.prepare('SELECT status FROM cmd_metric_results WHERE job_id = ? AND metric_code = ? AND superseded_by IS NULL ORDER BY id').all(job, code).map(r => r.status);

test('90-ft speed has a profile key and publishes from the registry', () => {
  assert.ok(VALID_METRIC_KEYS.has('ninety_ft_speed'));
  const reg = db.prepare("SELECT publishes_to FROM cmd_metric_registry WHERE metric_code = 'ninety_ft_speed'").get();
  assert.deepEqual(JSON.parse(reg.publishes_to), ['ninety_ft_speed']);
  const roll = speedRollup([{ value: 13.62, status: 'approved' }, { value: 12.26, status: 'approved' }, { value: null, status: 'unavailable' }], { key: 'ninety_ft_speed' });
  assert.deepEqual(roll.entries, [{ metric_key: 'ninety_ft_speed', value: 13.6 }], 'the fastest publishes');
  assert.deepEqual([roll.sample.attempts, roll.sample.average, roll.sample.unavailable], [2, 12.9, 1]);
});

test('a release publishes the derived speeds with the home-to-first time', () => {
  const { job, runner } = timedJob();
  const { undelivered } = releaseMetrics(db, job, reviewer);
  assert.equal(entry(job, runner, 'home_to_first').value, 4.5);
  assert.equal(entry(job, runner, 'ninety_ft_speed').value, 13.6, '90 ft in 4.50 s');
  assert.ok(entry(job, runner, 'ninety_ft_speed').metric_result_id, 'provenance points at the fastest result');
  assert.deepEqual(statuses(job, 'ninety_ft_speed'), ['published', 'published'], 'no approved result is left behind');
  assert.deepEqual(undelivered, []);
});

test('a job released before the fix catches up at boot, once', () => {
  const { job, runner } = timedJob();
  // The old release: home-to-first published, the derived speeds skipped.
  db.prepare("UPDATE cmd_metric_results SET status = 'published' WHERE job_id = ? AND metric_code = 'home_to_first'").run(job);
  db.prepare("UPDATE cmd_jobs SET metric_release_status = 'released' WHERE id = ?").run(job);
  const g = db.prepare("INSERT INTO games (player_id, game_date, game_type, opponent, command_job_id) VALUES (?, '2026-10-11', 'game', 'Vice', ?)").run(runner, job).lastInsertRowid;
  db.prepare("INSERT INTO stat_entries (game_id, metric_key, value, method) VALUES (?, 'home_to_first', 4.5, 'frame_timed')").run(g);
  assert.equal(entry(job, runner, 'ninety_ft_speed'), undefined);

  const first = backfillPublishedRollups(db);
  assert.equal(first.derived_published, 2);
  assert.equal(entry(job, runner, 'ninety_ft_speed').value, 13.6, 'on the profile now');
  assert.deepEqual(statuses(job, 'ninety_ft_speed'), ['published', 'published']);
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table = 'cmd_metric_results' AND action = 'published' AND note LIKE '%catch-up%'").get(), 'audited');
  assert.equal(backfillPublishedRollups(db).derived_published, 0, 'idempotent');
});

test('the catch-up never publishes a speed whose time did not publish, or on a job not released', () => {
  const unreleased = timedJob();
  const withdrawn = timedJob();
  db.prepare("UPDATE cmd_jobs SET metric_release_status = 'released' WHERE id = ?").run(withdrawn.job);   // released, but its times stayed approved
  backfillPublishedRollups(db);
  assert.deepEqual(statuses(unreleased.job, 'ninety_ft_speed'), ['approved', 'approved']);
  assert.deepEqual(statuses(withdrawn.job, 'ninety_ft_speed'), ['approved', 'approved']);
  assert.equal(entry(withdrawn.job, withdrawn.runner, 'ninety_ft_speed'), undefined);
});

test('no home-to-first data: the derived speed raises no flag or notice of its own', () => {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email) VALUES ('rookie','Rookie','c@t.t')").run().lastInsertRowid;
  for (const c of ['home_to_first', 'ninety_ft_speed']) db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, c);
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, game_type, opponent_label, order_id) VALUES (?, ?, '2026-10-12', 'game', 'X', ?)").run(sport, team, order).lastInsertRowid;
  assert.ok(!computeQaFlags(db, job).some(f => /90-Foot/.test(f.label)));
  assert.deepEqual(releaseMetrics(db, job, reviewer).undelivered, ['home_to_first']);
});
