// Correction flow: one raw reading or measurement ↔ one derived metric
// result. Invalidating withdraws that result and removes it from the
// player's profile and rollups immediately; restoring revives the very same
// row to where it was. Nothing is deleted, nothing is duplicated, every step
// is idempotent and audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-lifecycle-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-lifecycle-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { classifyReading } = await import('./radarImport.js');
const { decideResult, releaseMetrics, resyncPublishedRollups, resultForEvidence } = await import('./releaseLogic.js');
const { createAttempt, saveMeasurement, markUnavailable } = await import('./measurementLogic.js');

let admin, team, baseball, pitcher, runner, jobId, feedId;

function makeJob({ synthetic = 0 } = {}) {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, synthetic) VALUES ('rookie', 'Rookie', ?)").run(synthetic).lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, ?, 1)').run(order, code, '');
  }
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-31', ?)").run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(job, 'customer', admin);
  return job;
}
const addReading = (job, velocity) => db.prepare(
  "INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', ?, 'unmatched', ?)"
).run(job, velocity, admin).lastInsertRowid;
const resultOf = readingId => resultForEvidence(db, 'radar_reading', readingId);
const resultsOf = readingId => db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_kind='radar_reading' AND evidence_id=? ORDER BY id").all(readingId);
const approveDrafts = job => {
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id=? AND status='draft'").all(job)) decideResult(db, r.id, { decision: 'approved' }, admin);
};
const entry = (job, playerId, key) => db.prepare(
  'SELECT s.* FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?'
).get(job, playerId, key);
const audits = (table, id) => db.prepare('SELECT action, note, prev_state, new_state FROM cmd_review_actions WHERE target_table=? AND target_id=? ORDER BY id').all(table, id);

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  pitcher = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Pat', 'Pitcher', 'pat-pitcher')").run().lastInsertRowid;
  runner = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Rae', 'Runner', 'rae-runner')").run().lastInsertRowid;
  jobId = makeJob();
  feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps, nominal_fps, width, height, duration_s) VALUES (?, 'BH', 'k', 'f.mp4', 'ready', 60, 60, 1920, 1080, 120)"
  ).run(jobId).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height, duration_s) VALUES (?, 'proxy', 'r', 60, 1920, 1080, 120)").run(feedId);
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
});

let r78, r81;

