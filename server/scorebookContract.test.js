// The appendix's "V1 Scorekeeping and Derived Box-Score Rules", as tests. Pure
// replay — no database — so every rule is a small, readable scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, countAfter, ratesFor, normalizeFielders } from './scorebook.js';

let seq = 0;
const ev = (type, payload, parent = null) => { seq += 1; return { id: seq, sequence: seq, event_type: type, parent_event_id: parent, status: 'active', payload }; };
const POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
// Nine of ours (ids 1–9, playing positions 1–9 in order) against nine labels.
function game({ usHome = false } = {}) {
  seq = 0;
  const events = [
    ev('lineup', { side: 'us', us_is_home: usHome, slots: POS.map((pos, i) => ({ slot: i + 1, player_id: i + 1, label: `Our${i + 1}`, position: pos })) }),
    ev('lineup', { side: 'them', slots: POS.map((pos, i) => ({ slot: i + 1, label: `Opp${i + 1}`, position: pos })) }),
  ];
  const half = (inning, h) => { const e = ev('half_inning', { inning, half: h }); events.push(e); return e; };
  const pa = (halfEv, payload, pitches = [], runners = []) => {
    const e = ev('plate_appearance', payload, halfEv.id); events.push(e);
    for (const r of pitches) events.push(ev('pitch', { result: r }, e.id));
    for (const r of runners) events.push(ev('runner', r, e.id));
    return e;
  };
  const runner = (halfEv, payload) => { const e = ev('runner', payload, halfEv.id); events.push(e); return e; };
  const sub = payload => { const e = ev('substitution', payload); events.push(e); return e; };
  const final = (reason = 'regulation') => { const e = ev('game_final', { reason }); events.push(e); return e; };
  const run = (opts = {}) => replay(events, { ruleset: { innings: 7, run_rule: [] }, ...opts });
  return { events, half, pa, runner, sub, final, run };
}
const T = (rp, key) => rp.tallies.find(t => t.key === key);
const S = (rp, key) => T(rp, key)?.stats;
const codes = rp => rp.issues.map(i => i.code);

test('count: fouls stop adding strikes at two; a foul bunt or foul tip on strike three is a strikeout; balls in play and HBP change nothing', () => {
  assert.deepEqual(countAfter(['foul', 'foul', 'foul', 'foul'].map(result => ({ result }))), { balls: 0, strikes: 2, ended: null, overflow: [] });
  assert.equal(countAfter(['called_strike', 'foul', 'foul_bunt'].map(result => ({ result }))).ended, 'strikeout');
  assert.equal(countAfter(['swinging_strike', 'swinging_strike', 'foul_tip'].map(result => ({ result }))).ended, 'strikeout');
  assert.equal(countAfter(['ball', 'ball', 'check_swing_strike', 'called_strike', 'called_strike'].map(result => ({ result }))).ended, 'strikeout_looking');
  assert.deepEqual(countAfter(['ball', 'hit_by_pitch'].map(result => ({ result }))), { balls: 1, strikes: 0, ended: 'hit_by_pitch', overflow: [] });
  assert.deepEqual(countAfter(['ball', 'ball', 'ball', 'ball', 'called_strike'].map(result => ({ result }))), { balls: 4, strikes: 0, ended: 'walk', overflow: ['called_strike'] });
});

test('pitch totals: strikes and balls thrown, called strikes, swings and misses on both sides of the ball', () => {
  const g = game(); const h = g.half(1, 'top');
  // Our1: ball, called K, foul, swinging K (strikeout swinging)
  g.pa(h, { result: 'strikeout' }, ['ball', 'called_strike', 'foul', 'swinging_strike']);
  // Our2: check swing called a strike, foul tip, in play → single
  g.pa(h, { result: 'single' }, ['check_swing_strike', 'foul_tip', 'in_play']);
  const rp = g.run();
  const opp = S(rp, 'l:them:Opp1');
  assert.equal(opp.bs_pitches, 7); assert.equal(opp.bs_strikes, 6); assert.equal(opp.bs_balls, 1); assert.equal(opp.bs_cstr, 1);
  assert.equal(opp.bs_swings_a, 5, 'foul, swinging K, check swing, foul tip, in play'); assert.equal(opp.bs_whiffs_a, 2, 'swinging K and the check swing');
  assert.equal(S(rp, 'p:1').bs_swings, 2); assert.equal(S(rp, 'p:1').bs_whiffs, 1);
  assert.equal(T(rp, 'l:them:Opp1').rates.strike_pct, 0.857); assert.equal(T(rp, 'l:them:Opp1').rates.whiff_pct, 0.4); assert.equal(T(rp, 'l:them:Opp1').rates.csw_pct, 0.429);
  assert.equal(S(rp, 'l:them:Opp2').bs_po, 1, 'the strikeout is the catcher\'s putout');
  assert.ok(!codes(rp).includes('count_mismatch'));
});

