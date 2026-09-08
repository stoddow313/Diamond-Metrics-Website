// A synthetic (pipeline-test) job must never leave anything on a real player's
// profile — including values it released before it was flagged, and values
// withdrawn by code that predates the immediate resync. Boot reconciliation
// re-derives every job's rollups from what its release actually published.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-synthetic-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-synthetic-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { classifyReading } = await import('./radarImport.js');
const { decideResult, releaseMetrics, resyncPublishedRollups, backfillPublishedRollups } = await import('./releaseLogic.js');

let admin, team, baseball, pitcher;

function makeJob() {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, synthetic) VALUES ('rookie', 'Rookie', 0)").run().lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, code);
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-07-31', ?)").run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(job, 'customer', admin);
  return { job, order };
}
const setSynthetic = (order, on) => db.prepare('UPDATE cmd_orders SET synthetic = ? WHERE id = ?').run(on ? 1 : 0, order);
const publishReading = (job, velocity) => {
  const reading = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', ?, 'unmatched', ?)").run(job, velocity, admin).lastInsertRowid;
  classifyReading(db, reading, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id=? AND status='draft'").all(job)) decideResult(db, r.id, { decision: 'approved' }, admin);
  db.prepare("UPDATE cmd_jobs SET metric_release_status='approved' WHERE id=?").run(job);
  releaseMetrics(db, job, admin);
  return reading;
};
const profile = job => db.prepare('SELECT s.metric_key, s.value, s.method FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? ORDER BY s.metric_key').all(job);
const gameRows = job => db.prepare('SELECT COUNT(*) c FROM games WHERE command_job_id = ?').get(job).c;
const lastAudit = job => db.prepare("SELECT action, note FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? ORDER BY id DESC LIMIT 1").get(job);

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  pitcher = db.prepare("INSERT INTO players (first_name, last_name, slug, is_public) VALUES ('Field', 'Test', 'field-test', 1)").run().lastInsertRowid;
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
});

test('flagging a job synthetic after it released clears its values and its empty game row from the profile; unflagging brings them back', () => {
  const { job, order } = makeJob();
  publishReading(job, 80);
  assert.deepEqual(profile(job).map(e => [e.metric_key, e.value]), [['avg_velo', 80], ['max_velo', 80]]);

  setSynthetic(order, true);
  const r = resyncPublishedRollups(db, job, admin, 'marked synthetic');
  assert.equal(profile(job).length, 0, 'nothing left on the profile');
  assert.equal(gameRows(job), 0, 'the empty game row is gone too — no "recent activity" from a test job');
  assert.equal(r.gamesRemoved, 1);
  assert.match(lastAudit(job).note, /marked synthetic — .*max_velo 80→removed/);

  setSynthetic(order, false);
  resyncPublishedRollups(db, job, admin, 'unmarked synthetic');
  assert.deepEqual(profile(job).map(e => [e.metric_key, e.value]), [['avg_velo', 80], ['max_velo', 80]], 'published results republish when the flag comes off');
  assert.equal(gameRows(job), 1);
});

test('invalidating a reading on a synthetic job that released earlier withdraws the value from the profile (the prod job 3 case)', () => {
  const { job, order } = makeJob();
  const reading = publishReading(job, 80);
  setSynthetic(order, true);                       // flagged after release, resync never ran (old behaviour)
  assert.equal(profile(job).length, 2, 'stale values still on the profile before any correction');
  classifyReading(db, reading, { status: 'invalid', note: 'Wrong pitcher / player' }, admin);
  assert.equal(profile(job).length, 0, 'the correction clears the profile even though the job is synthetic');
  classifyReading(db, reading, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  assert.equal(profile(job).length, 0, 'restoring the reading does not republish a synthetic job');
});

test('boot reconciliation clears stale adapter-owned values, leaves manual stats alone, and is a no-op for healthy jobs', () => {
  const healthy = makeJob();
  publishReading(healthy.job, 78);
  const stale = makeJob();
  const reading = publishReading(stale.job, 88);
  // Old code withdrew the result without touching the profile: simulate that.
  db.prepare("UPDATE cmd_metric_results SET status = 'withdrawn' WHERE job_id = ?").run(stale.job);
  assert.equal(profile(stale.job).length, 2, 'stale values present');
  // A manually entered stat (method NULL) on the same game must survive.
  const gameId = db.prepare('SELECT id FROM games WHERE command_job_id = ?').get(stale.job).id;
  db.prepare("INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, 'bs_hr', 2)").run(gameId);

  const summary = backfillPublishedRollups(db);
  assert.ok(summary.jobs >= 2);
  assert.equal(profile(stale.job).map(e => e.metric_key).join(','), 'bs_hr', 'only the manual entry remains');
  assert.equal(gameRows(stale.job), 1, 'a normal job keeps its game row');
  assert.deepEqual(profile(healthy.job).map(e => [e.metric_key, e.value]), [['avg_velo', 78], ['max_velo', 78]], 'healthy job untouched');
  assert.equal(lastAudit(healthy.job).action !== 'published_rollups_resynced' || !/boot/.test(lastAudit(healthy.job).note), true, 'no audit noise for a job that did not change');

  const again = backfillPublishedRollups(db);
  assert.equal(again.entries_changed, 0, 'idempotent');
  assert.equal(again.games_removed, 0);
  void reading;
});