test('invalidating a published radar reading withdraws its one result and leaves the profile immediately', () => {
  r78 = addReading(jobId, 78);
  r81 = addReading(jobId, 81);
  classifyReading(db, r78, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  classifyReading(db, r81, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  approveDrafts(jobId);
  releaseMetrics(db, jobId, admin);
  assert.equal(entry(jobId, pitcher, 'max_velo').value, 81);
  assert.equal(entry(jobId, pitcher, 'avg_velo').value, 79.5);
  const published = resultOf(r81);
  assert.equal(published.status, 'published');

  classifyReading(db, r81, { status: 'invalid', note: 'gun misread — car on the road' }, admin);

  const rows = resultsOf(r81);
  assert.equal(rows.length, 1, 'still exactly one result for the reading');
  assert.equal(rows[0].id, published.id, 'the same row');
  assert.equal(rows[0].status, 'withdrawn');
  assert.equal(rows[0].restore_status, 'published', 'it remembers what it was');
  // Profile + rollups updated NOW — no re-release needed.
  assert.equal(entry(jobId, pitcher, 'max_velo').value, 78);
  assert.equal(entry(jobId, pitcher, 'avg_velo').value, 78);
  // Raw reading and the reason survive in the audit history.
  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id=?').get(r81);
  assert.equal(reading.velocity, 81);
  assert.equal(reading.status, 'invalid');
  assert.match(reading.note, /gun misread/);
  const withdrawn = audits('cmd_metric_results', published.id).find(a => a.action === 'withdrawn');
  assert.match(withdrawn.note, /gun misread/);
  assert.equal(withdrawn.prev_state, 'published');
  const resync = audits('cmd_jobs', jobId).filter(a => a.action === 'published_rollups_resynced').at(-1);
  assert.match(resync.note, /max_velo 81→78/);
});

test('restoring the reading revives the same result to its prior status and rollups; repeating is a no-op', () => {
  const before = resultOf(r81);
  classifyReading(db, r81, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const after = resultOf(r81);
  assert.equal(after.id, before.id);
  assert.equal(after.status, 'published', 'revived straight back to published — the value was already reviewed');
  assert.equal(after.restore_status, null);
  assert.equal(after.player_id, pitcher);
  assert.equal(resultsOf(r81).length, 1, 'no second result, no duplicate');
  assert.equal(entry(jobId, pitcher, 'max_velo').value, 81, 'profile restored immediately');
  assert.equal(entry(jobId, pitcher, 'avg_velo').value, 79.5);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id=s.game_id WHERE g.command_job_id=? AND g.player_id=? AND s.metric_key='max_velo'").get(jobId, pitcher).c, 1, 'one profile entry');

  // Idempotent: the same confirmation again changes nothing and audits nothing new on the result.
  const auditCount = audits('cmd_metric_results', before.id).length;
  classifyReading(db, r81, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  assert.equal(resultsOf(r81).length, 1);
  assert.equal(resultOf(r81).status, 'published');
  assert.equal(audits('cmd_metric_results', before.id).length, auditCount);
  assert.equal(entry(jobId, pitcher, 'max_velo').value, 81);
});

test('reassigning a published reading updates the same row as a draft and drops it from the first player at once', () => {
  const before = resultOf(r81);
  classifyReading(db, r81, { player_id: runner, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const after = resultOf(r81);
  assert.equal(after.id, before.id);
  assert.equal(after.player_id, runner);
  assert.equal(after.status, 'draft', 'a new player assignment needs review again');
  assert.equal(resultsOf(r81).length, 1);
  assert.equal(entry(jobId, pitcher, 'max_velo').value, 78, 'pitcher loses it immediately');
  assert.equal(entry(jobId, runner, 'max_velo'), undefined, 'runner gets nothing until approve + release');
  assert.ok(audits('cmd_metric_results', before.id).some(a => a.action === 'reassigned' && a.prev_state === 'published' && a.new_state === 'draft'));

  approveDrafts(jobId);
  releaseMetrics(db, jobId, admin);
  assert.equal(entry(jobId, runner, 'max_velo').value, 81);
  assert.equal(resultsOf(r81).length, 1);
});

test('a draft result is withdrawn and revived on the same row too', () => {
  const r75 = addReading(jobId, 75);
  classifyReading(db, r75, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const draft = resultOf(r75);
  assert.equal(draft.status, 'draft');
  classifyReading(db, r75, { status: 'invalid', note: 'duplicate row' }, admin);
  assert.deepEqual(resultsOf(r75).map(r => [r.id, r.status, r.restore_status]), [[draft.id, 'withdrawn', 'draft']]);
  classifyReading(db, r75, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  assert.deepEqual(resultsOf(r75).map(r => [r.id, r.status]), [[draft.id, 'draft']]);
  // Approved-but-unreleased never leaks onto the profile through a resync.
  decideResult(db, draft.id, { decision: 'approved' }, admin);
  resyncPublishedRollups(db, jobId, admin, 'test');
  assert.equal(entry(jobId, pitcher, 'avg_velo').value, 78, 'the approved 75 waits for the release');
});

test('timing: an unavailable mark pulls the published time from the profile; a new measurement revives on the same rows', () => {
  const attempt = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: runner, feed_id: feedId }, admin);
  const m = saveMeasurement(db, attempt.id, { start_frame: 60, end_frame: 330 }, admin);   // 4.50 s
  const timed = resultForEvidence(db, 'measurement', m.id, 'home_to_first');
  const derived = resultForEvidence(db, 'measurement', m.id, 'ninety_ft_speed');
  assert.ok(timed && derived);
  approveDrafts(jobId);
  releaseMetrics(db, jobId, admin);
  assert.equal(entry(jobId, runner, 'home_to_first').value, 4.5);
  assert.equal(resultForEvidence(db, 'measurement', m.id, 'home_to_first').status, 'published');

  markUnavailable(db, attempt.id, { reason: 'base_not_visible', note: 'first base out of frame' }, admin);
  const t2 = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(timed.id);
  const d2 = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(derived.id);
  assert.equal(t2.status, 'unavailable', 'same row, now unavailable');
  assert.equal(t2.unavailable_reason, 'base_not_visible');
  assert.equal(t2.value, null);
  assert.equal(d2.status, 'withdrawn', 'nothing to derive from');
  assert.equal(entry(jobId, runner, 'home_to_first'), undefined, 'gone from the profile immediately');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_kind='measurement' AND evidence_id=?").get(m.id).c, 2, 'no extra rows');
  assert.match(audits('cmd_metric_results', timed.id).at(-1).note, /first base out of frame/);

  // Measure again — same rows come back, as drafts (the frames are new evidence), never a third row.
  saveMeasurement(db, attempt.id, { start_frame: 60, end_frame: 330 }, admin);
  const t3 = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(timed.id);
  const d3 = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(derived.id);
  assert.equal(t3.status, 'draft');
  assert.ok(Math.abs(t3.value - 4.5) < 1e-9);
  assert.equal(d3.status, 'draft', 'derived never outranks its parent');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_kind='measurement' AND evidence_id=?").get(m.id).c, 2);
  approveDrafts(jobId);
  releaseMetrics(db, jobId, admin);
  assert.equal(entry(jobId, runner, 'home_to_first').value, 4.5, 'back on the profile after review');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id=s.game_id WHERE g.command_job_id=? AND g.player_id=? AND s.metric_key='home_to_first'").get(jobId, runner).c, 1);
});

test('legacy supersede chains: re-confirming revives the withdrawn head instead of inserting a third row', () => {
  const reading = addReading(jobId, 84);
  const a = db.prepare(
    `INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, evidence_kind, evidence_id, calculation_version)
     VALUES (?, 'pitch_velocity_radar', ?, 84, 'mph', 'radar_verified', 'published', 'radar_reading', ?, 'CMD_V1')`
  ).run(jobId, pitcher, reading).lastInsertRowid;
  const b = db.prepare(
    `INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, restore_status, evidence_kind, evidence_id, calculation_version)
     VALUES (?, 'pitch_velocity_radar', ?, 84, 'mph', 'radar_verified', 'withdrawn', 'published', 'radar_reading', ?, 'CMD_V1')`
  ).run(jobId, pitcher, reading).lastInsertRowid;
  db.prepare('UPDATE cmd_metric_results SET superseded_by = ? WHERE id = ?').run(b, a);
  db.prepare("UPDATE cmd_radar_readings SET status='invalid' WHERE id = ?").run(reading);

  classifyReading(db, reading, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const rows = db.prepare('SELECT * FROM cmd_metric_results WHERE evidence_id = ? ORDER BY id').all(reading);
  assert.equal(rows.length, 2, 'no third row');
  assert.equal(rows.find(r => r.id === b).status, 'published', 'the chain head is revived');
  assert.equal(rows.find(r => r.id === a).superseded_by, b, 'legacy history untouched');
});

test('synthetic jobs: withdraw and restore run the workflow but never touch profiles', () => {
  const sJob = makeJob({ synthetic: 1 });
  const r = addReading(sJob, 79);
  classifyReading(db, r, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  approveDrafts(sJob);
  releaseMetrics(db, sJob, admin);
  classifyReading(db, r, { status: 'invalid', note: 'test' }, admin);
  classifyReading(db, r, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  assert.equal(resultsOf(r).length, 1);
  assert.equal(resultOf(r).status, 'published');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM games WHERE command_job_id = ?').get(sJob).c, 0);
  assert.deepEqual(resyncPublishedRollups(db, sJob, admin, 'test'), { changes: [], synthetic: true });
});
