// Phase 2 core scorekeeping: replayed state and tallies, auto half innings,
// substitutions with inherited runners, courtesy runners, re-entry rules,
// auditable corrections that recalculate downstream, disputes, and the live
// scorebook publishing through the game-record release.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-scorebook-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-scorebook-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { replay, appendEvent, appendPlateAppearance, correctEvent, voidEvent, disputeEvent, resolveEvent, replayJob, ipFromOuts, liveRecordReport, setEventClip } = await import('./scorebook.js');
const { validateGameRecordSource, releaseGameRecord } = await import('./gameRecord.js');
const { computeQaFlags } = await import('./releaseLogic.js');

let admin, team, baseball, P, C, SS, LF, DH, SUB, CR, PH, job;
const players = {};

function makeJob() {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, code);
  const id = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-09-12', ?, 'Rivals')").run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(id, 'customer', admin);
  return id;
}
const ourLineup = (j, usIsHome = false) => appendEvent(db, j, { event_type: 'lineup', payload: { side: 'us', us_is_home: usIsHome, slots: [
  { slot: 1, player_id: SS, label: 'Sam Short', position: 'SS' }, { slot: 2, player_id: LF, label: 'Lee Left', position: 'LF' },
  { slot: 3, player_id: DH, label: 'Dee Hitter', position: 'DH' }, { slot: 4, player_id: C, label: 'Cat Catcher', position: 'C' },
  { slot: 5, player_id: P, label: 'Pat Pitcher', position: 'P' },
] } }, admin);
const theirLineup = j => appendEvent(db, j, { event_type: 'lineup', payload: { side: 'them', slots: [1, 2, 3, 4, 5].map(n => ({ slot: n, label: `Opp #${n}`, position: n === 1 ? 'P' : '' })) } }, admin);
const pa = (j, body) => appendPlateAppearance(db, j, body, admin);
const tally = (rp, key) => rp.tallies.find(t => t.key === key)?.stats;
const entry = (j, playerId, key) => db.prepare('SELECT s.* FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?').get(j, playerId, key);

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  const mk = (f, l, j) => { const id = db.prepare('INSERT INTO players (first_name, last_name, slug) VALUES (?, ?, ?)').run(f, l, `${f}-${l}`.toLowerCase()).lastInsertRowid; db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, ?, '2026-01-01', '2026-12-31')").run(team, id, j); players[id] = `${f} ${l}`; return id; };
  P = mk('Pat', 'Pitcher', '1'); C = mk('Cat', 'Catcher', '2'); SS = mk('Sam', 'Short', '6'); LF = mk('Lee', 'Left', '7'); DH = mk('Dee', 'Hitter', '9'); SUB = mk('Sue', 'Sub', '12'); CR = mk('Cory', 'Runner', '15'); PH = mk('Pete', 'Hitter', '20');
  job = makeJob();
});