test('count mismatches are flagged, never silently fixed', () => {
  const g = game(); const h = g.half(1, 'top');
  g.pa(h, { result: 'walk' }, ['ball', 'ball', 'ball']);                                  // walk on 3-0
  g.pa(h, { result: 'strikeout' }, ['called_strike', 'called_strike']);                  // K on 0-2
  g.pa(h, { result: 'groundout' }, ['ball', 'called_strike']);                           // out with no in-play pitch
  g.pa(h, { result: 'single' }, ['ball', 'ball', 'ball', 'ball', 'in_play']);            // pitches after ball four
  g.pa(h, { result: 'walk' }, ['ball', 'ball', 'ball', 'ball']);                        // fine
  const rp = g.run();
  const msgs = rp.issues.filter(i => i.code === 'count_mismatch').map(i => i.message);
  assert.equal(msgs.length, 6, JSON.stringify(msgs));   // the single after ball four trips three rules at once
  assert.ok(msgs.some(m => /walk recorded on a 3-0/.test(m)));
  assert.ok(msgs.some(m => /strikeout recorded on a 0-2/.test(m)));
  assert.ok(msgs.some(m => /groundout recorded without an in-play pitch/.test(m)));
  assert.ok(msgs.some(m => /after the at-bat had ended/.test(m)));
});

test('batting fields: 1B/TB, IBB inside BB, SH/SF are not at-bats, ROE and FC, dropped third strike, individual LOB, G, forced advances', () => {
  const g = game(); const h = g.half(1, 'top');
  g.pa(h, { result: 'single' });                                                                                          // Our1 on first
  g.pa(h, { result: 'intentional_walk' });                                                                                // Our2 on first; Our1 forced to second by rule
  g.pa(h, { result: 'sacrifice_bunt', fielders: [1, 3] }, [], [{ from: 2, to: 3, how: 'advance' }, { from: 1, to: 2, how: 'advance' }]);   // out 1
  g.pa(h, { result: 'sacrifice_fly', fielders: [8] }, [], [{ from: 3, to: 4, how: 'scored_on_play' }]);                     // out 2; Our1 scores
  g.pa(h, { result: 'reach_on_error', error_position: 6 });                                                                // Our5 on E6; Our2 still on second
  g.pa(h, { result: 'strikeout_reached' }, ['swinging_strike', 'swinging_strike', 'swinging_strike']);                    // Our6 on a dropped third strike: Our5 → 2nd, Our2 → 3rd, with a warning
  g.pa(h, { result: 'double' }, [], [
    { from: 3, to: 4, how: 'scored_on_play', unearned: false },   // Our2, ruled earned after the error
    { from: 2, to: 4, how: 'scored_on_play' },                    // Our5, who reached on the error: unearned
    { from: 1, to: 3, how: 'advance' },                           // Our6
  ]);
  g.pa(h, { result: 'flyout', fielders: [7] });                                                                          // out 3 with two left on
  const rp = g.run();
  const o = n => S(rp, `p:${n}`);
  assert.equal(o(1).bs_1b, 1); assert.equal(o(1).bs_tb, 1); assert.equal(o(1).bs_r, 1);
  assert.equal(o(2).bs_bb, 1); assert.equal(o(2).bs_ibb, 1); assert.equal(o(2).bs_ab, 0); assert.equal(o(2).bs_r, 1);
  assert.equal(o(3).bs_sh, 1); assert.equal(o(3).bs_ab, 0); assert.equal(o(3).bs_pa, 1); assert.equal(o(3).bs_lob, 2);
  assert.equal(o(4).bs_sf, 1); assert.equal(o(4).bs_ab, 0); assert.equal(o(4).bs_rbi, 1); assert.equal(o(4).bs_lob, 1);
  assert.equal(o(5).bs_roe, 1); assert.equal(o(5).bs_ab, 1); assert.equal(o(5).bs_h, 0); assert.equal(o(5).bs_r, 1);
  assert.equal(o(6).bs_k, 1); assert.equal(o(6).bs_ab, 1); assert.equal(o(6).bs_r, 0);
  assert.equal(o(7).bs_2b, 1); assert.equal(o(7).bs_tb, 2); assert.equal(o(7).bs_rbi, 2);
  assert.equal(o(8).bs_lob, 2, 'Our6 and Our7 were left on when Our8 flew out');
  assert.equal(o(9).bs_g, 1, 'a starter who never batted still has G = 1'); assert.equal(o(9).bs_pa, 0);
  assert.equal(rp.state.score.us, 3);
  const opp = S(rp, 'l:them:Opp1');
  assert.equal(opp.bs_kp, 1); assert.equal(opp.bs_bba, 1); assert.equal(opp.bs_ibba, 1); assert.equal(opp.bs_ra, 3);
  assert.equal(opp.bs_er, 2, 'the runner who reached on the error scores unearned');
  assert.equal(S(rp, 'l:them:Opp6').bs_e, 1, 'their shortstop is charged with the error by position');
  assert.equal(S(rp, 'l:them:Opp1').bs_a, 1); assert.equal(S(rp, 'l:them:Opp3').bs_po, 1, 'sacrifice bunt 1-3');
  assert.equal(S(rp, 'l:them:Opp8').bs_po, 1); assert.equal(S(rp, 'l:them:Opp7').bs_po, 1);
  assert.equal(rp.issues.filter(i => i.code === 'base_occupied').length, 1, 'only the dropped third strike needed an automatic push');
  assert.ok(!codes(rp).includes('er_needs_judgment'), 'the scorer ruled the run after the error');
});

