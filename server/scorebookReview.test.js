// Keeping the scorebook aligned with the film after the fact (14U Silver
// review): lineups of any size are kept whole and can be edited after play;
// a recorded at-bat's batter is corrected in place; deleted (voided) plays
// come back with their pitches and runner plays; a missed at-bat is put
// back into an earlier inning, shifting the batting order behind it; and a
// pitching change or fielder move is put where it happened (Huskers–Vice
// review), so pitching lines and fielding credits follow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-scorebook-review-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-scorebook-review-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { appendEvent, appendPlateAppearance, correctEvent, voidEvent, replayJob, voidedPlays, restoreEvent, insertPlateAppearance, placeSubstitution } = await import('./scorebook.js');
const { pairJobs } = await import('./gamePairing.js');

let admin, baseball, team;
const P = [];   // eleven of our players, batting order 1–11

before(() => {
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Club')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Silver', 'silver')").run(org).lastInsertRowid;
  for (let i = 1; i <= 12; i++) {
    const id = db.prepare('INSERT INTO players (first_name, last_name, slug) VALUES (?, ?, ?)').run(`P${i}`, 'Player', `p${i}-player`).lastInsertRowid;
    db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, ?, '2026-01-01', '2026-12-31')").run(team, id, String(i));
    P.push(id);
  }
});
after(() => {
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

function job() {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, code);
  return db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-10-10', ?, 'Gold')").run(baseball, team, order).lastInsertRowid;
}
const POS = ['SS', '2B', 'CF', '1B', '3B', 'C', 'LF', 'RF', 'P', 'EH', 'EH'];
// We bat first (away) with eleven in the order; they bat eleven labels too.
function setUp(j, count = 11) {
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'us', us_is_home: false, slots: P.slice(0, count).map((id, i) => ({ slot: i + 1, player_id: id, label: `P${i + 1} Player`, position: POS[i] })), pitcher_player_id: P[8] } }, admin);
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'them', slots: Array.from({ length: 11 }, (_, i) => ({ slot: i + 1, label: `#${i + 10}`, position: i === 0 ? 'P' : '' })) } }, admin);
}
const pa = (j, result, extra = {}) => appendPlateAppearance(db, j, { pa: { result, ...extra.pa }, pitches: [{ result: 'in_play' }], runners: extra.runners || [] }, admin);
const stat = (rp, id, k) => rp.tallies.find(t => t.player_id === id)?.stats[k] ?? 0;
const lastPa = rp => rp.log.filter(l => l.type === 'plate_appearance').at(-1);

test('a lineup of eleven is kept whole on both sides, and the order cycles through all eleven', () => {
  const j = job();
  setUp(j);
  for (let i = 0; i < 3; i++) pa(j, 'groundout');       // top 1: slots 1–3
  for (let i = 0; i < 3; i++) pa(j, 'groundout');       // bottom 1: their 1–3
  for (let i = 0; i < 9; i++) pa(j, i % 3 === 2 ? 'groundout' : 'single');   // top 2: slots 4–11, then 1
  const rp = replayJob(db, j);
  assert.equal(rp.state.lineups.us.slots.length, 11);
  assert.equal(rp.state.lineups.them.slots.length, 11);
  assert.equal(stat(rp, P[10], 'bs_pa'), 1, 'the 11th batter batted');
  assert.equal(lastPa(rp).batter.slot, 1, 'after the 11th comes the 1st');
  assert.equal(lastPa(rp).batter.player_id, P[0]);
});

