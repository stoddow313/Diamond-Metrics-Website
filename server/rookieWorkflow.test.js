// Full Rookie analyst workflow, end to end, in one pass — the acceptance
// suite for the reported defects. Every stage is asserted against the
// database rather than the UI, so this is the contract the interface must
// keep. Each test names the guarantee it protects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-rookie-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { classifyReading } = await import('./radarImport.js');
const { createAttempt, saveMeasurement, markUnavailable } = await import('./measurementLogic.js');
const { computeQaFlags, decideResult, releaseMetrics, releasePlan } = await import('./releaseLogic.js');
const { assessCapture } = await import('./captureSpec.js');
const { velocityRollup, timingRollup } = await import('./metricRelease.js');

let jobId, pitcher, runner, reviewer, goodFeed;

const active = () => db.prepare(
  "SELECT * FROM cmd_metric_results WHERE job_id = ? AND superseded_by IS NULL AND status != 'withdrawn'"
).all(jobId);
const resultsFor = code => active().filter(r => r.metric_code === code);
const addReading = v => db.prepare(
  "INSERT INTO cmd_radar_readings (job_id, source, velocity, status) VALUES (?, 'manual', ?, 'unmatched')"
).run(jobId, v).lastInsertRowid;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Canyon')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon Athletics', 'canyon')").run(org).lastInsertRowid;
  pitcher = db.prepare("INSERT INTO players (slug, first_name, last_name, primary_position) VALUES ('ace','Ace','Arm','RHP')").run().lastInsertRowid;
  runner  = db.prepare("INSERT INTO players (slug, first_name, last_name, primary_position) VALUES ('jet','Jet','Legs','CF')").run().lastInsertRowid;
  reviewer = db.prepare("INSERT INTO admins (email, password_hash, name, role) VALUES ('rev@t.t','x','Rev','reviewer')").run().lastInsertRowid;

  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email) VALUES ('rookie','Rookie','coach@club.test')").run().lastInsertRowid;
  for (const c of ['pitch_velocity_radar', 'home_to_first', 'steal_time', 'ninety_ft_speed']) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, c);
  }
  const sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare(
    "INSERT INTO cmd_jobs (sport_id, team_id, game_date, game_type, opponent_label, order_id) VALUES (?,?,'2026-08-27','game','Chargers',?)"
  ).run(sport, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope) VALUES (?, 1, ?)').run(jobId, 'customer');
});
after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// ── capture QA ─────────────────────────────────────────────────────────────
test('1. an inadequate feed blocks the metrics that depend on it', () => {
  const bad = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps) VALUES (?, 'BH', 'k1', 'handheld-720.mp4', 'ready', 1280, 720, 60)"
  ).run(jobId).lastInsertRowid;
  const h2f = assessCapture(db, jobId).find(a => a.metric_code === 'home_to_first');
  assert.equal(h2f.status, 'blocked', '720p cannot satisfy Rookie timing');
  assert.ok(computeQaFlags(db, jobId).some(f => f.level === 'blocking' && f.code === 'capture_home_to_first'));

  // Radar never depended on the video and must stay unaffected.
  assert.equal(assessCapture(db, jobId).find(a => a.metric_code === 'pitch_velocity_radar').status, 'ok');
  db.prepare('DELETE FROM cmd_video_feeds WHERE id = ?').run(bad);
});

test('2. an adequate 1080p feed satisfies capture and clears the block', () => {
  goodFeed = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps, duration_s) VALUES (?, 'Behind Home', 'k2', 'game-1080p60.mp4', 'ready', 1920, 1080, 59.94, 7200)"
  ).run(jobId).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height) VALUES (?, 'proxy', 'p2', 59.94, 1920, 1080)").run(goodFeed);
  assert.equal(assessCapture(db, jobId).find(a => a.metric_code === 'home_to_first').status, 'ok');
  assert.ok(!computeQaFlags(db, jobId).some(f => f.level === 'blocking' && /^capture_/.test(f.code)));
});