test('fielding credit follows scoring notation: 6-3 is an assist and a putout, 6-4-3 two putouts, two assists and three DP participations, 8 a putout', () => {
  const g = game(); let h = g.half(1, 'top');
  g.pa(h, { result: 'groundout', fielders: [6, 3] });
  g.pa(h, { result: 'single' });
  g.pa(h, { result: 'double_play', fielders: '6-4-3' }, [], [{ from: 1, to: 1, how: 'out', out: true }]);
  h = g.half(1, 'bottom');   // they bat: our centre fielder (player 8) catches a fly
  g.pa(h, { result: 'flyout', fielders: '8' });
  const rp = g.run();
  const f = n => S(rp, `l:them:Opp${n}`);
  assert.equal(f(6).bs_a, 2); assert.equal(f(6).bs_po, 0); assert.equal(f(6).bs_dp, 1);
  assert.equal(f(3).bs_po, 2); assert.equal(f(3).bs_dp, 1);
  assert.equal(f(4).bs_po, 1); assert.equal(f(4).bs_a, 1); assert.equal(f(4).bs_dp, 1);
  assert.equal(S(rp, 'p:8').bs_po, 1);
  assert.equal(T(rp, 'l:them:Opp6').rates.fpct, 1);
  assert.equal(rp.state.outs, 1); assert.equal(rp.state.half, 'bottom');
  assert.ok(!codes(rp).includes('too_many_outs'));
});