test("a lineup missing a player is edited after play, and every at-bat re-aligns", () => {
  const j = job();
  setUp(j, 10);                                         // P11 was left out by mistake
  for (let i = 0; i < 3; i++) pa(j, 'groundout');
  for (let i = 0; i < 3; i++) pa(j, 'groundout');
  for (let i = 0; i < 8; i++) pa(j, i % 3 === 2 ? 'groundout' : 'walk');    // top 2: 4–10, then 1
  assert.equal(lastPa(replayJob(db, j)).batter.slot, 1);
  const lineup = db.prepare("SELECT * FROM cmd_events WHERE job_id = ? AND event_type = 'lineup' AND status = 'active' AND payload LIKE '%\"side\":\"us\"%'").get(j);
  const payload = JSON.parse(lineup.payload);
  payload.slots.push({ slot: 11, player_id: P[10], label: 'P11 Player', position: 'EH' });
  const rp = correctEvent(db, lineup.id, { payload }, admin, 'P11 batted 11th — missing from the lineup');
  assert.equal(rp.state.lineups.us.slots.length, 11);
  assert.equal(lastPa(rp).batter.player_id, P[10], 'the 8th at-bat of the 2nd was P11, not P1');
  assert.equal(stat(rp, P[0], 'bs_pa'), 1, 'P1 batted only once');
});

test("an at-bat's batter is corrected without deleting the play; the order follows the corrected batter", () => {
  const j = job();
  setUp(j);
  pa(j, 'single');                                      // credited to slot 1 by the order…
  pa(j, 'groundout');
  const first = replayJob(db, j).log.find(l => l.type === 'plate_appearance');
  assert.equal(first.batter.player_id, P[0]);
  const ev = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(first.id);
  // …but the film shows slot 2 batted first (slot 1 was skipped by the scorer).
  const rp = correctEvent(db, ev.id, { payload: { ...JSON.parse(ev.payload), batter_player_id: P[1], batter_label: 'P2 Player', out_of_order_ok: true } }, admin, 'film: P2 led off');
  assert.equal(stat(rp, P[1], 'bs_h'), 1);
  assert.equal(stat(rp, P[0], 'bs_h'), 0);
  const second = rp.log.filter(l => l.type === 'plate_appearance')[1];
  assert.equal(second.batter.player_id, P[2], 'the next at-bat follows the corrected batter');
  assert.ok(rp.log.find(l => l.id !== first.id && l.type === 'plate_appearance' && l.batter.explicit === false));
  assert.ok(!rp.issues.some(i => i.code === 'batting_out_of_order'), 'a deliberate correction is not flagged');
});

test('deleted plays come back with their pitches and runner plays — including ones deleted before this change', () => {
  const j = job();
  setUp(j);
  pa(j, 'single');
  pa(j, 'double', { runners: [{ from: 1, to: 3, how: 'advance' }] });
  pa(j, 'groundout');
  const before = replayJob(db, j);
  const [a, b] = before.log.filter(l => l.type === 'plate_appearance');
  voidEvent(db, b.id, admin, 'accidental delete');
  const [vb] = voidedPlays(db, j, { log: replayJob(db, j).log });
  assert.deepEqual([vb.text, vb.after], ['double (1 pitch)', 'P1 Player'], 'an order-scored at-bat says which at-bat it followed');
  voidEvent(db, a.id, admin, 'accidental delete');
  const voided = voidedPlays(db, j);
  assert.deepEqual(voided.map(v => v.id).sort(), [a.id, b.id].sort());
  assert.equal(voided[0].inning, 1);
  assert.equal(replayJob(db, j).state.team.us.h, 0);

  // Simulate a play voided by the old code (no record of its children).
  db.prepare("UPDATE cmd_review_actions SET new_state = 'superseded' WHERE target_table = 'cmd_events' AND target_id = ? AND action = 'voided'").run(b.id);
  restoreEvent(db, a.id, admin, 'restore');
  const after = restoreEvent(db, b.id, admin, 'restore');
  assert.equal(after.state.team.us.h, 2, 'both hits are back');
  assert.equal(after.log.filter(l => l.type === 'plate_appearance').length, 3);
  assert.ok(after.log.some(l => l.type === 'runner' && l.child), 'the runner play came back with its at-bat');
  assert.deepEqual(after.state.score, before.state.score);
  assert.equal(voidedPlays(db, j).length, 0);
  assert.throws(() => restoreEvent(db, b.id, admin, 'again'), /Only a voided play/);

  const c = after.log.filter(l => l.type === 'plate_appearance').at(-1);
  const ev = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(c.id);
  correctEvent(db, c.id, { payload: { ...JSON.parse(ev.payload), result: 'flyout' } }, admin, 'flyout on film');
  assert.throws(() => restoreEvent(db, c.id, admin, 'x'), /Only a voided play/, 'a corrected play is not restorable');
});

