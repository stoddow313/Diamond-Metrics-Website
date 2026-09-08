// Phase 1 acceptance tests — one block per test in the V1 Developer Build
// Roadmap §7, in the roadmap's order and words. Each block states what it
// proves and, where a test depends on Phase 2 scorekeeping, says so
// explicitly (test.todo) instead of pretending.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-phase1-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-phase1-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { classifyReading, suggestMatches, parseRadarCsv } = await import('./radarImport.js');
const { createAttempt, saveMeasurement, reassignAttempt } = await import('./measurementLogic.js');
const { decideResult, releaseMetrics, computeQaFlags, releasePlan, resultForEvidence } = await import('./releaseLogic.js');
const { assessCapture, unavailableReasonFor, CAPTURE_SPECS } = await import('./captureSpec.js');
const { commandRoster, addJobGuest } = await import('./commandRoster.js');
const { validateGameRecordSource, releaseGameRecord } = await import('./gameRecord.js');

let admin, org, team, baseball, pitcher, runner, other;

function makeJob({ synthetic = 0, codes = PACKAGES.rookie.metric_codes, game_date = '2026-09-06', tournament_id = null } = {}) {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, synthetic) VALUES ('rookie', 'Rookie', ?)").run(synthetic).lastInsertRowid;
  for (const code of codes) {
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, ?, 1)').run(order, code, '');
  }
  const job = db.prepare('INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, tournament_id) VALUES (?, ?, ?, ?, ?)').run(baseball, team, game_date, order, tournament_id).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(job, 'customer', admin);
  return job;
}
function addFeed(job, { height = 1080, fps = 60, label = 'Behind Home', width = 1920 } = {}) {
  const id = db.prepare(
    "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps, nominal_fps, width, height, duration_s) VALUES (?, ?, 'k', ?, 'ready', ?, ?, ?, ?, 7200)"
  ).run(job, label, `${label.toLowerCase().replace(/\s+/g, '-')}.mp4`, fps, fps, width, height).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height, duration_s) VALUES (?, 'proxy', 'r', ?, ?, ?, 7200)").run(id, fps, Math.min(width, 1920), Math.min(height, 1080));
  return id;
}
const approveAll = job => { for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id=? AND status='draft'").all(job)) decideResult(db, r.id, { decision: 'approved' }, admin); };
const entry = (job, playerId, key) => db.prepare(
  'SELECT s.* FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?'
).get(job, playerId, key);
const addReading = (job, velocity, ts = '') => db.prepare(
  "INSERT INTO cmd_radar_readings (job_id, source, velocity, source_timestamp, status, created_by) VALUES (?, 'manual', ?, ?, 'unmatched', ?)"
).run(job, velocity, ts, admin).lastInsertRowid;

before(() => {
  org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  pitcher = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Pat', 'Pitcher', 'pat-pitcher')").run().lastInsertRowid;
  runner = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Rae', 'Runner', 'rae-runner')").run().lastInsertRowid;
  other = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Sam', 'Sub', 'sam-sub')").run().lastInsertRowid;
  for (const [pid, jersey] of [[pitcher, '7'], [runner, '21'], [other, '3']]) {
    db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, ?, '2026-01-01', '2026-12-31')").run(team, pid, jersey);
  }
});