test('baserunning: SB, CS, pickoff and SB% — a wild pitch is not a steal', () => {
  const g = game(); const h = g.half(1, 'top');
  g.pa(h, { result: 'single' });
  g.runner(h, { runner_player_id: 1, from: 1, to: 2, how: 'stolen_base' });
  g.runner(h, { runner_player_id: 1, from: 2, to: 3, how: 'wild_pitch' });
  g.runner(h, { runner_player_id: 1, from: 3, to: 3, how: 'pickoff', out: true, fielders: [1, 5] });
  g.pa(h, { result: 'walk' });
  g.runner(h, { runner_player_id: 2, from: 1, to: 2, how: 'caught_stealing', fielders: [2, 6] });
  const rp = g.run();
  assert.equal(S(rp, 'p:1').bs_sb, 1); assert.equal(S(rp, 'p:1').bs_pk, 1); assert.equal(S(rp, 'p:1').bs_cs, 0);
  assert.equal(S(rp, 'p:2').bs_cs, 1); assert.equal(T(rp, 'p:2').rates.sb_pct, 0);
  assert.equal(S(rp, 'l:them:Opp1').bs_wp, 1);
  assert.equal(S(rp, 'l:them:Opp2').bs_a, 1, 'catcher assist on the caught stealing'); assert.equal(S(rp, 'l:them:Opp6').bs_po, 1);
  assert.equal(S(rp, 'l:them:Opp5').bs_po, 1, 'third baseman putout on the pickoff'); assert.equal(S(rp, 'l:them:Opp1').bs_a, 1);
  assert.equal(rp.state.outs, 2);
});

test('pitching: GS to the first pitcher of each side; WP/BK/PB charged once per play; inherited runners counted and scored; HBP and IBB allowed', () => {
  const g = game(); const h = g.half(1, 'top');
  g.pa(h, { result: 'walk' });                                                    // Our1 on
  g.pa(h, { result: 'hit_by_pitch' });                                            // Our2 on
  // one wild pitch moves both runners: two runner events, one play (group)
  g.runner(h, { runner_player_id: 1, from: 2, to: 3, how: 'wild_pitch', group: 'wp1' });
  g.runner(h, { runner_player_id: 2, from: 1, to: 2, how: 'wild_pitch', group: 'wp1' });
  g.runner(h, { runner_player_id: 1, from: 3, to: 4, how: 'passed_ball' });      // Our1 scores on a PB (unearned)
  g.runner(h, { runner_player_id: 2, from: 2, to: 3, how: 'balk' });
  g.sub({ kind: 'pitching_change', side: 'them', player_in_label: 'Relief', slot: 1 });   // Our2 on third is inherited
  g.pa(h, { result: 'single' }, [], [{ from: 3, to: 4, how: 'scored_on_play' }]);       // Our3 singles, Our2 scores: charged to Opp1, IRS for Relief
  const rp = g.run();
  const opp1 = S(rp, 'l:them:Opp1'), relief = S(rp, 'l:them:Relief');
  assert.equal(opp1.bs_gs, 1); assert.equal(relief.bs_gs, 0); assert.equal(relief.bs_g, 1);
  assert.equal(opp1.bs_wp, 1, 'one wild pitch, two runners'); assert.equal(opp1.bs_bk, 1); assert.equal(opp1.bs_hbpa, 1);
  assert.equal(S(rp, 'l:them:Opp2').bs_pb, 1, 'passed ball to the catcher');
  assert.equal(opp1.bs_ra, 2); assert.equal(opp1.bs_er, 1, 'the run on the passed ball is unearned; Our2 is earned (no misplay before the balk? balk is not a misplay)');
  assert.equal(relief.bs_ir, 1); assert.equal(relief.bs_irs, 1); assert.equal(relief.bs_ra, 0); assert.equal(relief.bs_ha, 1);
});

test('earned-run judgment: a run after an error this half is flagged and the pitcher\'s ER is held; the scorer\'s ruling clears it either way', () => {
  const build = ruling => {
    const g = game(); const h = g.half(1, 'top');
    g.pa(h, { result: 'single' });                                     // Our1 on cleanly
    g.pa(h, { result: 'reach_on_error', error_position: 4 });          // Our2 on E4; Our1 to 2nd
    g.pa(h, { result: 'double' }, [], [
      { from: 2, to: 4, how: 'scored_on_play', ...(ruling === undefined ? {} : { unearned: ruling }) },   // Our1 scores — earned? depends on reconstruction
      { from: 1, to: 3, how: 'advance' },
    ]);
    return g.run();
  };
  let rp = build(undefined);
  assert.ok(codes(rp).includes('er_needs_judgment'));
  assert.equal(S(rp, 'l:them:Opp1').bs_er, 1, 'counted earned by default while flagged');
  assert.equal(T(rp, 'l:them:Opp1').er_uncertain, true, 'and marked so the release withholds it');
  rp = build(false);
  assert.ok(!codes(rp).includes('er_needs_judgment')); assert.equal(S(rp, 'l:them:Opp1').bs_er, 1); assert.equal(T(rp, 'l:them:Opp1').er_uncertain, false);
  rp = build(true);
  assert.ok(!codes(rp).includes('er_needs_judgment')); assert.equal(S(rp, 'l:them:Opp1').bs_er, 0);
  // no misplay → no judgment needed
  const g = game(); const h = g.half(1, 'top');
  g.pa(h, { result: 'single' }); g.pa(h, { result: 'home_run' });
  assert.ok(!codes(g.run()).includes('er_needs_judgment'));
});