after(() => {
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('replay: a half inning of plays yields batter, pitcher and team totals; innings pitched count outs in thirds', () => {
  const ev = (id, type, payload, parent = null) => ({ id, sequence: id, event_type: type, parent_event_id: parent, status: 'active', payload });
  const events = [
    ev(1, 'lineup', { side: 'us', us_is_home: false, slots: [{ slot: 1, player_id: 10, label: 'A' }, { slot: 2, player_id: 11, label: 'B' }, { slot: 3, player_id: 12, label: 'Cc' }, { slot: 4, player_id: 13, label: 'D' }] }),
    ev(2, 'lineup', { side: 'them', slots: [{ slot: 1, label: 'Opp1', position: 'P' }] }),
    ev(3, 'half_inning', { inning: 1, half: 'top' }),
    ev(4, 'plate_appearance', { result: 'single' }, 3),
    ev(5, 'plate_appearance', { result: 'walk' }, 3),
    ev(6, 'runner', { from: 1, to: 2, how: 'advance' }, 5),
    ev(7, 'plate_appearance', { result: 'home_run' }, 3),
    ev(8, 'plate_appearance', { result: 'strikeout' }, 3),
    ev(9, 'plate_appearance', { result: 'groundout' }, 3),
    ev(10, 'plate_appearance', { result: 'single' }, 3),
    ev(11, 'plate_appearance', { result: 'flyout' }, 3),
  ];
  const rp = replay(events, { ruleset: { innings: 7 } });
  assert.equal(rp.state.score.us, 3);
  assert.equal(rp.state.outs, 3);
  assert.equal(rp.state.half_complete, true);
  assert.deepEqual(rp.state.bases, { 1: null, 2: null, 3: null });
  const a = rp.tallies.find(t => t.key === 'p:10').stats, b = rp.tallies.find(t => t.key === 'p:11').stats, c = rp.tallies.find(t => t.key === 'p:12').stats;
  // A: single, then groundout the second time through. B: walk, then a single. C: HR (3 RBI), then the flyout.
  assert.equal(a.bs_h, 1); assert.equal(a.bs_r, 1); assert.equal(a.bs_ab, 2);
  assert.equal(b.bs_bb, 1); assert.equal(b.bs_h, 1); assert.equal(b.bs_ab, 1, 'the walk is not an at-bat, the single is'); assert.equal(b.bs_r, 1);
  assert.equal(c.bs_hr, 1); assert.equal(c.bs_rbi, 3); assert.equal(c.bs_r, 1); assert.equal(c.bs_ab, 2);
  const opp = rp.tallies.find(t => t.key === 'l:them:Opp1').stats;
  assert.equal(opp.bs_bf, 7); assert.equal(opp.bs_ha, 3); assert.equal(opp.bs_hra, 1); assert.equal(opp.bs_bba, 1); assert.equal(opp.bs_kp, 1);
  assert.equal(opp.bs_ra, 3); assert.equal(opp.bs_er, 3); assert.equal(opp.bs_ip, 1);
  assert.equal(rp.state.next_slot.us, 4, 'seven batters through a four-man order: slot 4 is up next');
  assert.equal(ipFromOuts(14), 4.2);
  assert.equal(rp.issues.length, 0, JSON.stringify(rp.issues));
});

test('scoring through the API: lineups, auto half innings on the third out, and the live source appears', () => {
  ourLineup(job, false);
  const ready = theirLineup(job);
  assert.deepEqual(ready.state.upcoming, { inning: 1, half: 'top', batting: 'us' }, 'before the first pitch the scorer sees who leads off');
  assert.equal(ready.state.expected_batter.player_id, SS);
  let rp = pa(job, { pa: { result: 'single' } });
  assert.equal(rp.state.inning, 1); assert.equal(rp.state.half, 'top'); assert.equal(rp.state.batting, 'us');
  assert.equal(rp.state.expected_batter.player_id, LF, 'the lineup advances to slot 2');
  rp = pa(job, { pa: { result: 'flyout' } });
  rp = pa(job, { pa: { result: 'strikeout_looking' } });
  rp = pa(job, { pa: { result: 'groundout' } });
  assert.equal(rp.state.half, 'bottom'); assert.equal(rp.state.inning, 1); assert.equal(rp.state.outs, 0);
  assert.equal(rp.state.batting, 'them', 'third out flipped the half automatically');
  assert.equal(rp.events.filter(e => e.event_type === 'half_inning').length, 2);
  const src = db.prepare("SELECT * FROM cmd_game_record_sources WHERE job_id = ? AND source_kind = 'live_internal'").get(job);
  assert.ok(src, 'live scorebook registered as a game-record source');
  assert.equal(src.validation_status, 'validating', 'not validated until the game is final');
});

test('inherited runners: the run is charged to the pitcher who put the runner on, the hit to the pitcher on the mound', () => {
  // Bottom 1: they bat, Pat pitches for us.
  let rp = pa(job, { pa: { batter_label: 'Opp #1', result: 'walk' } });
  assert.equal(rp.state.pitcher.us.player_id, P);
  appendEvent(db, job, { event_type: 'substitution', payload: { kind: 'pitching_change', side: 'us', player_in_id: SUB, player_in_label: 'Sue Sub', player_out_id: P, slot: 5 } }, admin);
  rp = pa(job, { pa: { batter_label: 'Opp #2', result: 'single' }, runners: [{ from: 1, to: 4, how: 'scored_on_play' }] });
  const pat = tally(rp, `p:${P}`), sue = tally(rp, `p:${SUB}`);
  assert.equal(pat.bs_bba, 1); assert.equal(pat.bs_ra, 1); assert.equal(pat.bs_er, 1, 'inherited runner scores against Pat');
  assert.equal(sue.bs_ha, 1); assert.equal(sue.bs_ra, 0); assert.equal(sue.bs_bf, 1);
  assert.equal(rp.state.score.them, 1);
  assert.equal(tally(rp, 'l:them:Opp #2').bs_rbi, 1);
  // Close the half: three outs, then top 2 begins.
  rp = pa(job, { pa: { batter_label: 'Opp #3', result: 'strikeout' } });
  rp = pa(job, { pa: { batter_label: 'Opp #4', result: 'popout' } });
  rp = pa(job, { pa: { batter_label: 'Opp #5', result: 'lineout' } });
  assert.equal(rp.state.inning, 2); assert.equal(rp.state.half, 'top');
  assert.equal(tally(rp, `p:${SUB}`).bs_ip, 1, 'three outs on the mound is one inning');
});

test('courtesy runner and re-entry: the courtesy runner owns the steal and the run, the batter keeps the RBI; a starter re-enters once', () => {
  // Top 2, we bat. Slot 5 is due — and that is Sue, who took Pat's slot with the pitching change in the
  // previous inning — so the courtesy runner has to be a bench player, not the batter herself.
  let rp = replayJob(db, job);
  const due = rp.state.expected_batter;
  assert.equal(due.player_id, SUB, 'the relief pitcher bats in the slot she took over');
  const runsBefore = tally(rp, `p:${due.player_id}`)?.bs_r || 0;   // totals are game-wide; earlier innings in this suite may have scored
  rp = pa(job, { pa: { result: 'single' } });
  assert.equal(rp.state.bases[1].ref.player_id, due.player_id);
  // Courtesy runner for the catcher/pitcher slot.
  appendEvent(db, job, { event_type: 'substitution', payload: { kind: 'courtesy_runner', side: 'us', base: 1, player_in_id: CR, player_in_label: 'Cory Runner', player_out_id: due.player_id } }, admin);
  rp = replayJob(db, job);
  assert.equal(rp.state.bases[1].ref.player_id, CR);
  assert.equal(rp.state.bases[1].responsible.label, 'Opp #1', 'responsible pitcher unchanged by the courtesy runner');
  // Steal second between batters, then the next batter singles her home.
  appendEvent(db, job, { event_type: 'runner', payload: { runner_player_id: CR, from: 1, to: 2, how: 'stolen_base' } }, admin);
  rp = pa(job, { pa: { result: 'single' }, runners: [{ from: 2, to: 4, how: 'scored_on_play' }] });
  assert.equal(tally(rp, `p:${CR}`).bs_sb, 1);
  assert.equal(tally(rp, `p:${CR}`).bs_r, 1);
  assert.equal(tally(rp, `p:${SS}`).bs_rbi, 1, 'the batter who drove her in keeps the RBI');
  assert.equal(tally(rp, `p:${due.player_id}`).bs_r, runsBefore, 'the replaced runner does not get the run');
  const batter = rp.state.lineups.us.slots.find(s => s.slot === rp.state.next_slot.us - 1 || (rp.state.next_slot.us === 1 && s.slot === 5));
  assert.ok(batter);
  // Re-entry: a starter may return once under starters_once.
  appendEvent(db, job, { event_type: 'substitution', payload: { kind: 'pinch_hitter', side: 'us', slot: 3, player_in_id: PH, player_in_label: 'Pete Hitter', player_out_id: DH } }, admin);
  rp = appendEvent(db, job, { event_type: 'substitution', payload: { kind: 're_entry', side: 'us', slot: 3, player_in_id: DH, player_in_label: 'Dee Hitter' } }, admin);
  assert.ok(!rp.issues.some(i => i.code.startsWith('reentry')), JSON.stringify(rp.issues));
  appendEvent(db, job, { event_type: 'substitution', payload: { kind: 'pinch_hitter', side: 'us', slot: 3, player_in_id: PH, player_in_label: 'Pete Hitter', player_out_id: DH } }, admin);
  rp = appendEvent(db, job, { event_type: 'substitution', payload: { kind: 're_entry', side: 'us', slot: 3, player_in_id: DH, player_in_label: 'Dee Hitter' } }, admin);
  assert.ok(rp.issues.some(i => i.code === 'reentry_twice'), 'a second re-entry is flagged for the reviewer');
});

test('correction: a defensive judgment changes (error → single) and every dependent total recalculates with no duplicates', () => {
  // Error charged to their shortstop, then corrected to a clean single.
  let rp = pa(job, { pa: { result: 'reach_on_error', error_label: 'Opp #6' } });
  const paEvent = rp.events.filter(e => e.event_type === 'plate_appearance').at(-1);
  const batterKey = `p:${paEvent.payload.batter_player_id || rp.log.at(-1)}`;
  const before = { e: tally(rp, 'l:them:Opp #6')?.bs_e, hits: rp.tallies.filter(t => t.player_id).reduce((n, t) => n + t.stats.bs_h, 0) };
  assert.equal(before.e, 1);
  rp = correctEvent(db, paEvent.id, { payload: { ...paEvent.payload, result: 'single', error_label: undefined } }, admin, 'video review: clean hit, no error');
  const after = { e: tally(rp, 'l:them:Opp #6')?.bs_e ?? 0, hits: rp.tallies.filter(t => t.player_id).reduce((n, t) => n + t.stats.bs_h, 0) };
  assert.equal(after.e, 0, 'the error is gone');
  assert.equal(after.hits, before.hits + 1, 'the hit is counted once');
  const old = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(paEvent.id);
  assert.equal(old.status, 'superseded'); assert.ok(old.superseded_by);
  const repl = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(old.superseded_by);
  assert.equal(repl.sequence, old.sequence, 'same place in the game');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_events WHERE job_id = ? AND sequence = ? AND status = 'active'").get(job, old.sequence).c, 1, 'no duplicate active event');
  const a = db.prepare("SELECT * FROM cmd_review_actions WHERE target_table='cmd_events' AND target_id=? AND action='corrected'").get(repl.id);
  assert.ok(a && /clean hit/.test(a.note) && /reach_on_error/.test(a.prev_state) && /single/.test(a.new_state), 'audit carries both versions and the reason');
  assert.ok(batterKey);
});

test('dispute: a play under review is excluded from totals and flagged; resolving restores it', () => {
  let rp = replayJob(db, job);
  const lastPa = rp.events.filter(e => e.event_type === 'plate_appearance' && e.status === 'active').at(-1);
  const hitsBefore = rp.tallies.filter(t => t.player_id).reduce((n, t) => n + t.stats.bs_h, 0);
  rp = disputeEvent(db, lastPa.id, { note: 'was the runner interference?' }, admin);
  assert.ok(rp.issues.some(i => i.code === 'unresolved_scoring_judgment'));
  assert.equal(rp.tallies.filter(t => t.player_id).reduce((n, t) => n + t.stats.bs_h, 0), hitsBefore - 1, 'disputed hit excluded');
  assert.ok(computeQaFlags(db, job).some(f => f.code === 'unresolved_scoring_judgment' && f.level === 'warning'));
  rp = resolveEvent(db, lastPa.id, { note: 'umpire confirmed clean' }, admin);
  assert.equal(rp.tallies.filter(t => t.player_id).reduce((n, t) => n + t.stats.bs_h, 0), hitsBefore);
  assert.ok(!rp.issues.some(i => i.code === 'unresolved_scoring_judgment'));
});

test('void: a mistaken event is superseded with its children; the game replays without it', () => {
  let rp = pa(job, { pa: { result: 'double' }, pitches: [{ result: 'ball' }, { result: 'in_play' }] });
  const paEvent = rp.events.filter(e => e.event_type === 'plate_appearance').at(-1);
  const kids = db.prepare('SELECT id FROM cmd_events WHERE parent_event_id = ?').all(paEvent.id);
  assert.equal(kids.length, 2);
  rp = voidEvent(db, paEvent.id, admin, 'entered on the wrong batter');
  assert.ok(!rp.events.some(e => e.id === paEvent.id));
  assert.ok(kids.every(k => db.prepare('SELECT status FROM cmd_events WHERE id = ?').get(k.id).status === 'superseded'));
});

test('the live scorebook validates only when final and publishes our players through the game-record release; corrections re-release', () => {
  const src = db.prepare("SELECT * FROM cmd_game_record_sources WHERE job_id = ? AND source_kind = 'live_internal'").get(job);
  let v = validateGameRecordSource(db, src.id, {}, admin);
  assert.equal(v.status, 'validating');
  assert.match(v.report.warnings[0], /not final/);
  assert.throws(() => releaseGameRecord(db, job, admin), /No validated game-record source/);
  // Mark final; run rule not reached, so this is a scorer decision (time limit).
  let rp = appendEvent(db, job, { event_type: 'game_final', payload: { reason: 'time_limit', note: '1:45 limit' } }, admin);
  assert.equal(rp.state.final.reason, 'time_limit');
  v = validateGameRecordSource(db, src.id, {}, admin);
  assert.equal(v.status, 'validated', JSON.stringify(v.report.warnings));
  assert.ok(v.report.rows.every(r => r.player_id), 'only our players are rows');
  assert.ok(!v.report.rows.some(r => /Opp/.test(r.name)));
  const out = releaseGameRecord(db, job, admin);
  assert.ok(out.players >= 3);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(job);
  const ss = entry(job, SS, 'bs_pa');
  assert.ok(ss && ss.method === 'scorebook_derived');
  const sue = entry(job, CR, 'bs_sb');
  assert.equal(sue.value, 1, "the courtesy runner's steal reaches the profile");
  assert.equal(entry(job, P, 'bs_er').value, 1, "Pat's inherited run is on the profile");
  // A correction after release re-releases immediately: void the stolen base → SB gone from the profile.
  const sb = db.prepare("SELECT id FROM cmd_events WHERE job_id = ? AND event_type = 'runner' AND status = 'active' AND payload LIKE '%stolen_base%' ORDER BY id LIMIT 1").get(job);
  voidEvent(db, sb.id, admin, 'was defensive indifference');
  assert.equal(entry(job, CR, 'bs_sb'), undefined, 'stale value removed from the profile at once');
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? AND action='game_record_rereleased'").get(job));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id=s.game_id WHERE g.command_job_id=? AND g.player_id=? AND s.metric_key='bs_pa'").get(job, SS).c, 1, 'no duplicate entries after re-release');
});

