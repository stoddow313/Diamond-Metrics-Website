// The expanded Rookie package (2026-10): pitcher time to home, frame-timed
// like home-to-first and published as the game's average delivery; and the
// spray chart — a landing spot placed for each batted ball, classified pull /
// middle / oppo by angle and the batter's side, published with the game
// record as shares, a count and the dots themselves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-rookie-expansion-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-rookie-expansion-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES, addableMetrics } = await import('./commandLogic.js');
const { createAttempt, saveMeasurement } = await import('./measurementLogic.js');
const { decideResult, releaseMetrics, computeQaFlags } = await import('./releaseLogic.js');
const { assessCapture } = await import('./captureSpec.js');
const { appendEvent, appendPlateAppearance, correctEvent, replayJob, sprayZone, battingSide, validatePayload } = await import('./scorebook.js');
const { releaseGameRecord } = await import('./gameRecord.js');

let admin, sport, team, pitcher, righty, lefty, switcher;
before(() => {
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Huskers')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Huskers', 'huskers-x')").run(org).lastInsertRowid;
  const player = (first, bats, throws = 'R') => {
    const id = db.prepare('INSERT INTO players (first_name, last_name, slug, bats, throws) VALUES (?, ?, ?, ?, ?)').run(first, 'P', `${first.toLowerCase()}-p`, bats, throws).lastInsertRowid;
    db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '1', '2026-01-01', '2026-12-31')").run(team, id);
    return id;
  };
  pitcher = player('Reagan', 'R'); righty = player('Rory', 'R'); lefty = player('Lefty', 'L'); switcher = player('Sam', 'S');
});
after(() => {
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

function job(codes = PACKAGES.rookie.metric_codes) {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const c of codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, c);
  const j = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-10-10', ?, 'Vice')").run(sport, team, order).lastInsertRowid;
  db.prepare("INSERT INTO cmd_consent (job_id, media_consent, sharing_scope) VALUES (?, 1, 'customer')").run(j);
  return j;
}

test('the Rookie package now orders time to home and the spray chart', () => {
  assert.deepEqual(PACKAGES.rookie.metric_codes.slice(-2), ['time_to_home', 'spray_direction']);
  const reg = Object.fromEntries(db.prepare("SELECT metric_code, active, publishes_to FROM cmd_metric_registry WHERE metric_code IN ('time_to_home','spray_direction')").all().map(r => [r.metric_code, r]));
  assert.deepEqual([reg.time_to_home.active, JSON.parse(reg.time_to_home.publishes_to)], [1, ['time_to_home']]);
  assert.deepEqual([reg.spray_direction.active, JSON.parse(reg.spray_direction.publishes_to)], [1, []], 'spray publishes with the game record, not as metric results');
});

test('a Rookie job made before the expansion can add the two new metrics, and nothing outside its package', () => {
  const registry = db.prepare('SELECT * FROM cmd_metric_registry').all();
  const before = PACKAGES.rookie.metric_codes.filter(c => !['time_to_home', 'spray_direction'].includes(c));
  assert.deepEqual(addableMetrics('rookie', before, registry).map(m => m.metric_code), ['time_to_home', 'spray_direction']);
  assert.deepEqual(addableMetrics('rookie', PACKAGES.rookie.metric_codes, registry), []);
});

test('time to home: frame-timed for the pitcher, 30 fps warns, the game average publishes', () => {
  const j = job();
  const feed = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps, duration_s) VALUES (?, 'BH', 'k-tth', 'g.mp4', 'ready', 1920, 1080, 29.97, 7200)").run(j).lastInsertRowid;
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key, fps, width, height) VALUES (?, 'proxy', 'p-tth', 29.97, 1920, 1080)").run(feed);
  assert.equal(assessCapture(db, j).find(a => a.metric_code === 'time_to_home').status, 'warning', '1080p/30 is measurable for Rookie timing');
  for (const [a, b] of [[1000, 1039], [2000, 2042]]) {   // 39 and 42 frames: 1.301 s and 1.401 s
    const at = createAttempt(db, j, { attempt_type: 'time_to_home', player_id: pitcher, feed_id: feed }, admin);
    saveMeasurement(db, at.id, { start_frame: a, end_frame: b }, admin);
  }
  const results = db.prepare("SELECT * FROM cmd_metric_results WHERE job_id = ? AND metric_code = 'time_to_home'").all(j);
  assert.equal(results.length, 2);
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id = ? AND status = 'draft'").all(j)) decideResult(db, r.id, { decision: 'approved' }, admin);
  assert.ok(computeQaFlags(db, j).some(f => /Home-to-First Time: no results/.test(f.label)), 'other ordered timing still flags as missing');
  assert.ok(!computeQaFlags(db, j).some(f => /Spray Chart/.test(f.label)), 'the spray chart rides the game record — no metric-result flag');
  releaseMetrics(db, j, admin);
  const entry = db.prepare("SELECT s.value FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = 'time_to_home'").get(j, pitcher);
  assert.equal(entry.value, 1.35, 'the average of 1.30 and 1.40');
  const other = job(['home_to_first']);
  assert.throws(() => createAttempt(db, other, { attempt_type: 'time_to_home', player_id: pitcher }, admin), /not activated on this order/);
});