after(() => {
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// §7.1 Clean Rookie: 1080p/60 behind-home feed plus Radar CSV; valid timing/radar outputs complete through metric release.
test('1. clean Rookie: 1080p60 feed + radar CSV → timing and radar results release to the profile with no handoff', () => {
  const job = makeJob();
  const feed = addFeed(job);
  const capture = assessCapture(db, job);
  assert.ok(capture.filter(c => c.status !== 'not_applicable').every(c => c.status === 'ok'), JSON.stringify(capture));

  const { rows } = parseRadarCsv('Time,Speed,Unit\n2026-09-06T15:00:03-06:00,78,MPH\n2026-09-06T15:00:18-06:00,81,MPH\n');
  assert.equal(rows.length, 2);
  const r1 = addReading(job, 78, rows[0].source_timestamp);
  const r2 = addReading(job, 81, rows[1].source_timestamp);
  classifyReading(db, r1, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  classifyReading(db, r2, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const attempt = createAttempt(db, job, { attempt_type: 'home_to_first', player_id: runner, feed_id: feed }, admin);
  saveMeasurement(db, attempt.id, { start_frame: 600, end_frame: 870 }, admin);   // 4.50 s at 60 fps
  approveAll(job);
  assert.ok(!computeQaFlags(db, job).some(f => f.level === 'blocking'));
  releaseMetrics(db, job, admin);
  assert.equal(entry(job, pitcher, 'max_velo').value, 81);
  assert.equal(entry(job, pitcher, 'avg_velo').value, 79.5);
  assert.equal(entry(job, runner, 'home_to_first').value, 4.5);
  // Every published value traces to a reviewed result with evidence.
  const r = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(entry(job, runner, 'home_to_first').metric_result_id);
  assert.equal(r.status, 'published');
  assert.equal(r.evidence_kind, 'measurement');
});

// §7.2 30-fps usable: timing is frame-timed at 30 fps; advanced side-angle metrics are unavailable.
test('2. 30-fps usable: timing measures at 30 fps with a warning; 120-fps side-angle metrics are unavailable with a structured reason', () => {
  const job = makeJob({ codes: [...PACKAGES.rookie.metric_codes, 'launch_angle_video'] });
  const feed = addFeed(job, { fps: 30 });
  const capture = assessCapture(db, job);
  const h2f = capture.find(c => c.metric_code === 'home_to_first');
  assert.equal(h2f.status, 'warning', 'timing is allowed, precision warning only');
  assert.ok(h2f.issues.some(i => i.code === 'frame_rate_below_preferred'));
  const la = capture.find(c => c.metric_code === 'launch_angle_video');
  assert.equal(la.status, 'blocked');
  assert.equal(unavailableReasonFor(la), 'insufficient_frame_rate');

  const attempt = createAttempt(db, job, { attempt_type: 'home_to_first', player_id: runner, feed_id: feed }, admin);
  const m = saveMeasurement(db, attempt.id, { start_frame: 300, end_frame: 435 }, admin);
  assert.equal(m.fps_used, 30);
  assert.ok(Math.abs(m.elapsed_s - 4.5) < 1e-9, 'frame-timed at the real rate');
});

// §7.3 Bad capture: affected metrics have structured unavailable reasons while other outputs continue.
test('3. bad capture: a 720p feed blocks timing with a reason and an audited override; radar releases regardless', () => {
  const job = makeJob();
  addFeed(job, { height: 720, width: 1280, fps: 30 });
  const capture = assessCapture(db, job);
  const h2f = capture.find(c => c.metric_code === 'home_to_first');
  assert.equal(h2f.status, 'blocked');
  assert.equal(unavailableReasonFor(h2f), 'insufficient_capture_quality');
  assert.equal(capture.find(c => c.metric_code === 'pitch_velocity_radar').status, 'ok', 'radar does not depend on video');
  const r = addReading(job, 74);
  classifyReading(db, r, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  approveAll(job);
  releaseMetrics(db, job, admin);
  assert.equal(entry(job, pitcher, 'max_velo').value, 74, 'the radar metric still publishes');
  assert.equal(entry(job, runner, 'home_to_first'), undefined, 'no fabricated time');
});

// §7.4 Pro multi-angle: unaligned behind-home plus 4K/120 side segments; advanced measurements use the eligible feed.
test('4. multi-angle: each metric selects its own eligible feed; the 4K/120 side angle qualifies for launch angle, the behind-home 1080p60 does not', () => {
  const job = makeJob({ codes: [...PACKAGES.rookie.metric_codes, 'launch_angle_video', 'exit_velocity_video'] });
  const behind = addFeed(job, { label: 'Behind Home', height: 1080, fps: 59.94 });
  const side = addFeed(job, { label: '1B Line', height: 2160, width: 3840, fps: 119.88 });
  db.prepare("UPDATE cmd_video_feeds SET manual_offset_s = 12.4 WHERE id = ?").run(side);   // unaligned start, recorded not guessed
  const capture = assessCapture(db, job);
  const la = capture.find(c => c.metric_code === 'launch_angle_video');
  assert.equal(la.status, 'ok');
  assert.equal(la.best_feed.id, side, 'launch angle picks the 120-fps side view');
  const h2f = capture.find(c => c.metric_code === 'home_to_first');
  assert.equal(h2f.status, 'ok');
  // A measurement records the feed it was taken from and that feed's real rate.
  const attempt = createAttempt(db, job, { attempt_type: 'home_to_first', player_id: runner, feed_id: side }, admin);
  const m = saveMeasurement(db, attempt.id, { start_frame: 0, end_frame: 540 }, admin);
  assert.ok(Math.abs(m.fps_used - 119.88) < 1e-9);
  assert.equal(db.prepare('SELECT selected_feed_id FROM cmd_events WHERE id = ?').get(attempt.id).selected_feed_id, side);
  // With only the behind-home feed, the advanced metric is unavailable with a frame-rate reason.
  db.prepare("UPDATE cmd_video_feeds SET status = 'failed' WHERE id = ?").run(side);
  const again = assessCapture(db, job).find(c => c.metric_code === 'launch_angle_video');
  assert.equal(again.status, 'blocked');
  assert.equal(again.best_feed.id, behind);
  assert.equal(unavailableReasonFor(again), 'insufficient_frame_rate');
  assert.ok(CAPTURE_SPECS.exit_velocity_video.min_fps === 120);
});

// §7.5 Radar ambiguity: operator confirms suggestions, invalidates noise, leaves uncertain rows unmatched.
test('5. radar ambiguity: suggestions follow confirmed neighbours in time or sequence, never publish by themselves, and uncertain rows stay unmatched', () => {
  const job = makeJob();
  const base = Date.parse('2026-09-06T15:00:00-06:00');
  const at = s => new Date(base + s * 1000).toISOString();
  const ids = [78, 81, 75, 110, 79].map((v, i) => addReading(job, v, at(i * 15)));
  // Analyst confirms the first pitch to the pitcher.
  classifyReading(db, ids[0], { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const readings = () => db.prepare(
    'SELECT r.*, p.first_name, p.last_name FROM cmd_radar_readings r LEFT JOIN players p ON p.id = r.player_id WHERE r.job_id = ? ORDER BY r.id'
  ).all(job);
  let sugg = suggestMatches(readings());
  assert.equal(sugg.get(ids[1]).player_id, pitcher, 'the next pitch 15 s later is suggested to the same pitcher');
  assert.equal(sugg.get(ids[1]).confidence, 'high');
  assert.match(sugg.get(ids[1]).reason, /15 s earlier/);
  assert.equal(sugg.get(ids[3]).confidence, 'high', '45 s away still high');
  // A suggestion creates no result until confirmed.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE job_id = ?").get(job).c, 1);
  // Confirming a suggestion is an ordinary classification.
  classifyReading(db, ids[1], { player_id: sugg.get(ids[1]).player_id, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  // Noise is invalidated with a reason; an uncertain row is left unmatched.
  classifyReading(db, ids[3], { status: 'invalid', note: 'car on the road' }, admin);
  sugg = suggestMatches(readings());
  assert.equal(sugg.has(ids[3]), false, 'invalid rows get no suggestion');
  assert.ok(sugg.has(ids[2]) && sugg.has(ids[4]), 'uncertain rows keep a suggestion but stay unmatched');
  const plan = releasePlan(db, job).plan.find(p => p.metric_code === 'pitch_velocity_radar');
  assert.equal(plan.results.length, 2, 'only confirmed readings are in the rollup');
  // Far-apart readings with no confirmed neighbour get nothing.
  const far = addReading(job, 70, at(3 * 3600));
  assert.equal(suggestMatches(readings()).has(far), false);
  // Sequence fallback when the file has no timestamps.
  const imp = db.prepare("INSERT INTO cmd_radar_imports (job_id, filename, file_hash, raw_content, row_count, created_by) VALUES (?, 'no-times.csv', 'h', 'raw', 3, ?)").run(job, admin).lastInsertRowid;
  const seq = [82, 83, 84].map((v, i) => db.prepare("INSERT INTO cmd_radar_readings (job_id, source, import_id, row_index, velocity, status, created_by) VALUES (?, 'csv_import', ?, ?, ?, 'unmatched', ?)").run(job, imp, i + 2, v, admin).lastInsertRowid);
  classifyReading(db, seq[0], { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  const s2 = suggestMatches(readings());
  assert.equal(s2.get(seq[1]).player_id, pitcher);
  assert.match(s2.get(seq[1]).reason, /1 row above/);
  assert.equal(s2.get(seq[1]).confidence, 'medium');
});

// §7.6 Full-game correction: changed defensive judgment recalculates dependent rollups without duplicates.
test.todo('6. full-game correction — needs Phase 2 scorebook events (defensive judgments); the recalculation mechanism is proven for metrics in resultLifecycle.test.js and will be reused');

// §7.7 Roster complexity: pinch/guest/courtesy runner, re-entry, pitcher substitution/inherited runners retain correct attribution.
test('7a. roster complexity (Phase 1 half): a courtesy or guest runner is timed against a placeholder and reassigned after the game without duplicates', () => {
  const job = makeJob();
  const feed = addFeed(job);
  const roster = commandRoster(db, job);
  assert.deepEqual(roster.map(p => p.jersey).sort(), ['21', '3', '7'], 'jerseys travel with the roster');
  assert.ok(roster.every(p => !p.is_guest));

  // Courtesy runner: a different roster player runs for the batter — attribution is simply the runner.
  const courtesy = createAttempt(db, job, { attempt_type: 'home_to_first', player_id: other, feed_id: feed }, admin);
  saveMeasurement(db, courtesy.id, { start_frame: 0, end_frame: 300 }, admin);
  assert.equal(resultForEvidence(db, 'measurement', db.prepare('SELECT id FROM cmd_measurements WHERE event_id=?').get(courtesy.id).id, 'home_to_first').player_id, other);

  // Unknown runner: a guest placeholder, not a guessed match.
  const guest = addJobGuest(db, job, { jersey: '44' }, admin);
  assert.equal(guest.first_name, '#44');
  assert.equal(db.prepare('SELECT is_public FROM players WHERE id = ?').get(guest.id).is_public, 0, 'placeholders never get a public profile');
  assert.ok(commandRoster(db, job).some(p => p.id === guest.id && p.is_guest === 1));
  const attempt = createAttempt(db, job, { attempt_type: 'steal', player_id: guest.id, feed_id: feed }, admin);
  saveMeasurement(db, attempt.id, { start_frame: 100, end_frame: 310 }, admin);
  const mid = db.prepare('SELECT id FROM cmd_measurements WHERE event_id = ?').get(attempt.id).id;
  const before = resultForEvidence(db, 'measurement', mid, 'steal_time');
  assert.equal(before.player_id, guest.id);
  assert.ok(computeQaFlags(db, job).some(f => f.code === 'guest_attribution' && f.level === 'warning'), 'the reviewer is told about the placeholder');

  // Post-game: the runner was #21 all along. Reassign; the same result follows.
  approveAll(job);
  releaseMetrics(db, job, admin);
  assert.ok(entry(job, guest.id, 'steal_time'), 'published to the placeholder row (non-public)');
  reassignAttempt(db, attempt.id, { player_id: runner }, admin);
  const after = resultForEvidence(db, 'measurement', mid, 'steal_time');
  assert.equal(after.id, before.id, 'same result row');
  assert.equal(after.player_id, runner);
  assert.equal(after.status, 'draft', 'a published value under a new name goes back to review');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_kind='measurement' AND evidence_id=? AND metric_code='steal_time'").get(mid).c, 1, 'no duplicate');
  assert.equal(entry(job, guest.id, 'steal_time'), undefined, 'the placeholder loses it immediately');
  assert.equal(db.prepare('SELECT player_id FROM cmd_events WHERE id = ?').get(attempt.id).player_id, runner);
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_events' AND target_id=? AND action='reassigned'").get(attempt.id));
  approveAll(job);
  releaseMetrics(db, job, admin);
  assert.ok(entry(job, runner, 'steal_time'));
  assert.ok(!computeQaFlags(db, job).some(f => f.code === 'guest_attribution'), 'no guest results remain');
});
test.todo('7b. roster complexity — pitcher substitution, inherited runners, re-entry need Phase 2 lineup and scorebook events');

// §7.8 Tournament batch: uploads map to correct games without duplicate entities; missing media is flagged.
test('8. tournament batch: bulk jobs are unique per game and team, and the footage report flags jobs with missing or failed media', () => {
  const tournament = db.prepare("INSERT INTO tournaments (name, slug, start_date, end_date) VALUES ('Fall Classic', 'fall-classic', '2026-09-12', '2026-09-13')").run().lastInsertRowid;
  const jobA = makeJob({ game_date: '2026-09-12', tournament_id: tournament });
  const jobB = makeJob({ game_date: '2026-09-12', tournament_id: tournament });
  const jobC = makeJob({ game_date: '2026-09-13', tournament_id: tournament });
  addFeed(jobA);
  const failed = addFeed(jobB);
  db.prepare("UPDATE cmd_video_feeds SET status = 'failed', error = 'proxy encode stalled' WHERE id = ?").run(failed);
  // Mirror of GET /api/command/tournaments/:id/footage
  const jobs = db.prepare('SELECT id FROM cmd_jobs WHERE tournament_id = ? ORDER BY id').all(tournament).map(j => j.id);
  const flagFor = jobId => {
    const fs = db.prepare('SELECT status FROM cmd_video_feeds WHERE job_id = ?').all(jobId);
    const ready = fs.filter(f => f.status === 'ready').length;
    const fail = fs.filter(f => ['failed', 'retrying'].includes(f.status)).length;
    return fs.length === 0 ? 'missing_footage' : (ready === 0 && fail > 0 ? 'failed_footage' : ready === 0 ? 'processing' : null);
  };
  assert.deepEqual(jobs.map(flagFor), [null, 'failed_footage', 'missing_footage']);
  // Duplicate protection: the bulk planner keys on (tournament_game, team); the content-hash dedupe on feeds keys on (job, hash, size).
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cmd_jobs WHERE tournament_id = ?').get(tournament).c, 3);
  assert.ok(jobC);
});

// §7.9 Two releases: reviewed metrics update the profile before scorebook completion; the validated game record later updates box score.
test('9a. two releases (metric half): metrics publish while the game record is still pending, and the customer is told the full review is pending', () => {
  const job = makeJob();
  addFeed(job);
  const r = addReading(job, 77);
  classifyReading(db, r, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  approveAll(job);
  releaseMetrics(db, job, admin);
  assert.equal(entry(job, pitcher, 'max_velo').value, 77);
  assert.equal(db.prepare('SELECT game_record_status FROM cmd_jobs WHERE id = ?').get(job).game_record_status, 'pending', 'independent track');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND s.metric_key LIKE 'bs_%'").get(job).c, 0, 'no box score yet');
});
test('9b. two releases (game-record half): a validated GameChanger record later publishes box-score statistics, labelled scorebook-derived, on its own track', () => {
  const job = makeJob();
  addFeed(job);
  const r = addReading(job, 80);
  classifyReading(db, r, { player_id: pitcher, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  approveAll(job);
  releaseMetrics(db, job, admin);
  assert.equal(entry(job, pitcher, 'max_velo').value, 80, 'metrics first');

  const csv = 'Number,Last,First,PA,AB,H,R,RBI,BB,SO\n7,Pitcher,Pat,4,3,2,1,1,1,0\n21,Runner,Rae,3,3,1,0,0,0,2\n,Totals,,7,6,3,1,1,1,2\n';
  const sourceId = db.prepare(
    "INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, created_by) VALUES (?, 'gamechanger_export', 'GC export', ?, ?)"
  ).run(job, csv, admin).lastInsertRowid;
  const v = validateGameRecordSource(db, sourceId, {}, admin);
  assert.equal(v.status, 'validated');
  const out = releaseGameRecord(db, job, admin);
  assert.equal(out.players, 2);
  assert.equal(entry(job, pitcher, 'bs_pa').value, 4);
  assert.equal(entry(job, pitcher, 'bs_pa').method, 'scorebook_derived');
  assert.equal(entry(job, runner, 'bs_k').value, 2);
  assert.equal(entry(job, pitcher, 'max_velo').method, 'radar_verified', 'measured and scorebook-derived stay distinguishable');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? AND action='game_record_released'").get(job).c, 1);
});