test('an earned run awaiting the scorer\'s ruling is withheld from the live record until ruled', () => {
  const j3 = makeJob();
  ourLineup(j3, true);    // we are home: they bat first, Pat pitches
  theirLineup(j3);
  pa(j3, { pa: { batter_label: 'Opp #1', result: 'single' } });
  pa(j3, { pa: { batter_label: 'Opp #2', result: 'reach_on_error', error_player_id: SS } });               // Opp #1 forced to second
  const dbl = pa(j3, { pa: { batter_label: 'Opp #3', result: 'double' }, runners: [{ from: 2, to: 4, how: 'scored_on_play' }, { from: 1, to: 3, how: 'advance' }] });
  assert.ok(dbl.issues.some(i => i.code === 'er_needs_judgment'));
  let live = liveRecordReport(db, j3);
  const patRow = () => live.report.rows.find(r => r.player_id === P);
  assert.equal(patRow().stats.bs_er, undefined, 'ER is not published while the ruling is open');
  assert.equal(patRow().stats.bs_ra, 1, 'the run itself is');
  assert.ok(live.report.warnings.some(w => /Earned runs withheld until ruled: Pat Pitcher/.test(w)));
  // The scorer rules it unearned on the runner event.
  const runEvent = dbl.events.find(e => e.event_type === 'runner' && e.parent_event_id === dbl.event_id && e.payload.to === 4);
  correctEvent(db, runEvent.id, { payload: { ...runEvent.payload, unearned: true } }, admin, 'inning reconstruction: would have been the third out');
  live = liveRecordReport(db, j3);
  assert.equal(patRow().stats.bs_er, undefined, 'no earned runs at all now, so the zero is simply absent');
  assert.ok(!live.report.warnings.some(w => /withheld/.test(w)));
  assert.equal(replayJob(db, j3).tallies.find(t => t.player_id === P).stats.bs_er, 0);
});