// ── radar queue ────────────────────────────────────────────────────────────
test('3. radar: invalid readings are audited and excluded from every rollup', () => {
  const ids = {};
  for (const v of [78, 81, 75, 110]) {
    ids[v] = addReading(v);
    classifyReading(db, ids[v], { player_id: pitcher, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, reviewer);
  }
  assert.equal(resultsFor('pitch_velocity_radar').length, 4);

  classifyReading(db, ids[110], { status: 'invalid', note: 'car radar noise' }, reviewer);

  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(ids[110]);
  assert.equal(reading.status, 'invalid', 'status changes immediately');
  assert.equal(reading.velocity, 110, 'the reading itself is preserved for audit');
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_radar_readings' AND target_id=?").get(ids[110]),
    'and the decision is on the audit trail');

  const values = resultsFor('pitch_velocity_radar').map(r => r.value).sort((a, b) => a - b);
  assert.deepEqual(values, [75, 78, 81], '110 leaves the result set entirely');
  const roll = velocityRollup(resultsFor('pitch_velocity_radar').map(r => ({ ...r, status: 'approved' })), { maxKey: 'max_velo', avgKey: 'avg_velo' });
  assert.deepEqual(
    { max: roll.sample.max, avg: roll.sample.average, min: roll.sample.min, n: roll.sample.valid_readings },
    { max: 81, avg: 78, min: 75, n: 3 },
    'rollup reflects only the valid readings',
  );
});

test('4. a restored reading rejoins the rollup', () => {
  const invalid = db.prepare("SELECT id FROM cmd_radar_readings WHERE job_id=? AND status='invalid'").get(jobId).id;
  classifyReading(db, invalid, { player_id: pitcher, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, reviewer);
  assert.equal(resultsFor('pitch_velocity_radar').length, 4);
  classifyReading(db, invalid, { status: 'invalid', note: 'car radar noise' }, reviewer);   // back to invalid
  assert.equal(resultsFor('pitch_velocity_radar').length, 3);
});

// ── timing ─────────────────────────────────────────────────────────────────
test('5. timing: best publishes, average rides along, unavailable never averages', () => {
  const a1 = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: runner, feed_id: goodFeed }, reviewer);
  saveMeasurement(db, a1.id, { start_frame: 1000, end_frame: 1270 }, reviewer);   // 270 / 59.94 = 4.505
  const a2 = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: runner, feed_id: goodFeed }, reviewer);
  saveMeasurement(db, a2.id, { start_frame: 5000, end_frame: 5300 }, reviewer);   // 300 / 59.94 = 5.005
  const a3 = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: runner, feed_id: goodFeed }, reviewer);
  markUnavailable(db, a3.id, { reason: 'runner_or_ball_obscured' }, reviewer);

  const timed = resultsFor('home_to_first');
  const roll = timingRollup(timed.map(r => ({ ...r, status: r.status === 'unavailable' ? 'unavailable' : 'approved' })), { key: 'home_to_first' });
  assert.equal(roll.entries[0].value, 4.5, 'the best attempt is what publishes');
  assert.equal(roll.sample.attempts, 2, 'the unavailable attempt is not an attempt in the average');
  assert.equal(roll.sample.average, 4.75);   // (4.5045 + 5.0050) / 2
  assert.equal(roll.sample.unavailable, 1, 'but it is counted and visible');

  // 90-ft speed derives only from a valid home-to-first.
  assert.equal(resultsFor('ninety_ft_speed').length, 2);
});

test('6. steal timing is independent of outcome', () => {
  const s1 = createAttempt(db, jobId, { attempt_type: 'steal', player_id: runner, feed_id: goodFeed, outcome: 'out' }, reviewer);
  saveMeasurement(db, s1.id, { start_frame: 9000, end_frame: 9200 }, reviewer);   // caught stealing still times
  const steals = resultsFor('steal_time');
  assert.equal(steals.length, 1);
  assert.ok(Math.abs(steals[0].value - 200 / 59.94) < 0.001);
});