test('a missed at-bat is put back into an earlier inning; the batting order behind it shifts', () => {
  const j = job();
  setUp(j);
  for (let i = 0; i < 3; i++) pa(j, 'groundout');       // top 1: slots 1–3 (as scored)
  for (let i = 0; i < 3; i++) pa(j, 'groundout');       // bottom 1
  pa(j, 'single');                                      // top 2 starts with slot 4
  let rp = replayJob(db, j);
  const top1 = rp.log.filter(l => l.type === 'plate_appearance' && l.inning === 1 && l.half === 'top');
  // Film: slot 3 walked before the third out, which was slot 4.
  rp = insertPlateAppearance(db, j, { before_event_id: top1[2].id, pa: { result: 'walk' } }, admin);
  const t1 = rp.log.filter(l => l.type === 'plate_appearance' && l.inning === 1 && l.half === 'top');
  assert.deepEqual(t1.map(l => l.batter.slot), [1, 2, 3, 4]);
  assert.equal(stat(rp, P[2], 'bs_bb'), 1);
  assert.deepEqual([stat(rp, P[3], 'bs_ab'), stat(rp, P[3], 'bs_h')], [1, 0], 'slot 4 made the third out of the 1st…');
  const t2 = rp.log.filter(l => l.type === 'plate_appearance' && l.inning === 2);
  assert.equal(t2[0].batter.slot, 5, '…so the 2nd starts with slot 5');
  assert.equal(stat(rp, P[4], 'bs_h'), 1, 'and the single in the 2nd is slot 5’s');
  assert.ok(t1[2].bases_before && t1[3].bases_before[1], 'the log shows the runner on first before the out');

  // At the end of a past half: their 4th batter walked after the third out was scored too early.
  const bottom1 = rp.log.find(l => l.type === 'half_inning' && l.inning === 1 && l.half === 'bottom');
  rp = insertPlateAppearance(db, j, { half_event_id: bottom1.id, pa: { result: 'walk' } }, admin);
  assert.equal(rp.log.filter(l => l.type === 'plate_appearance' && l.inning === 1 && l.half === 'bottom').length, 4);
  assert.throws(() => insertPlateAppearance(db, j, { half_event_id: rp.log.filter(l => l.type === 'half_inning').at(-1).id, pa: { result: 'walk' } }, admin), /current half inning/);
});

// ── Defensive changes put where they happened ─────────────────────────────
const outs = (rp, id) => rp.tallies.find(t => t.player_id === id)?.outs_pitched ?? 0;
const RELIEVER = () => P[11];   // on the roster, not in the batting order
const reliefChange = () => ({ kind: 'pitching_change', side: 'us', player_in_id: RELIEVER(), player_in_label: 'P12 Player' });
const halfOf = (rp, inning, half) => rp.log.find(l => l.type === 'half_inning' && l.inning === inning && l.half === half);
const threeOuts = (j, fielders) => { for (let i = 0; i < 3; i++) pa(j, 'groundout', fielders ? { pa: { fielders } } : {}); };
// We bat first; our starter (P9) pitches the bottom halves.
function toBottomTwo(j) {
  setUp(j);
  threeOuts(j); threeOuts(j);                 // top 1, bottom 1 (starter: 3 outs)
  threeOuts(j);                               // top 2
  pa(j, 'groundout'); pa(j, 'walk');          // bottom 2: an out, then a runner on first
}