test('tagging: plays carry feed, moment and a default clip; pitches carry their own moments; corrections keep the link; foreign feeds are refused; clips adjust', () => {
  const j4 = makeJob();
  const feed = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps, nominal_fps, width, height, duration_s) VALUES (?, 'Behind home', 'k4', 'g.mp4', 'ready', 60, 60, 1920, 1080, 5400)").run(j4).lastInsertRowid;
  const other = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps, nominal_fps, width, height, duration_s) VALUES (?, 'Other job', 'k5', 'o.mp4', 'ready', 60, 60, 1920, 1080, 100)").run(job).lastInsertRowid;
  ourLineup(j4, false); theirLineup(j4);
  const rp = pa(j4, { pa: { result: 'single' }, pitches: [{ result: 'ball', timecode_s: 120.0 }, { result: 'in_play', timecode_s: 125.5 }], runners: [], selected_feed_id: feed });
  const row = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(rp.event_id);
  assert.equal(row.selected_feed_id, feed); assert.equal(row.timecode_s, 125.5, 'the play is stamped with its last pitch');
  assert.deepEqual([row.clip_start_s, row.clip_end_s], [121.5, 133.5], 'default clip around the moment');
  const pitchRows = db.prepare("SELECT timecode_s, payload FROM cmd_events WHERE parent_event_id = ? AND event_type = 'pitch' ORDER BY sequence").all(rp.event_id);
  assert.deepEqual(pitchRows.map(r => r.timecode_s), [120, 125.5]);
  assert.ok(!('timecode_s' in JSON.parse(pitchRows[0].payload)), 'the moment lives on the row, not in the payload');
  assert.ok(rp.log.some(l => l.id === rp.event_id && l.timecode_s === 125.5 && l.feed_id === feed && l.clip[0] === 121.5), 'the log carries the link for the UI');
  const sb = appendEvent(db, j4, { event_type: 'runner', payload: { runner_player_id: SS, from: 1, to: 2, how: 'stolen_base' }, selected_feed_id: feed, timecode_s: 190 }, admin);
  assert.equal(sb.event.timecode_s, 190); assert.equal(sb.event.clip_start_s, 186);
  const fixed = correctEvent(db, rp.event_id, { payload: { result: 'double', pitch_count: 2 } }, admin, 'video review');
  const fixedRow = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(fixed.event_id);
  assert.equal(fixedRow.timecode_s, 125.5); assert.equal(fixedRow.selected_feed_id, feed); assert.equal(fixedRow.clip_end_s, 133.5);
  assert.throws(() => pa(j4, { pa: { result: 'flyout' }, selected_feed_id: other, timecode_s: 200 }), /attached to this job/);
  assert.throws(() => appendEvent(db, j4, { event_type: 'runner', payload: { runner_player_id: SS, from: 2, to: 3, how: 'stolen_base' }, timecode_s: -1 }, admin), /non-negative/);
  const adj = setEventClip(db, fixed.event_id, { clip_start_s: 124, clip_end_s: 129 }, admin);
  assert.deepEqual([adj.event.clip_start_s, adj.event.clip_end_s, adj.event.timecode_s], [124, 129, 125.5]);
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_events' AND target_id=? AND action='clip_adjusted'").get(fixed.event_id));
  assert.throws(() => setEventClip(db, fixed.event_id, { clip_start_s: 130, clip_end_s: 129 }, admin), /end after the start/);
});

