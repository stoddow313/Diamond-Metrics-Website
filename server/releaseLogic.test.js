// Phase 1 acceptance (roadmap): a Rookie job goes from setup through radar
// confirmation, frame-timed measurement, review, and release — and verified
// numbers land on the existing profile path with provenance, with no CSV
// handoff. Unavailable never publishes, corrections supersede with history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-release-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const { classifyReading } = await import('./radarImport.js');
const { createAttempt, saveMeasurement, markUnavailable } = await import('./measurementLogic.js');
const { computeQaFlags, decideResult, releaseMetrics } = await import('./releaseLogic.js');

let jobId, pitcherId, runnerId, feedId, reviewerId;
let h2fAttemptId;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  pitcherId = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('ace', 'Ace', 'Arm')").run().lastInsertRowid;
  runnerId = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('jet', 'Jet', 'Legs')").run().lastInsertRowid;
  reviewerId = db.prepare("INSERT INTO admins (email, password_hash, name, role) VALUES ('rev@t.test', 'x', 'Rev', 'reviewer')").run().lastInsertRowid;

  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email) VALUES ('rookie', 'Rookie', 'parent@family.test')").run().lastInsertRowid;
  for (const code of ['pitch_velocity_radar', 'home_to_first', 'steal_time', 'ninety_ft_speed']) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)').run(order, code);
  }
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare(
    "INSERT INTO cmd_jobs (sport_id, team_id, game_date, game_type, opponent_label, order_id) VALUES (?, ?, '2026-08-20', 'game', 'Rivals', ?)"
  ).run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope) VALUES (?, 1, ?)').run(jobId, 'customer');
  feedId = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps) VALUES (?, 'BH', 'k', 'f.mp4', 'ready', 60)"
  ).run(jobId).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps) VALUES (?, 'proxy', 'p', 60)").run(feedId);
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const addReading = (velocity) => db.prepare(
  "INSERT INTO cmd_radar_readings (job_id, source, velocity, status) VALUES (?, 'manual', ?, 'unmatched')"
).run(jobId, velocity).lastInsertRowid;

const activeResults = () => db.prepare(
  "SELECT * FROM cmd_metric_results WHERE job_id = ? AND superseded_by IS NULL AND status != 'withdrawn' ORDER BY id"
).all(jobId);

test('QA flags gate the job: drafts and consent block, warnings inform', () => {
  // Two confirmed radar readings + one H2F measurement + one unavailable steal.
  for (const v of [68.2, 71.4]) {
    classifyReading(db, addReading(v), { player_id: pitcherId, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, reviewerId);
  }
  const h2f = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: runnerId, feed_id: feedId }, reviewerId);
  h2fAttemptId = h2f.id;
  saveMeasurement(db, h2fAttemptId, { start_frame: 60, end_frame: 332 }, reviewerId);   // 4.5333s — rounds to 4.53
  const steal = createAttempt(db, jobId, { attempt_type: 'steal', player_id: runnerId, feed_id: feedId }, reviewerId);
  markUnavailable(db, steal.id, { reason: 'runner_or_ball_obscured' }, reviewerId);

  let flags = computeQaFlags(db, jobId);
  assert.ok(flags.some(f => f.code === 'unreviewed_results' && f.level === 'blocking'), 'drafts must block approval');
  assert.ok(!flags.some(f => f.code === 'consent_missing'), 'consent is on record');
  assert.ok(!flags.some(f => f.code === 'no_contact_email'));

  // Approve everything reviewable; the blocking flag clears.
  for (const r of activeResults().filter(r => r.status === 'draft')) {
    decideResult(db, r.id, { decision: 'approved' }, reviewerId);
  }
  flags = computeQaFlags(db, jobId);
  assert.ok(!flags.some(f => f.level === 'blocking'), `no blocking flags after review: ${JSON.stringify(flags)}`);
});