test('line score and team totals: runs by inning, hits, errors and LOB per side, and the result at final', () => {
  const g = game({ usHome: true });
  let h = g.half(1, 'top');   // they bat
  g.pa(h, { result: 'single' }); g.pa(h, { result: 'reach_on_error', error_position: 6 }); g.pa(h, { result: 'strikeout' }); g.pa(h, { result: 'flyout' }); g.pa(h, { result: 'groundout' });
  h = g.half(1, 'bottom');    // we bat
  g.pa(h, { result: 'home_run' }); g.pa(h, { result: 'strikeout' }); g.pa(h, { result: 'strikeout' }); g.pa(h, { result: 'popout' });
  h = g.half(2, 'top');
  g.pa(h, { result: 'double' }, [], []); g.pa(h, { result: 'single' }, [], [{ from: 2, to: 4, how: 'scored_on_play' }]); g.pa(h, { result: 'groundout' }); g.pa(h, { result: 'groundout' }); g.pa(h, { result: 'groundout' });
  g.final('time_limit');
  const rp = g.run();
  assert.deepEqual(rp.state.line_score.away.runs, [0, 1]); assert.deepEqual(rp.state.line_score.home.runs, [1]);
  assert.equal(rp.state.line_score.away.h, 3); assert.equal(rp.state.line_score.home.h, 1);
  assert.equal(rp.state.line_score.home.e, 1, 'our shortstop\'s error counts against the home side');
  assert.equal(rp.state.line_score.away.lob, 3, 'two left in the first, one in the second');
  assert.equal(rp.state.line_score.home.lob, 0);
  assert.deepEqual(rp.state.result, { us: 1, them: 1, winner: 'tie' });
});

test('rates are null, not zero, when there is nothing to divide by', () => {
  const g = game(); g.half(1, 'top');
  const rp = g.run();
  const r = T(rp, 'p:1').rates;   // a starter who has not batted
  assert.equal(r.avg, null); assert.equal(r.obp, null); assert.equal(r.ops, null); assert.equal(r.era, null); assert.equal(r.whip, null); assert.equal(r.sb_pct, null); assert.equal(r.fpct, null);
  const stats = { bs_h: 2, bs_ab: 4, bs_bb: 1, bs_hbp: 0, bs_sf: 1, bs_tb: 5, bs_k: 1, bs_pa: 6, bs_er: 2, bs_bba: 3, bs_ha: 4, bs_kp: 6, bs_strikes: 40, bs_pitches: 60, bs_whiffs_a: 5, bs_swings_a: 20, bs_cstr: 10, bs_po: 3, bs_a: 2, bs_e: 1, bs_sb: 3, bs_cs: 1 };
  const x = ratesFor(stats, 18);   // 6 innings
  assert.deepEqual([x.avg, x.obp, x.slg, x.ops], [0.5, 0.5, 1.25, 1.75]);
  assert.deepEqual([x.era, x.whip, x.k_per_9, x.bb_per_9, x.k_bb], [3, 1.17, 9, 4.5, 2]);
  assert.deepEqual([x.strike_pct, x.whiff_pct, x.csw_pct, x.fpct, x.sb_pct], [0.667, 0.25, 0.25, 0.833, 0.75]);
});

test('fielders notation normalises and rejects nonsense', () => {
  assert.deepEqual(normalizeFielders('6-3'), [6, 3]); assert.deepEqual(normalizeFielders('643'), [6, 4, 3]); assert.deepEqual(normalizeFielders([8]), [8]);
  assert.equal(normalizeFielders(''), undefined);
  assert.throws(() => normalizeFielders([0]), /1–9/);
});