test('a state adjustment needs a half inning in progress and is audited like any other event', () => {
  const j5 = makeJob();
  ourLineup(j5, false); theirLineup(j5);
  assert.throws(() => appendEvent(db, j5, { event_type: 'state_adjustment', payload: { outs: 1, note: 'nothing has happened yet' } }, admin), /no half inning is in progress/);
  pa(j5, { pa: { result: 'walk' } });
  const rp = appendEvent(db, j5, { event_type: 'state_adjustment', payload: { outs: 1, note: 'runner was doubled off on a play we missed' } }, admin);
  assert.equal(rp.state.outs, 1);
  assert.ok(rp.issues.some(i => i.code === 'state_adjusted' && i.level === 'info'));
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_events' AND target_id=? AND action='created'").get(rp.event.id));
});

test('internal metrics on plays: a linked radar reading is matched to our pitcher once; steals and hits can queue timing attempts at the tagged moment', () => {
  const j6 = makeJob();
  const feed = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps, nominal_fps, width, height, duration_s) VALUES (?, 'Behind home', 'k6', 'g6.mp4', 'ready', 60, 60, 1920, 1080, 5400)").run(j6).lastInsertRowid;
  ourLineup(j6, true);    // we are home: they bat first against Pat
  theirLineup(j6);
  const reading = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 71, 'unmatched', ?)").run(j6, admin).lastInsertRowid;
  const foreign = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 99, 'unmatched', ?)").run(job, admin).lastInsertRowid;
  // Their leadoff hitter strikes out; the second pitch carried the radar reading.
  const rp = pa(j6, { pa: { batter_label: 'Opp #1', result: 'strikeout' }, pitches: [{ result: 'called_strike', pitch_type: 'fastball' }, { result: 'swinging_strike', pitch_type: 'fastball', radar_reading_id: reading }, { result: 'swinging_strike' }], selected_feed_id: feed, timecode_s: 40 });
  const r = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(reading);
  assert.equal(r.status, 'matched'); assert.equal(r.player_id, P); assert.equal(r.pitch_type, 'fastball'); assert.equal(r.pitch_or_exit, 'pitch');
  const result = db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_kind='radar_reading' AND evidence_id=? AND superseded_by IS NULL").all(reading);
  assert.equal(result.length, 1, 'one derived result, through the radar lifecycle'); assert.equal(result[0].value, 71); assert.equal(result[0].player_id, P);
  const entry = rp.log.find(l => l.id === rp.event_id);
  assert.equal(entry.pitches.length, 3); assert.equal(entry.pitches[1].velocity, 71); assert.equal(entry.pitches[1].pitch_type, 'fastball');
  assert.match(entry.text, /71 mph/);
  // Linking the same reading again to the same pitcher is a no-op; another job's reading is refused.
  assert.throws(() => pa(j6, { pa: { batter_label: 'Opp #2', result: 'walk' }, pitches: [{ result: 'ball', radar_reading_id: foreign }, { result: 'ball' }, { result: 'ball' }, { result: 'ball' }] }), /reading on this job/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_kind='radar_reading' AND evidence_id=? AND superseded_by IS NULL").get(reading).c, 1);
  // Bottom 1: we bat. A single with home-to-first timing queued for the batter; then a steal timed for the runner.
  pa(j6, { pa: { batter_label: 'Opp #2', result: 'groundout' } }); pa(j6, { pa: { batter_label: 'Opp #3', result: 'flyout' } });
  const hit = pa(j6, { pa: { result: 'single', time_home_to_first: true }, pitches: [{ result: 'in_play', timecode_s: 300.25 }], selected_feed_id: feed });
  const paRow = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(hit.event_id);
  const attemptId = JSON.parse(paRow.payload).attempt_id;
  assert.ok(attemptId, 'the play remembers its timing attempt');
  const attempt = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(attemptId);
  assert.equal(attempt.event_type, 'running_attempt'); assert.equal(attempt.player_id, SS, 'queued for the batter'); assert.equal(attempt.selected_feed_id, feed); assert.equal(attempt.timecode_s, 300.25);
  assert.equal(JSON.parse(attempt.payload).attempt_type, 'home_to_first');
  assert.ok(!('time_home_to_first' in JSON.parse(paRow.payload)), 'the request flag is not stored');
  const sb = appendEvent(db, j6, { event_type: 'runner', payload: { runner_player_id: SS, from: 1, to: 2, how: 'stolen_base', time_steal: true }, selected_feed_id: feed, timecode_s: 333 }, admin);
  const stealAttempt = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(sb.event.payload.attempt_id);
  assert.equal(JSON.parse(stealAttempt.payload).attempt_type, 'steal'); assert.equal(stealAttempt.player_id, SS); assert.equal(stealAttempt.timecode_s, 333);
  assert.match(sb.log.find(l => l.id === sb.event.id).text, /timing queued/);
  // Timing needs footage and one of our players.
  assert.throws(() => appendEvent(db, j6, { event_type: 'runner', payload: { runner_player_id: SS, from: 2, to: 3, how: 'stolen_base', time_steal: true } }, admin), /needs the footage selected/);
  assert.throws(() => appendEvent(db, j6, { event_type: 'runner', payload: { runner_player_id: SS, from: 2, to: 3, how: 'stolen_base', attempt_id: 999999 } }, admin), /running attempt on this job/);
});