// ── review + release ───────────────────────────────────────────────────────
test('7. a draft result cannot reach a profile — the central guarantee', () => {
  assert.ok(active().some(r => r.status === 'draft'), 'there are drafts on the job');
  const plan = releasePlan(db, jobId);
  assert.ok(plan.plan.every(p => !p.rollup.released), 'nothing is releasable while unreviewed');
  assert.ok(computeQaFlags(db, jobId).some(f => f.level === 'blocking' && f.code === 'unreviewed_results'),
    'and approval is blocked until every draft is decided');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM games WHERE command_job_id = ?').get(jobId).n, 0,
    'no profile row exists yet');
});

test('8. approval clears the gate and release publishes exactly the approved rollups', () => {
  for (const r of active().filter(r => r.status === 'draft')) decideResult(db, r.id, { decision: 'approved' }, reviewer);
  assert.ok(!computeQaFlags(db, jobId).some(f => f.level === 'blocking'), 'gate is clear');

  const { published, undelivered } = releaseMetrics(db, jobId, reviewer);
  const pg = db.prepare('SELECT id FROM games WHERE player_id = ? AND command_job_id = ?').get(pitcher, jobId);
  const rg = db.prepare('SELECT id FROM games WHERE player_id = ? AND command_job_id = ?').get(runner, jobId);
  const entry = (g, k) => db.prepare('SELECT * FROM stat_entries WHERE game_id = ? AND metric_key = ?').get(g, k);

  assert.equal(entry(pg.id, 'max_velo').value, 81);
  assert.equal(entry(pg.id, 'avg_velo').value, 78);
  assert.equal(entry(rg.id, 'home_to_first').value, 4.5);
  assert.ok(entry(rg.id, 'steal_time'), 'the timed steal publishes');
  assert.ok(!published.some(p => p.value === 0), 'no zero is ever published');
  assert.deepEqual(undelivered, [], 'every ordered metric delivered something');
  assert.ok(entry(rg.id, 'home_to_first').metric_result_id, 'provenance points at the source result');
});

test('9. published state is visible and a correction supersedes with history', () => {
  assert.ok(active().filter(r => r.metric_code === 'home_to_first').some(r => r.status === 'published'));

  const attempt = db.prepare("SELECT id FROM cmd_events WHERE job_id=? AND player_id=? ORDER BY id LIMIT 1").get(jobId, runner).id;
  saveMeasurement(db, attempt, { start_frame: 1000, end_frame: 1240 }, reviewer);   // 240/59.94 = 4.004
  const superseded = db.prepare("SELECT * FROM cmd_metric_results WHERE job_id=? AND superseded_by IS NOT NULL").all(jobId);
  assert.ok(superseded.length > 0, 'the published value is superseded, never deleted');

  for (const r of active().filter(r => r.status === 'draft')) decideResult(db, r.id, { decision: 'approved' }, reviewer);
  releaseMetrics(db, jobId, reviewer);
  const rg = db.prepare('SELECT id FROM games WHERE player_id = ? AND command_job_id = ?').get(runner, jobId);
  const rows = db.prepare("SELECT * FROM stat_entries WHERE game_id=? AND metric_key='home_to_first'").all(rg.id);
  assert.equal(rows.length, 1, 'the correction updates in place, no duplicate');
  assert.equal(rows[0].value, 4, 'and the profile now shows the corrected best');
});

test('10. the audit trail can reconstruct every decision on the job', () => {
  const actions = db.prepare(
    "SELECT action, COUNT(*) n FROM cmd_review_actions WHERE (target_table='cmd_jobs' AND target_id=?) OR target_table IN ('cmd_radar_readings','cmd_metric_results','cmd_events') GROUP BY action"
  ).all(jobId);
  const kinds = actions.map(a => a.action);
  for (const required of ['classified', 'reviewed', 'created', 'metrics_released']) {
    assert.ok(kinds.includes(required), `audit trail records "${required}"`);
  }
});