test('release publishes approved rollups to games/stat_entries with provenance — unavailable never becomes zero', () => {
  const { published, undelivered } = releaseMetrics(db, jobId, reviewerId);

  // Pitcher: max + avg velocity. Runner: best home-to-first. Steal: nothing.
  const pitcherGame = db.prepare('SELECT * FROM games WHERE player_id = ? AND command_job_id = ?').get(pitcherId, jobId);
  const runnerGame = db.prepare('SELECT * FROM games WHERE player_id = ? AND command_job_id = ?').get(runnerId, jobId);
  assert.ok(pitcherGame && runnerGame, 'adapter creates one game per player per job');
  assert.equal(pitcherGame.game_date, '2026-08-20');
  assert.equal(pitcherGame.opponent, 'Rivals');

  const entry = (gameId, key) => db.prepare('SELECT * FROM stat_entries WHERE game_id = ? AND metric_key = ?').get(gameId, key);
  assert.equal(entry(pitcherGame.id, 'max_velo').value, 71.4);
  assert.equal(entry(pitcherGame.id, 'avg_velo').value, 69.8);
  assert.equal(entry(runnerGame.id, 'home_to_first').value, 4.53);
  assert.equal(entry(runnerGame.id, 'home_to_first').method, 'frame_timed');
  assert.equal(entry(pitcherGame.id, 'max_velo').method, 'radar_verified');
  assert.ok(entry(pitcherGame.id, 'max_velo').metric_result_id, 'max points at its source result');
  assert.ok(entry(runnerGame.id, 'home_to_first').metric_result_id, 'best points at its source result');

  // The unavailable steal publishes nothing — no row, no zero.
  assert.equal(entry(runnerGame.id, 'steal_time'), undefined);
  assert.ok(!published.some(p => p.value === 0), 'no zero ever publishes');
  assert.deepEqual(undelivered, ['steal_time']);

  // Paid-metric-unavailable notification recorded with the reason.
  const notif = db.prepare("SELECT * FROM cmd_notifications WHERE job_id = ? AND event_key = 'paid_metric_unavailable'").get(jobId);
  assert.ok(notif, 'customer notified of undeliverable paid metric');
  const payload = JSON.parse(notif.payload);
  assert.deepEqual(payload.metric_codes, ['steal_time']);
  assert.ok(payload.reasons.includes('runner_or_ball_obscured'));

  // Contributing results are now published.
  assert.ok(activeResults().filter(r => r.metric_code === 'pitch_velocity_radar').every(r => r.status === 'published'));
});

test('corrections supersede with history: remeasure updates the profile, chain retained, no duplicate entries', () => {
  // Reopen and remeasure the home-to-first: 4.53s → 4.50s.
  const priorPublished = activeResults().find(r => r.metric_code === 'home_to_first');
  assert.equal(priorPublished.status, 'published');
  saveMeasurement(db, h2fAttemptId, { start_frame: 60, end_frame: 330 }, reviewerId);   // 4.50s

  const old = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(priorPublished.id);
  assert.ok(old.superseded_by, 'published result superseded, not deleted');
  const replacement = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(old.superseded_by);
  assert.equal(replacement.status, 'draft');
  assert.equal(Number(replacement.value.toFixed(2)), 4.5);

  decideResult(db, replacement.id, { decision: 'approved' }, reviewerId);
  // Derived 90-ft speed re-drafted alongside — approve it too.
  for (const r of activeResults().filter(r => r.status === 'draft')) decideResult(db, r.id, { decision: 'approved' }, reviewerId);
  releaseMetrics(db, jobId, reviewerId);

  const runnerGame = db.prepare('SELECT * FROM games WHERE player_id = ? AND command_job_id = ?').get(runnerId, jobId);
  const rows = db.prepare("SELECT * FROM stat_entries WHERE game_id = ? AND metric_key = 'home_to_first'").all(runnerGame.id);
  assert.equal(rows.length, 1, 'correction updates in place — no duplicate entry');
  assert.equal(rows[0].value, 4.5);
  assert.equal(rows[0].metric_result_id, replacement.id);

  // Still exactly one paid-metric-unavailable notification (unchanged situation deduped).
  const notifs = db.prepare("SELECT COUNT(*) n FROM cmd_notifications WHERE job_id = ? AND event_key = 'paid_metric_unavailable'").get(jobId);
  assert.equal(notifs.n, 1);
});

test('a returned result drops out of the rollup; an all-unavailable metric releases nothing', () => {
  // Return the lower velocity reading — max stays, avg becomes the single reading.
  const velo = activeResults().filter(r => r.metric_code === 'pitch_velocity_radar');
  const low = velo.find(r => r.value === 68.2);
  // Published results must be corrected via supersede, not flipped directly.
  assert.throws(() => decideResult(db, low.id, { decision: 'draft' }, reviewerId), /correction/);

  // Withdraw via reclassification instead: the reading becomes invalid.
  const reading = db.prepare('SELECT evidence_id FROM cmd_metric_results WHERE id = ?').get(low.id);
  classifyReading(db, reading.evidence_id, { status: 'invalid', note: 'car radar noise' }, reviewerId);
  const withdrawn = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(low.id);
  assert.equal(withdrawn.status, 'withdrawn');

  releaseMetrics(db, jobId, reviewerId);
  const pitcherGame = db.prepare('SELECT * FROM games WHERE player_id = ? AND command_job_id = ?').get(pitcherId, jobId);
  const maxRow = db.prepare("SELECT * FROM stat_entries WHERE game_id = ? AND metric_key = 'max_velo'").get(pitcherGame.id);
  const avgRow = db.prepare("SELECT * FROM stat_entries WHERE game_id = ? AND metric_key = 'avg_velo'").get(pitcherGame.id);
  assert.equal(maxRow.value, 71.4);
  assert.equal(avgRow.value, 71.4, 'withdrawn reading leaves the average');
});