test('the game result publishes with the record from the live scorebook, follows corrections, and is absent for import-only records', () => {
  const j7 = makeJob();
  ourLineup(j7, true);   // we are home
  theirLineup(j7);
  const outs = () => { for (let i = 0; i < 3; i += 1) pa(j7, { pa: { result: 'strikeout' } }); };
  outs();                                                         // top 1: they go quietly
  pa(j7, { pa: { result: 'home_run' } }); outs();                 // bottom 1: we score once
  appendEvent(db, j7, { event_type: 'game_final', payload: { reason: 'time_limit' } }, admin);
  const src = db.prepare("SELECT id FROM cmd_game_record_sources WHERE job_id = ? AND source_kind = 'live_internal'").get(j7);
  validateGameRecordSource(db, src.id, admin);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'validated' WHERE id = ?").run(j7);
  releaseGameRecord(db, j7, admin);
  let row = db.prepare('SELECT * FROM cmd_game_results WHERE job_id = ?').get(j7);
  assert.deepEqual([row.us_runs, row.them_runs, row.winner, row.final_reason], [1, 0, 'us', 'time_limit']);
  assert.deepEqual(JSON.parse(row.line_score).home.runs, [1]);
  assert.equal(JSON.parse(row.team).them.lob, 0);
  assert.match(db.prepare("SELECT note FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? AND action='game_record_released' ORDER BY id DESC LIMIT 1").get(j7).note, /final 1–0/);
  // The homer is ruled a double on review: the record re-releases and the result follows.
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(j7);
  const hr = db.prepare("SELECT id FROM cmd_events WHERE job_id = ? AND event_type = 'plate_appearance' AND status = 'active' AND payload LIKE '%home_run%'").get(j7);
  correctEvent(db, hr.id, { payload: { result: 'double', pitch_count: 0 } }, admin, 'video review: ball bounced over the fence');
  row = db.prepare('SELECT * FROM cmd_game_results WHERE job_id = ?').get(j7);
  assert.deepEqual([row.us_runs, row.them_runs, row.winner], [0, 0, 'tie']);
  // A stale stored report (an engine upgrade since the last event) is refreshed by the release itself.
  db.prepare("UPDATE cmd_game_record_sources SET parsed_report = ? WHERE job_id = ? AND source_kind = 'live_internal'").run(JSON.stringify({ blocks: [], warnings: [], rows: [], unresolved: [], roster: [] }), j7);
  releaseGameRecord(db, j7, admin);
  assert.ok(db.prepare("SELECT 1 FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND s.metric_key = 'bs_tb'").get(j7), 'the release published the current replay, not the stale snapshot');
  // A record built only from an import carries no result.
  const j8 = makeJob();
  const imp = db.prepare("INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, created_by) VALUES (?, 'manual', 'Manual box', ?, ?)").run(j8, 'Number,Last,First,PA,AB,H\n6,Short,Sam,4,4,2\n', admin).lastInsertRowid;
  validateGameRecordSource(db, imp, admin);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'validated' WHERE id = ?").run(j8);
  releaseGameRecord(db, j8, admin);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cmd_game_results WHERE job_id = ?').get(j8).c, 0);
});