test('a pitching change recorded late is moved to the start of the inning: the reliever gets the whole inning', () => {
  const j = job();
  toBottomTwo(j);
  const sub = appendEvent(db, j, { event_type: 'substitution', payload: reliefChange() }, admin).event;   // scored here, mid-inning…
  pa(j, 'groundout'); pa(j, 'groundout');
  let rp = replayJob(db, j);
  assert.deepEqual([outs(rp, P[8]), outs(rp, RELIEVER())], [4, 2]);
  assert.equal(stat(rp, RELIEVER(), 'bs_ir'), 1, 'as scored, he inherited the runner');

  // …but the film (and GameChanger) shows he pitched the whole bottom of the 2nd.
  assert.throws(() => placeSubstitution(db, j, { event_id: sub.id, half_event_id: halfOf(rp, 2, 'bottom').id }, admin, ''), /reason/);
  rp = placeSubstitution(db, j, { event_id: sub.id, half_event_id: halfOf(rp, 2, 'bottom').id }, admin, 'GameChanger: relieved to start the 2nd');
  assert.deepEqual([outs(rp, P[8]), outs(rp, RELIEVER())], [3, 3], 'every out of the 2nd is the reliever’s');
  assert.equal(stat(rp, RELIEVER(), 'bs_ir'), 0, 'no inherited runner — the inning was his from the start');
  assert.deepEqual([stat(rp, RELIEVER(), 'bs_bba'), stat(rp, P[8], 'bs_bba')], [1, 0], 'the walk is charged to the reliever');
  const b2 = rp.log.filter(l => l.inning === 2 && l.half === 'bottom' && !l.child && l.type !== 'half_inning');
  assert.equal(b2[0].type, 'substitution', 'the change now comes before the first at-bat');
  assert.ok(b2.filter(l => l.type === 'plate_appearance').every(l => l.pitcher.player_id === RELIEVER()));
  assert.equal(halfOf(rp, 2, 'bottom').defense.positions.find(x => x.position === 'P').player_id, RELIEVER(), 'the half shows who pitched it');
  assert.equal(db.prepare('SELECT status FROM cmd_events WHERE id = ?').get(sub.id).status, 'superseded', 'the original stays in the history');
  const atP = id => rp.state.positions.us.find(r => r.player_id === id)?.stints.filter(x => x.position === 'P').flatMap(x => x.innings);
  assert.deepEqual([atP(P[8]), atP(RELIEVER())], [[1], [2]], 'positions by inning: a reliever from the bench is listed at P too');
});

test('a missed pitching change is inserted where it happened; one also scored later is flagged until voided', () => {
  const j = job();
  toBottomTwo(j);
  const late = appendEvent(db, j, { event_type: 'substitution', payload: reliefChange() }, admin).event;
  pa(j, 'groundout'); pa(j, 'groundout');
  let rp = placeSubstitution(db, j, { payload: reliefChange(), half_event_id: halfOf(replayJob(db, j), 2, 'bottom').id }, admin, 'film: new pitcher warmed up before the 2nd');
  assert.equal(outs(rp, RELIEVER()), 3);
  assert.equal(stat(rp, RELIEVER(), 'bs_ir'), 0, 'a change to the pitcher already pitching inherits nothing');
  assert.ok(rp.issues.some(i => i.code === 'pitching_change_no_change' && i.event_id === late.id), 'the late one is flagged');
  rp = voidEvent(db, late.id, admin, 'duplicate of the change at the start of the 2nd');
  assert.ok(!rp.issues.some(i => i.code === 'pitching_change_no_change'));
  threeOuts(j); threeOuts(j);                 // top 3, bottom 3
  assert.equal(outs(replayJob(db, j), RELIEVER()), 6, 'and he pitches on until the next change');

  // Before a given play: he actually came in after the walk, as scored.
  const reliefStart = replayJob(db, j).log.find(l => l.type === 'substitution' && l.inning === 2);
  const walk = replayJob(db, j).log.find(l => l.type === 'plate_appearance' && l.inning === 2 && l.half === 'bottom' && /walk/.test(l.text));
  const after = replayJob(db, j).log.filter(l => l.type === 'plate_appearance' && l.sequence > walk.sequence)[0];
  rp = placeSubstitution(db, j, { event_id: reliefStart.id, before_event_id: after.id }, admin, 'film: in after the walk');
  assert.deepEqual([outs(rp, P[8]), outs(rp, RELIEVER())], [4, 5]);
  assert.equal(stat(rp, RELIEVER(), 'bs_ir'), 1);
});