test('spray zones come from the landing angle and the side the batter hit from', () => {
  const left = { x: -0.6, y: 0.7 }, center = { x: 0.05, y: 0.9 }, right = { x: 0.6, y: 0.7 };
  assert.deepEqual([sprayZone(left, 'R'), sprayZone(center, 'R'), sprayZone(right, 'R')], ['pull', 'middle', 'oppo']);
  assert.deepEqual([sprayZone(left, 'L'), sprayZone(right, 'L')], ['oppo', 'pull']);
  assert.equal(battingSide(left, { bats: 'L' }, null), 'L');
  assert.equal(battingSide(left, { bats: 'S' }, { throws: 'R' }), 'L', 'a switch hitter bats left against a righty');
  assert.equal(battingSide(left, { bats: 'S' }, { throws: 'L' }), 'R');
  assert.equal(battingSide({ ...left, side: 'R' }, { bats: 'S' }, { throws: 'R' }), 'R', 'the scorer’s pick wins');
  assert.equal(battingSide(left, null, null), 'R');
  assert.throws(() => validatePayload('plate_appearance', { result: 'strikeout', spray: left }), /ball in play/);
  assert.throws(() => validatePayload('plate_appearance', { result: 'single', spray: { x: 'a', y: 1 } }), /landing spot/);
  validatePayload('plate_appearance', { result: 'groundout', spray: { ...left, side: 'L' } });
});

test('the spray chart publishes with the game record: shares, count and the dots; a moved dot follows', () => {
  const j = job();
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'us', us_is_home: false, slots: [righty, lefty, switcher].map((id, i) => ({ slot: i + 1, player_id: id, label: `p${i}`, position: ['SS', 'CF', '2B'][i] })), pitcher_player_id: pitcher } }, admin);
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'them', slots: [{ slot: 1, label: '#1', position: 'P' }], pitcher_label: '#1' } }, admin);
  const pa = (result, spray) => appendPlateAppearance(db, j, { pa: { result, ...(spray ? { spray } : {}) }, pitches: [{ result: result === 'strikeout' ? 'swinging_strike' : 'in_play' }] }, admin);
  pa('single', { x: -0.5, y: 0.8 });     // Rory (R): left field → pull
  pa('groundout', { x: -0.3, y: 0.3 });  // Lefty (L): left side → oppo
  pa('flyout', { x: 0.1, y: 1.0 });      // Sam (S) vs an unknown arm → bats L; center → middle
  pa('single', { x: 0.55, y: 0.6 });     // Rory: right field → oppo
  pa('strikeout');                       // no ball in play, no dot
  pa('single');                          // Sam: in play, no spot placed — not charted
  const rp = replayJob(db, j);
  const t = id => rp.tallies.find(x => x.player_id === id);
  assert.deepEqual(t(righty).spray, { pull: 1, middle: 0, oppo: 1 });
  assert.deepEqual(t(lefty).spray, { pull: 0, middle: 0, oppo: 1 });
  assert.deepEqual(t(switcher).spray, { pull: 0, middle: 1, oppo: 0 });
  assert.equal(rp.batted_balls.length, 4);

  appendEvent(db, j, { event_type: 'game_final', payload: { reason: 'other', note: 'test game ended early' } }, admin);
  releaseGameRecord(db, j, admin);
  const stat = (id, key) => db.prepare('SELECT s.value FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?').get(j, id, key)?.value;
  assert.deepEqual([stat(righty, 'spray_balls'), stat(righty, 'pull_pct'), stat(righty, 'oppo_pct'), stat(righty, 'middle_pct')], [2, 50, 50, 0]);
  assert.deepEqual([stat(lefty, 'oppo_pct'), stat(lefty, 'spray_balls')], [100, 1]);
  const dots = id => db.prepare('SELECT b.x, b.y, b.zone, b.bats FROM published_batted_balls b JOIN games g ON g.id = b.game_id WHERE g.command_job_id = ? AND b.player_id = ? ORDER BY b.id').all(j, id);
  assert.deepEqual(dots(righty).map(d => d.zone), ['pull', 'oppo']);
  assert.deepEqual(dots(switcher), [{ x: 0.1, y: 1, zone: 'middle', bats: 'L' }]);

  // Film review: Rory's second single went up the middle. Re-released at once, the dot moves.
  const second = rp.log.filter(l => l.type === 'plate_appearance' && l.spray && l.batter.player_id === righty).at(-1);
  const ev = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(second.id);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(j);
  correctEvent(db, ev.id, { payload: { ...JSON.parse(ev.payload), spray: { x: 0.02, y: 0.95 } } }, admin, 'film: up the middle');
  assert.deepEqual(dots(righty).map(d => d.zone), ['pull', 'middle']);
  assert.deepEqual([stat(righty, 'middle_pct'), stat(righty, 'oppo_pct')], [50, 0]);
});

test('without the spray chart on the order, nothing spray publishes', () => {
  const j = job(['home_to_first']);
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'us', us_is_home: false, slots: [{ slot: 1, player_id: righty, label: 'r', position: 'SS' }], pitcher_player_id: pitcher } }, admin);
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'them', slots: [{ slot: 1, label: '#1', position: 'P' }], pitcher_label: '#1' } }, admin);
  appendPlateAppearance(db, j, { pa: { result: 'single', spray: { x: -0.5, y: 0.8 } }, pitches: [{ result: 'in_play' }] }, admin);
  appendEvent(db, j, { event_type: 'game_final', payload: { reason: 'other', note: 'test game ended early' } }, admin);
  releaseGameRecord(db, j, admin);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND s.metric_key IN ('pull_pct','spray_balls')").get(j).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM published_batted_balls b JOIN games g ON g.id = b.game_id WHERE g.command_job_id = ?').get(j).c, 0);
});