test('game-over suggestion follows the ruleset run rule; scoring after final is refused', () => {
  const j2 = makeJob();
  ourLineup(j2, true);   // we are home
  theirLineup(j2);
  // Top 1: they go quietly; bottom 1..3: we score 15 with home runs in bottom 3.
  const outs = () => { pa(j2, { pa: { result: 'strikeout' } }); pa(j2, { pa: { result: 'strikeout' } }); pa(j2, { pa: { result: 'strikeout' } }); };
  let rp;
  for (let inning = 1; inning <= 3; inning += 1) {
    outs();                       // top: them
    if (inning < 3) outs();       // bottom: us, quiet
    else { for (let i = 0; i < 15; i += 1) rp = pa(j2, { pa: { result: 'home_run' } }); }
  }
  assert.equal(rp.state.score.us, 15);
  // 15 runs after 3 complete innings is not yet a completed bottom half; finish it.
  rp = pa(j2, { pa: { result: 'flyout' } }); rp = pa(j2, { pa: { result: 'flyout' } }); rp = pa(j2, { pa: { result: 'flyout' } });
  assert.equal(rp.state.game_over_suggested?.reason, 'run_rule', JSON.stringify(rp.state.game_over_suggested));
  appendEvent(db, j2, { event_type: 'game_final', payload: { reason: 'run_rule' } }, admin);
  assert.throws(() => pa(j2, { pa: { result: 'single' } }), /final/);
  const live = liveRecordReport(db, j2);
  assert.equal(live.status, 'validated');
});