test('fielders are corrected from a point in the game: putouts and assists follow the player who was there', () => {
  const j = job();
  setUp(j);                                   // P1 SS, P2 2B, P4 1B
  threeOuts(j);
  threeOuts(j, [6, 3]);                       // bottom 1: three 6-3 groundouts
  let rp = replayJob(db, j);
  assert.deepEqual([stat(rp, P[0], 'bs_a'), stat(rp, P[1], 'bs_a'), stat(rp, P[3], 'bs_po')], [3, 0, 3]);
  // Film: in the 1st, P2 played short and P1 second.
  const b1 = halfOf(rp, 1, 'bottom');
  rp = placeSubstitution(db, j, { payload: { kind: 'position_change', side: 'us', slot: 2, position: 'SS' }, half_event_id: b1.id }, admin, 'film: swapped middle infield');
  assert.deepEqual([stat(rp, P[0], 'bs_a'), stat(rp, P[1], 'bs_a')], [0, 3], 'one player per position: taking short moves P1 off it');
  assert.equal(halfOf(rp, 1, 'bottom').defense.positions.find(x => x.position === '2B'), undefined, 'second base is open until P1 is moved there');
  rp = placeSubstitution(db, j, { payload: { kind: 'position_change', side: 'us', slot: 1, position: '2B' }, half_event_id: b1.id }, admin, 'film: swapped middle infield');
  assert.deepEqual([stat(rp, P[0], 'bs_a'), stat(rp, P[1], 'bs_a'), stat(rp, P[3], 'bs_po')], [0, 3, 3], 'the assists are P2’s');
  const d = Object.fromEntries(halfOf(rp, 1, 'bottom').defense.positions.map(x => [x.position, x.player_id]));
  assert.deepEqual([d.SS, d['2B']], [P[1], P[0]]);
  assert.deepEqual(rp.issues.filter(i => i.code === 'slot_missing'), []);

  // A defensive substitution from a play on: P12 took over at short for the last out.
  const last = rp.log.filter(l => l.type === 'plate_appearance' && l.inning === 1 && l.half === 'bottom').at(-1);
  rp = placeSubstitution(db, j, { payload: { kind: 'defensive', side: 'us', slot: 2, player_in_id: P[11], player_in_label: 'P12 Player', position: 'SS' }, before_event_id: last.id }, admin, 'film: sub at short for the third out');
  assert.deepEqual([stat(rp, P[1], 'bs_a'), stat(rp, P[11], 'bs_a')], [2, 1]);
  assert.throws(() => placeSubstitution(db, j, { payload: { kind: 'position_change', side: 'us', slot: 1, position: 'SS' }, before_event_id: rp.log.find(l => l.type === 'pitch')?.id ?? 999999 }, admin, 'x'), /before a play|before an at-bat/);
});

test("the other team's paired job places a change on its own side of the shared scorebook", () => {
  const j = job();
  toBottomTwo(j);
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Vice Club')").run().lastInsertRowid;
  const vice = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Vice', 'vice-d')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-10-10', ?, 'Silver')").run(baseball, vice, order).lastInsertRowid;
  assert.deepEqual(pairJobs(db, g, j, admin), { host_job_id: j, guest_job_id: g });
  // From the guest's side, our team (the host's "us") is "them".
  const rp = placeSubstitution(db, g, { payload: { ...reliefChange(), side: 'them' }, half_event_id: halfOf(replayJob(db, g), 2, 'bottom').id }, admin, 'their reliever started the 2nd');
  assert.equal(rp.state.pitcher.them.player_id, RELIEVER(), 'the guest sees it on the other team');
  const host = replayJob(db, j);
  assert.equal(host.state.pitcher.us.player_id, RELIEVER(), 'stored on the host side');
  assert.equal(outs(host, RELIEVER()), 1);
});
