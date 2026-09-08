// Core scorekeeping (Phase 2, TDR §7). Events live on cmd_events; everything
// else — game state, lineups, box-score tallies — is REPLAYED from the active
// events, deterministically and versioned. A correction upstream therefore
// recalculates everything downstream by construction: no stale tallies, no
// duplicate tags, no second source of truth.
//
// Event types (payload shapes validated in validatePayload):
//   lineup            { side: 'us'|'them', us_is_home?, dh?, slots: [{ slot, player_id?, label?, position? }] }
//   half_inning       { inning, half: 'top'|'bottom', auto? }
//   plate_appearance  { batter_player_id?, batter_label?, pitcher_player_id?, pitcher_label?, result, rbi?, batted_ball?, direction?, fielders?: [6,3], error_player_id?, error_label?, error_position?, unearned?, out_of_order_ok?, pitch_count?, note? }
//   pitch             { result: ball|called_strike|swinging_strike|foul|foul_tip|foul_bunt|check_swing_strike|in_play|hit_by_pitch|intentional_ball, pitch_type?, radar_reading_id? }
//                     — a linked radar reading is matched to the pitcher of record (our pitchers only) through the
//                       radar lifecycle, so the velocity publishes once, from one row (PRD §5.1 "when known").
//   plate_appearance  … time_home_to_first?: true queues a home-to-first timing attempt for the batter at the play's moment
//   runner            … time_steal?: true queues a steal timing attempt for the runner; attempt_id? links an existing one
//   runner            { runner_player_id?, runner_label?, from: 1|2|3, to: 1|2|3|4, how, out?, fielders?, unearned?, group?, error_player_id?, error_label?, error_position?, note? }
//
// The calculation contract is the Metric Recipe Appendix, "V1 Scorekeeping and
// Derived Box-Score Rules": pitch accounting (foul-strike rule, foul bunt and
// foul tip on strike three), the stored batting / pitching / fielding /
// baserunning fields, rate formulas that return null on a zero denominator,
// and scorer judgment for earned runs (uncertain → needs review, never a guess).
//   substitution      { kind, side, slot?, base?, player_in_id?, player_in_label?, player_out_id?, player_out_label?, position? }
//   game_final        { reason: regulation|run_rule|time_limit|forfeit|darkness|other, note? }
//   state_adjustment  { outs?, score?: {us?, them?}, bases?: {1|2|3: {player_id?|label?}|null}, next_slot?: {us?, them?}, note }
//                     — PRD §5.5 "edit count/outs/bases/score only when the derived state is incorrect; correction reason".
//                     Applied at its point in the log and surfaced to reviewers as an info issue; never silent.
import { commandRoster } from './commandRoster.js';
import { classifyReading, PITCH_TYPES } from './radarImport.js';
import { createAttempt } from './measurementLogic.js';

export const SCOREBOOK_VERSION = 'CMD_SCOREBOOK_V1';
export const EVENT_TYPES = ['lineup', 'half_inning', 'plate_appearance', 'pitch', 'runner', 'substitution', 'game_final', 'state_adjustment'];
export const PA_RESULTS = [
  'single', 'double', 'triple', 'home_run',
  'walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference',
  'strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout',
  'sacrifice_fly', 'sacrifice_bunt', 'fielders_choice', 'reach_on_error', 'double_play', 'triple_play',
  'strikeout_reached',   // dropped third strike: a strikeout for batter and pitcher, but the batter is on first
];
export const PITCH_RESULTS = ['ball', 'called_strike', 'swinging_strike', 'foul', 'foul_tip', 'foul_bunt', 'check_swing_strike', 'in_play', 'hit_by_pitch', 'intentional_ball'];
export const POSITION_NUMBERS = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };
// Pitch classes for pitch totals and swing/contact accounting (appendix):
// strikes thrown include fouls and balls in play; a check swing called a
// strike is a swing and a miss; fouls, foul tips and balls in play are contact.
const STRIKE_PITCHES = new Set(['called_strike', 'swinging_strike', 'foul', 'foul_tip', 'foul_bunt', 'check_swing_strike', 'in_play']);
const BALL_PITCHES = new Set(['ball', 'intentional_ball', 'hit_by_pitch']);
const SWING_PITCHES = new Set(['swinging_strike', 'check_swing_strike', 'foul', 'foul_tip', 'foul_bunt', 'in_play']);
const WHIFF_PITCHES = new Set(['swinging_strike', 'check_swing_strike']);
const STRIKEOUTS = new Set(['strikeout', 'strikeout_looking', 'strikeout_reached']);
const IN_PLAY_RESULTS = new Set(['single', 'double', 'triple', 'home_run', 'groundout', 'flyout', 'lineout', 'popout', 'sacrifice_fly', 'sacrifice_bunt', 'fielders_choice', 'reach_on_error', 'double_play', 'triple_play']);
export const RUNNER_HOWS = ['advance', 'stolen_base', 'caught_stealing', 'pickoff', 'wild_pitch', 'passed_ball', 'balk', 'error', 'out', 'scored_on_play', 'defensive_indifference'];
export const SUB_KINDS = ['pinch_hitter', 'pinch_runner', 'courtesy_runner', 'defensive', 'pitching_change', 're_entry'];
export const FINAL_REASONS = ['regulation', 'run_rule', 'time_limit', 'forfeit', 'darkness', 'other'];
export const BATTED_BALLS = ['ground_ball', 'line_drive', 'fly_ball', 'popup', 'bunt'];
export const DIRECTIONS = ['pull', 'middle', 'opposite'];

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const HIT = new Set(['single', 'double', 'triple', 'home_run']);
const NO_AB = new Set(['walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference', 'sacrifice_fly', 'sacrifice_bunt']);
const OUT_RESULTS = new Set(['strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout', 'sacrifice_fly', 'sacrifice_bunt', 'double_play', 'triple_play']);
const ON_BASE = { single: 1, double: 2, triple: 3, home_run: 4, walk: 1, intentional_walk: 1, hit_by_pitch: 1, catcher_interference: 1, fielders_choice: 1, reach_on_error: 1, strikeout_reached: 1 };

// The count after a sequence of pitches, and how the at-bat ended if the
// pitches decided it. Fouls add a strike only before two strikes; a foul bunt
// or a foul tip is a strike even on two (strike three); balls in play and a
// hit batter change neither count. Pitches after the at-bat ended are
// returned so the replay can flag them.
export function countAfter(pitches) {
  let balls = 0, strikes = 0, ended = null;
  const overflow = [];
  for (const p of pitches) {
    const r = p.result;
    if (ended) { overflow.push(r); continue; }
    if (r === 'ball' || r === 'intentional_ball') balls += 1;
    else if (r === 'foul') { if (strikes < 2) strikes += 1; }
    else if (r === 'called_strike' || r === 'swinging_strike' || r === 'check_swing_strike' || r === 'foul_tip' || r === 'foul_bunt') strikes += 1;
    else if (r === 'in_play') ended = 'in_play';
    else if (r === 'hit_by_pitch') ended = 'hit_by_pitch';
    if (!ended && balls >= 4) ended = 'walk';
    if (!ended && strikes >= 3) ended = r === 'called_strike' ? 'strikeout_looking' : 'strikeout';
  }
  return { balls: Math.min(balls, 4), strikes: Math.min(strikes, 3), ended, overflow };
}

// Rate stats per the appendix; null (not zero) when the denominator is zero.
const ratio = (num, den, digits = 3) => (den > 0 ? Number((num / den).toFixed(digits)) : null);
export function ratesFor(s, outsPitched = 0) {
  const ip = outsPitched / 3;
  const avg = ratio(s.bs_h, s.bs_ab);
  const obp = ratio(s.bs_h + s.bs_bb + s.bs_hbp, s.bs_ab + s.bs_bb + s.bs_hbp + s.bs_sf);
  const slg = ratio(s.bs_tb, s.bs_ab);
  const per9 = n => (ip > 0 ? Number((9 * n / ip).toFixed(2)) : null);
  return {
    avg, obp, slg, ops: obp != null && slg != null ? Number((obp + slg).toFixed(3)) : null,
    k_pct: ratio(s.bs_k, s.bs_pa), bb_pct: ratio(s.bs_bb, s.bs_pa),
    era: per9(s.bs_er), whip: ip > 0 ? Number(((s.bs_bba + s.bs_ha) / ip).toFixed(2)) : null,
    k_per_9: per9(s.bs_kp), bb_per_9: per9(s.bs_bba), k_bb: ratio(s.bs_kp, s.bs_bba, 2),
    strike_pct: ratio(s.bs_strikes, s.bs_pitches), whiff_pct: ratio(s.bs_whiffs_a, s.bs_swings_a), csw_pct: ratio(s.bs_cstr + s.bs_whiffs_a, s.bs_pitches),
    fpct: ratio(s.bs_po + s.bs_a, s.bs_po + s.bs_a + s.bs_e), sb_pct: ratio(s.bs_sb, s.bs_sb + s.bs_cs),
  };
}

// ── Player references ──────────────────────────────────────────────────────
// Our players are rows; opponents are labels. Either way a ref has a stable key.
export const refKey = r => (r?.player_id ? `p:${r.player_id}` : `l:${r?.side || '?'}:${r?.label || '?'}`);
const mkRef = (side, player_id, label) => ({ side, player_id: player_id ?? null, label: label || (player_id ? '' : 'unknown') });

// ── Payload validation ─────────────────────────────────────────────────────
// "6-3", "63" or [6, 3] → [6, 3]; positions must be 1–9.
export function normalizeFielders(v) {
  if (v == null || v === '') return undefined;
  const nums = Array.isArray(v) ? v.map(Number) : String(v).replace(/[^1-9]/g, '').split('').map(Number);
  if (!nums.length || nums.some(n => !Number.isInteger(n) || n < 1 || n > 9)) throw err('fielders must be position numbers 1–9, e.g. "6-3"');
  return nums;
}

export function validatePayload(type, p = {}) {
  const need = (cond, msg) => { if (!cond) throw err(msg); };
  if (type === 'plate_appearance' || type === 'runner') {
    if ('fielders' in p) { const f = normalizeFielders(p.fielders); if (f) p.fielders = f; else delete p.fielders; }
    if (p.error_position != null) need(Number.isInteger(p.error_position) && p.error_position >= 1 && p.error_position <= 9, 'error_position must be 1–9');
    if (p.unearned != null) need(typeof p.unearned === 'boolean', 'unearned must be true or false');
  }
  switch (type) {
    case 'lineup':
      need(['us', 'them'].includes(p.side), "lineup.side must be 'us' or 'them'");
      need(Array.isArray(p.slots) && p.slots.length >= 1, 'lineup needs at least one slot');
      p.slots.forEach((s, i) => need(Number.isInteger(s.slot) && s.slot >= 1, `slot ${i + 1} needs a batting-order number`));
      if (p.side === 'us') need(typeof p.us_is_home === 'boolean', 'the us lineup must say whether we are home (us_is_home)');
      return;
    case 'half_inning':
      need(Number.isInteger(p.inning) && p.inning >= 1, 'half_inning.inning must be a positive integer');
      need(['top', 'bottom'].includes(p.half), "half_inning.half must be 'top' or 'bottom'");
      return;
    case 'plate_appearance':
      need(PA_RESULTS.includes(p.result), `result must be one of ${PA_RESULTS.join(', ')}`);
      if (p.rbi != null) need(Number.isInteger(p.rbi) && p.rbi >= 0 && p.rbi <= 4, 'rbi must be 0–4');
      if (p.batted_ball) need(BATTED_BALLS.includes(p.batted_ball), `batted_ball must be one of ${BATTED_BALLS.join(', ')}`);
      if (p.direction) need(DIRECTIONS.includes(p.direction), `direction must be one of ${DIRECTIONS.join(', ')}`);
      if (p.pitch_count != null) need(Number.isInteger(p.pitch_count) && p.pitch_count >= 0, 'pitch_count must be a whole number');
      if (p.time_home_to_first != null) need(typeof p.time_home_to_first === 'boolean', 'time_home_to_first must be true or false');
      if (p.attempt_id != null) need(Number.isInteger(p.attempt_id) && p.attempt_id > 0, 'attempt_id must be a running attempt id');
      return;
    case 'pitch':
      need(PITCH_RESULTS.includes(p.result), `pitch result must be one of ${PITCH_RESULTS.join(', ')}`);
      if (p.pitch_type != null && p.pitch_type !== '') need(PITCH_TYPES.includes(p.pitch_type), `pitch_type must be one of ${PITCH_TYPES.join(', ')}`);
      if (p.radar_reading_id != null) need(Number.isInteger(p.radar_reading_id) && p.radar_reading_id > 0, 'radar_reading_id must be a reading id');
      return;
    case 'runner':
      need([1, 2, 3].includes(p.from), 'runner.from must be 1, 2 or 3');
      need([1, 2, 3, 4].includes(p.to), 'runner.to must be 1–4 (4 = home)');
      need(RUNNER_HOWS.includes(p.how), `how must be one of ${RUNNER_HOWS.join(', ')}`);
      if (!p.out) need(p.to > p.from || p.how === 'out', 'a runner who is not out must advance');
      if (p.attempt_id != null) need(Number.isInteger(p.attempt_id) && p.attempt_id > 0, 'attempt_id must be a running attempt id');
      if (p.time_steal != null) need(typeof p.time_steal === 'boolean', 'time_steal must be true or false');
      return;
    case 'substitution':
      need(SUB_KINDS.includes(p.kind), `kind must be one of ${SUB_KINDS.join(', ')}`);
      need(['us', 'them'].includes(p.side), "substitution.side must be 'us' or 'them'");
      if (['pinch_hitter', 'defensive', 're_entry'].includes(p.kind)) need(Number.isInteger(p.slot), `${p.kind} needs the lineup slot`);
      if (['pinch_runner', 'courtesy_runner'].includes(p.kind)) need([1, 2, 3].includes(p.base), `${p.kind} needs the base (1–3)`);
      need(p.player_in_id || p.player_in_label, 'substitution needs the incoming player');
      return;
    case 'game_final':
      need(FINAL_REASONS.includes(p.reason), `reason must be one of ${FINAL_REASONS.join(', ')}`);
      return;
    case 'state_adjustment': {
      need(typeof p.note === 'string' && p.note.trim().length >= 3, 'a state adjustment needs a reason (note)');
      need(['outs', 'score', 'bases', 'next_slot'].some(k => p[k] !== undefined), 'a state adjustment must change outs, score, bases or the batting-order pointer');
      if (p.outs !== undefined) need(Number.isInteger(p.outs) && p.outs >= 0 && p.outs <= 3, 'outs must be 0–3');
      if (p.score !== undefined) { need(p.score && typeof p.score === 'object', 'score must be { us?, them? }'); for (const side of ['us', 'them']) if (p.score[side] !== undefined) need(Number.isInteger(p.score[side]) && p.score[side] >= 0, `score.${side} must be a whole number`); }
      if (p.bases !== undefined) { need(p.bases && typeof p.bases === 'object', 'bases must be { 1?, 2?, 3? }'); for (const b of Object.keys(p.bases)) { need(['1', '2', '3'].includes(b), 'bases keys are 1, 2, 3'); const r = p.bases[b]; need(r === null || (r && typeof r === 'object' && (r.player_id || r.label)), `bases.${b} must be null or a player`); } }
      if (p.next_slot !== undefined) { need(p.next_slot && typeof p.next_slot === 'object', 'next_slot must be { us?, them? }'); for (const side of ['us', 'them']) if (p.next_slot[side] !== undefined) need(Number.isInteger(p.next_slot[side]) && p.next_slot[side] >= 1, `next_slot.${side} must be a batting-order number`); }
      return;
    }
    default:
      throw err(`Unknown scorebook event type ${type}`);
  }
}

// ── Replay ─────────────────────────────────────────────────────────────────
// One row per player, every stored field of the appendix's batting, pitching,
// fielding and baserunning box scores. Innings pitched live as outs.
function emptyTally() {
  return {
    // batting
    bs_g: 0, bs_pa: 0, bs_ab: 0, bs_r: 0, bs_h: 0, bs_1b: 0, bs_2b: 0, bs_3b: 0, bs_hr: 0, bs_tb: 0, bs_rbi: 0, bs_bb: 0, bs_ibb: 0, bs_k: 0, bs_hbp: 0,
    bs_sh: 0, bs_sf: 0, bs_roe: 0, bs_fc: 0, bs_lob: 0, bs_swings: 0, bs_whiffs: 0,
    // baserunning
    bs_sb: 0, bs_cs: 0, bs_pk: 0,
    // pitching
    bs_gs: 0, bs_bf: 0, bs_pitches: 0, bs_strikes: 0, bs_balls: 0, bs_cstr: 0, bs_swings_a: 0, bs_whiffs_a: 0,
    bs_ha: 0, bs_ra: 0, bs_er: 0, bs_bba: 0, bs_ibba: 0, bs_hbpa: 0, bs_kp: 0, bs_hra: 0, bs_wp: 0, bs_bk: 0, bs_ir: 0, bs_irs: 0, outs_pitched: 0,
    // fielding
    bs_po: 0, bs_a: 0, bs_e: 0, bs_dp: 0, bs_pb: 0,
  };
}

export function ipFromOuts(outs) {
  return Number(`${Math.floor(outs / 3)}.${outs % 3}`);
}

// events: active rows only (status 'active'), ordered by sequence, id. Rows
// with status 'needs_review' are passed in `disputed` (a Set of ids) so their
// contributions can be excluded while the game still flows.
export function replay(events, { ruleset = {}, disputed = new Set() } = {}) {
  const innings = ruleset.innings || 7;
  const state = {
    inning: 0, half: null, batting: null, outs: 0, balls: 0, strikes: 0,
    bases: { 1: null, 2: null, 3: null },
    score: { us: 0, them: 0 },
    lineups: { us: null, them: null }, us_is_home: null,
    next_slot: { us: 1, them: 1 },
    pitcher: { us: null, them: null },        // pitcher currently pitching FOR each side
    used: { us: new Set(), them: new Set() }, // players who have appeared (re-entry rule)
    starters: { us: new Set(), them: new Set() },
    reentered: { us: new Set(), them: new Set() },
    open_pa: null, half_complete: false, final: null, game_over_suggested: null, innings_completed: 0,
    line_score: { us: [], them: [] },                                   // runs per inning, per side
    team: { us: { r: 0, h: 0, e: 0, lob: 0 }, them: { r: 0, h: 0, e: 0, lob: 0 } },
    half_misplay: null,                                                 // first error / passed ball by the defense this half
    pitching_started: { us: false, them: false },                       // GS bookkeeping
  };
  const tallies = new Map();
  const names = new Map();
  const erUncertain = new Set();   // pitchers with a run whose earned status awaits scorer judgment
  const chargedPlays = new Set();  // one WP / PB / BK per play, however many runners moved
  const issues = [];
  const log = [];
  const tally = ref => {
    const k = refKey(ref);
    if (!tallies.has(k)) tallies.set(k, emptyTally());
    if (!names.has(k)) names.set(k, ref);
    return tallies.get(k);
  };
  const issue = (code, level, event, message) => issues.push({ code, level, event_id: event?.id ?? null, sequence: event?.sequence ?? null, message });
  const fieldingSide = () => (state.batting === 'us' ? 'them' : 'us');
  const currentBatterRef = side => {
    const lu = state.lineups[side];
    if (!lu) return null;
    const slot = lu.slots.find(s => s.slot === state.next_slot[side]) || lu.slots[0];
    return slot ? { ...slot.current, slot: slot.slot } : null;
  };
  const byId = new Map(events.map(e => [e.id, e]));
  const paChildren = new Map();
  for (const e of events) if (e.parent_event_id && (e.event_type === 'pitch' || e.event_type === 'runner')) {
    if (!paChildren.has(e.parent_event_id)) paChildren.set(e.parent_event_id, []);
    paChildren.get(e.parent_event_id).push(e);
  }
  const isDisputed = e => disputed.has(e.id) || (e.parent_event_id && disputed.has(e.parent_event_id));

  // Who is playing position n (1–9) for a side right now: the lineup's
  // position labels, with the pitcher of record as the fallback for 1.
  const fielderAt = (side, n) => {
    const lu = state.lineups[side];
    const slot = lu?.slots.find(x => POSITION_NUMBERS[(x.position || '').toUpperCase()] === n);
    if (slot) return slot.current;
    return n === 1 ? state.pitcher[side] : null;
  };
  // Scoring notation "6-4-3": every fielder but the last threw (assist), the
  // last `outs` fielders recorded a putout, and everyone on a double / triple
  // play shares DP participation. Unknown positions are skipped, never guessed.
  const creditFielders = (positions, { outs = 1, dp = false } = {}) => {
    let list = [];
    try { list = normalizeFielders(positions) || []; } catch { list = []; }
    const refs = list.map(n => fielderAt(fieldingSide(), n)).filter(Boolean);
    if (!refs.length) return;
    refs.slice(0, -1).forEach(r => { tally(r).bs_a += 1; });
    refs.slice(-Math.min(outs, refs.length)).forEach(r => { tally(r).bs_po += 1; });
    if (dp) for (const k of new Set(refs.map(refKey))) tally(refs.find(r => refKey(r) === k)).bs_dp += 1;
  };
  const errorBy = (side, pl) => (pl.error_player_id || pl.error_label ? mkRef(side, pl.error_player_id, pl.error_label) : (pl.error_position ? fielderAt(side, pl.error_position) : null));
  const noteMisplay = (kind, e) => { if (!state.half_misplay) state.half_misplay = { sequence: e.sequence, kind }; };
  // WP / BK go to the pitcher of record, PB to the catcher — once per play.
  const chargeMisplay = (how, e) => {
    const parent = e.parent_event_id ? byId.get(e.parent_event_id) : null;
    const key = `${how}:${e.payload?.group ? `g:${e.payload.group}` : parent?.event_type === 'plate_appearance' ? `pa:${parent.id}` : `ev:${e.id}`}`;
    if (chargedPlays.has(key) || isDisputed(e)) return;
    chargedPlays.add(key);
    if (how === 'passed_ball') { const c = fielderAt(fieldingSide(), 2); if (c) tally(c).bs_pb += 1; noteMisplay('a passed ball', e); }
    else { const pit = state.pitcher[fieldingSide()]; if (pit) tally(pit)[how === 'balk' ? 'bs_bk' : 'bs_wp'] += 1; }
  };
  const runnersOn = () => [1, 2, 3].filter(b => state.bases[b]).length;

  // A run: team score and line score always; per-player credit unless the
  // play is disputed. The run is charged to the pitcher responsible for the
  // runner; if someone else is on the mound it is also an inherited runner
  // scored. Earned unless the runner reached or advanced on a misplay, the
  // scorer said unearned, or — when a misplay happened earlier this half and
  // the scorer has not ruled — it is flagged for judgment and the pitcher's ER
  // is withheld from publication until they do.
  const scoreRun = (runner, batterRef, how, e) => {
    state.score[state.batting] += 1;
    state.team[state.batting].r += 1;
    const ls = state.line_score[state.batting];
    while (ls.length < state.inning) ls.push(0);
    ls[state.inning - 1] += 1;
    if (isDisputed(e)) return;
    tally(runner.ref).bs_r += 1;
    if (runner.responsible) {
      const t = tally(runner.responsible);
      t.bs_ra += 1;
      const cur = state.pitcher[fieldingSide()];
      if (cur && refKey(cur) !== refKey(runner.responsible)) tally(cur).bs_irs += 1;
      const ruled = typeof e.payload?.unearned === 'boolean' ? e.payload.unearned : undefined;
      const unearned = ruled ?? (runner.unearned || ['error', 'passed_ball'].includes(how));
      if (!unearned) t.bs_er += 1;
      if (ruled === undefined && !unearned && state.half_misplay && state.half_misplay.sequence <= e.sequence) {
        issue('er_needs_judgment', 'warning', e, `${runner.ref.label || 'runner'} scored after ${state.half_misplay.kind} this half — rule the run earned or unearned`);
        erUncertain.add(refKey(runner.responsible));
      }
    }
  };
  const recordOut = (e) => {
    if (state.outs >= 3) { issue('too_many_outs', 'warning', e, 'A fourth out was recorded in this half — check the play before it'); return; }
    state.outs += 1;
    const p = state.pitcher[fieldingSide()];
    if (p && !isDisputed(e)) tally(p).outs_pitched += 1;
  };
  const endHalfIfDone = () => {
    if (state.outs >= 3) {
      state.half_complete = true;
      state.team[state.batting].lob += runnersOn();
      state.bases = { 1: null, 2: null, 3: null };
      if (state.half === 'bottom') state.innings_completed = state.inning;
      // game-over suggestions from the ruleset
      const homeSide = state.us_is_home ? 'us' : 'them';
      const awaySide = homeSide === 'us' ? 'them' : 'us';
      const lead = state.score[homeSide] - state.score[awaySide];
      const completedInning = state.half === 'bottom' ? state.inning : state.inning - 1;
      const rr = (ruleset.run_rule || []).find(r => completedInning >= r.after_inning && Math.abs(lead) >= r.margin && (state.half === 'bottom' || lead < 0));
      if (rr) state.game_over_suggested = { reason: 'run_rule', detail: `${Math.abs(lead)}-run margin after ${completedInning} innings` };
      else if (state.half === 'bottom' && state.inning >= innings && lead !== 0) state.game_over_suggested = { reason: 'regulation', detail: `${state.inning} innings complete` };
      else if (state.half === 'top' && state.inning >= innings && lead > 0) state.game_over_suggested = { reason: 'regulation', detail: 'home team leads after the top of the final inning' };
    }
  };

  for (const e of events) {
    const p = e.payload || {};
    const dis = isDisputed(e);
    const entry = { id: e.id, sequence: e.sequence, type: e.event_type, inning: state.inning, half: state.half, outs_before: state.outs, disputed: dis, text: '',
      timecode_s: e.timecode_s ?? null, feed_id: e.selected_feed_id ?? null, clip: e.clip_start_s != null ? [e.clip_start_s, e.clip_end_s] : null };
    switch (e.event_type) {
      case 'lineup': {
        const slots = (p.slots || []).map(s => {
          const ref = mkRef(p.side, s.player_id, s.label || (s.player_id ? '' : `#${s.slot}`));
          return { slot: s.slot, position: s.position || '', starter: ref, current: ref };
        });
        state.lineups[p.side] = { slots, dh: !!p.dh };
        for (const s of slots) { state.starters[p.side].add(refKey(s.starter)); state.used[p.side].add(refKey(s.starter)); names.set(refKey(s.starter), s.starter); tally(s.starter).bs_g = 1; }
        if (p.side === 'us') state.us_is_home = !!p.us_is_home;
        if (p.pitcher_player_id || p.pitcher_label) state.pitcher[p.side] = mkRef(p.side, p.pitcher_player_id, p.pitcher_label);
        else { const pit = slots.find(s => (s.position || '').toUpperCase() === 'P'); if (pit) state.pitcher[p.side] = pit.starter; }
        entry.text = `${p.side === 'us' ? 'Our' : 'Their'} lineup: ${slots.length} slots${state.pitcher[p.side] ? `, ${state.pitcher[p.side].label || 'pitcher'} pitching` : ''}`;
        break;
      }
      case 'half_inning': {
        if (state.half && !state.half_complete && state.outs < 3) issue('half_inning_short', 'warning', e, `${state.half} ${state.inning} ended with ${state.outs} out${state.outs === 1 ? '' : 's'}`);
        if (state.us_is_home == null) issue('lineup_missing', 'blocking', e, 'Our lineup (with home/away) must be entered before play');
        state.inning = p.inning; state.half = p.half; state.outs = 0; state.balls = 0; state.strikes = 0;
        state.bases = { 1: null, 2: null, 3: null }; state.half_complete = false; state.open_pa = null; state.half_misplay = null;
        const awaySide = state.us_is_home ? 'them' : 'us';
        state.batting = p.half === 'top' ? awaySide : (awaySide === 'us' ? 'them' : 'us');
        if (!state.lineups[state.batting]) issue('lineup_missing', 'blocking', e, `${state.batting === 'us' ? 'Our' : 'Their'} lineup is missing`);
        if (!state.pitcher[fieldingSide()]) issue('pitcher_missing', 'warning', e, `No pitcher set for ${fieldingSide() === 'us' ? 'us' : 'them'} — pitching stats cannot be attributed`);
        // extra-inning tiebreaker: runner on second
        if (p.inning > innings && ruleset.tiebreaker === 'runner_on_second') {
          const lu = state.lineups[state.batting];
          if (lu) {
            const prevSlot = ((state.next_slot[state.batting] - 2 + lu.slots.length) % lu.slots.length) + 1;
            const s = lu.slots.find(x => x.slot === prevSlot);
            if (s) state.bases[2] = { ref: s.current, responsible: state.pitcher[fieldingSide()], unearned: true, reached: 'tiebreaker' };
          }
        }
        entry.inning = p.inning; entry.half = p.half;
        entry.text = `${p.half === 'top' ? 'Top' : 'Bottom'} ${p.inning} — ${state.batting === 'us' ? 'we bat' : 'they bat'}${p.auto ? ' (auto)' : ''}`;
        break;
      }
      case 'substitution': {
        const side = p.side;
        const inRef = mkRef(side, p.player_in_id, p.player_in_label);
        const lu = state.lineups[side];
        if (!lu) { issue('lineup_missing', 'blocking', e, 'Substitution before a lineup'); break; }
        const inKey = refKey(inRef);
        if (p.kind === 're_entry') {
          if (ruleset.re_entry === 'none') issue('reentry_not_allowed', 'warning', e, 'Ruleset does not allow re-entry');
          else if (!state.starters[side].has(inKey)) issue('reentry_not_starter', 'warning', e, `${inRef.label || 'player'} was not a starter and cannot re-enter`);
          else if (ruleset.re_entry === 'starters_once' && state.reentered[side].has(inKey)) issue('reentry_twice', 'warning', e, `${inRef.label || 'player'} already re-entered once`);
          state.reentered[side].add(inKey);
        } else if (state.used[side].has(inKey) && !state.starters[side].has(inKey) && p.kind !== 'pitching_change' && p.kind !== 'courtesy_runner') {
          issue('player_reused', 'warning', e, `${inRef.label || 'player'} already left the game`);
        }
        if (p.kind !== 'courtesy_runner') { state.used[side].add(inKey); tally(inRef).bs_g = 1; }   // a courtesy runner has not entered the game
        names.set(inKey, inRef);
        if (['pinch_hitter', 'defensive', 're_entry'].includes(p.kind)) {
          const s = lu.slots.find(x => x.slot === p.slot);
          if (!s) issue('slot_missing', 'warning', e, `Slot ${p.slot} is not in the lineup`);
          else { s.current = inRef; if (p.position) s.position = p.position; if ((p.position || '').toUpperCase() === 'P') state.pitcher[side] = inRef; }
        } else if (p.kind === 'pinch_runner' || p.kind === 'courtesy_runner') {
          const r = state.bases[p.base];
          if (!r) issue('no_runner_on_base', 'warning', e, `No runner on ${p.base} to replace`);
          else state.bases[p.base] = { ...r, ref: inRef, courtesy: p.kind === 'courtesy_runner', replaced: r.ref };
          if (p.kind === 'courtesy_runner' && ruleset.courtesy_runner === 'none') issue('courtesy_not_allowed', 'warning', e, 'Ruleset does not allow courtesy runners');
        } else if (p.kind === 'pitching_change') {
          // Runners on base when a reliever enters are inherited: they stay
          // charged to the pitcher who put them on, and count against the
          // reliever as inherited runners (scored when they come home).
          if (state.batting && state.batting !== side && state.half && !state.half_complete && !dis) tally(inRef).bs_ir += runnersOn();
          state.pitcher[side] = inRef;   // inherited runners keep their responsible pitcher
          if (p.slot) { const s = lu.slots.find(x => x.slot === p.slot); if (s) { s.current = inRef; s.position = 'P'; } }
          // position labels follow the ball: whoever is pitching shows P, the previous pitcher no longer does
          for (const s of lu.slots) {
            if (refKey(s.current) === inKey) s.position = 'P';
            else if ((s.position || '').toUpperCase() === 'P') s.position = '';
          }
        }
        entry.text = `${p.kind.replace(/_/g, ' ')}: ${inRef.label || inRef.player_id}${p.player_out_label || p.player_out_id ? ` for ${p.player_out_label || p.player_out_id}` : ''}${p.base ? ` at ${p.base}B` : ''}${p.slot ? ` (slot ${p.slot})` : ''}`;
        break;
      }
      case 'plate_appearance': {
        if (!state.half) { issue('no_half_inning', 'blocking', e, 'Plate appearance before any half inning'); break; }
        if (state.half_complete) issue('pa_after_three_outs', 'warning', e, 'Plate appearance recorded after the third out');
        const side = state.batting;
        const expected = currentBatterRef(side);
        const batter = p.batter_player_id || p.batter_label ? mkRef(side, p.batter_player_id, p.batter_label) : (expected ? { ...expected } : mkRef(side, null, 'unknown batter'));
        if (expected && refKey(expected) !== refKey(batter) && !p.out_of_order_ok) issue('batting_out_of_order', 'warning', e, `Expected ${expected.label || `slot ${expected.slot}`} to bat, got ${batter.label || batter.player_id}`);
        const pitcher = p.pitcher_player_id || p.pitcher_label ? mkRef(fieldingSide(), p.pitcher_player_id, p.pitcher_label) : state.pitcher[fieldingSide()];
        const kids = (paChildren.get(e.id) || []).filter(k => !disputed.has(k.id));
        const pitches = kids.filter(k => k.event_type === 'pitch');
        const runners = kids.filter(k => k.event_type === 'runner');
        const bt = dis ? emptyTally() : tally(batter);
        const pt = pitcher && !dis ? tally(pitcher) : emptyTally();
        state.balls = 0; state.strikes = 0;
        bt.bs_g = 1;
        if (pitcher) { pt.bs_g = 1; if (!state.pitching_started[fieldingSide()]) { state.pitching_started[fieldingSide()] = true; tally(pitcher).bs_gs = 1; } }
        // pitches: totals, strikes/balls thrown, swings and misses, and the count they build
        const pitchCount = pitches.length || p.pitch_count || 0;
        pt.bs_pitches += pitchCount;
        for (const k of pitches) {
          const r = k.payload?.result;
          if (STRIKE_PITCHES.has(r)) pt.bs_strikes += 1; else if (BALL_PITCHES.has(r)) pt.bs_balls += 1;
          if (r === 'called_strike') pt.bs_cstr += 1;
          if (SWING_PITCHES.has(r)) { bt.bs_swings += 1; pt.bs_swings_a += 1; }
          if (WHIFF_PITCHES.has(r)) { bt.bs_whiffs += 1; pt.bs_whiffs_a += 1; }
        }
        if (pitches.length) {
          const cnt = countAfter(pitches.map(k => ({ result: k.payload?.result })));
          const res0 = p.result;
          const mismatch = msg => issue('count_mismatch', 'warning', e, msg);
          if (cnt.overflow.length) mismatch(`${cnt.overflow.length} pitch${cnt.overflow.length === 1 ? '' : 'es'} recorded after the at-bat had ended`);
          if (cnt.ended === 'walk' && !['walk', 'intentional_walk'].includes(res0)) mismatch(`four balls recorded but the result is ${res0.replace(/_/g, ' ')}`);
          if ((res0 === 'walk' || res0 === 'intentional_walk') && cnt.ended !== 'walk') mismatch(`walk recorded on a ${cnt.balls}-${cnt.strikes} count`);
          if (cnt.ended && cnt.ended.startsWith('strikeout') && !STRIKEOUTS.has(res0)) mismatch(`strike three recorded but the result is ${res0.replace(/_/g, ' ')}`);
          if (STRIKEOUTS.has(res0) && !(cnt.ended && cnt.ended.startsWith('strikeout'))) mismatch(`strikeout recorded on a ${cnt.balls}-${cnt.strikes} count`);
          if (IN_PLAY_RESULTS.has(res0) && cnt.ended !== 'in_play') mismatch(`${res0.replace(/_/g, ' ')} recorded without an in-play pitch`);
          if (res0 === 'hit_by_pitch' && cnt.ended !== 'hit_by_pitch') mismatch('hit by pitch recorded without a hit-by-pitch pitch');
        }
        // runner events first (existing runners), then the batter
        let rbi = 0;
        for (const r of runners) {
          const rp = r.payload || {};
          const runner = state.bases[rp.from];
          if (!runner) { issue('runner_not_on_base', 'warning', r, `No runner on ${rp.from}B for this play`); continue; }
          state.bases[rp.from] = null;
          if (rp.out || rp.how === 'out' || rp.how === 'caught_stealing' || rp.how === 'pickoff') { recordOut(r); continue; }
          if (rp.to === 4) { scoreRun(runner, batter, rp.how, r); if (rp.how === 'scored_on_play' || rp.how === 'advance') rbi += 1; }
          else state.bases[rp.to] = { ...runner, unearned: runner.unearned || rp.how === 'error' };
          if (!isDisputed(r)) {
            if (rp.how === 'stolen_base') tally(runner.ref).bs_sb += 1;
            if (rp.how === 'caught_stealing') tally(runner.ref).bs_cs += 1;
            if (rp.how === 'pickoff') tally(runner.ref).bs_pk += 1;
            if (rp.out || rp.how === 'out' || rp.how === 'caught_stealing' || rp.how === 'pickoff') creditFielders(rp.fielders);
            if (rp.how === 'error') { const f = errorBy(fieldingSide(), rp); if (f) tally(f).bs_e += 1; state.team[fieldingSide()].e += 1; noteMisplay('an error', r); }
            if (['wild_pitch', 'passed_ball', 'balk'].includes(rp.how)) chargeMisplay(rp.how, r);
          }
        }
        // the batter
        const res = p.result;
        bt.bs_pa += 1; pt.bs_bf += 1;
        if (!NO_AB.has(res)) bt.bs_ab += 1;
        if (HIT.has(res)) {
          bt.bs_h += 1; pt.bs_ha += 1; if (!dis) state.team[side].h += 1;
          if (res === 'single') bt.bs_1b += 1; if (res === 'double') bt.bs_2b += 1; if (res === 'triple') bt.bs_3b += 1; if (res === 'home_run') { bt.bs_hr += 1; pt.bs_hra += 1; }
        }
        if (res === 'walk' || res === 'intentional_walk') { bt.bs_bb += 1; pt.bs_bba += 1; }
        if (res === 'intentional_walk') { bt.bs_ibb += 1; pt.bs_ibba += 1; }
        if (res === 'hit_by_pitch') { bt.bs_hbp += 1; pt.bs_hbpa += 1; }
        if (STRIKEOUTS.has(res)) { bt.bs_k += 1; pt.bs_kp += 1; }
        if (res === 'sacrifice_bunt') bt.bs_sh += 1;
        if (res === 'sacrifice_fly') bt.bs_sf += 1;
        if (res === 'fielders_choice') bt.bs_fc += 1;
        if (res === 'reach_on_error') {
          bt.bs_roe += 1;
          if (!dis) { const f = errorBy(fieldingSide(), p); if (f) tally(f).bs_e += 1; state.team[fieldingSide()].e += 1; noteMisplay('an error', e); }
        }
        // fielding credit: the scorer's chain ("6-3") when given; a strikeout is the catcher's putout
        if (!dis) {
          if (OUT_RESULTS.has(res) && p.fielders?.length) creditFielders(p.fielders, { outs: res === 'triple_play' ? 3 : res === 'double_play' ? 2 : 1, dp: res === 'double_play' || res === 'triple_play' });
          else if (res === 'strikeout' || res === 'strikeout_looking') { const c = fielderAt(fieldingSide(), 2); if (c) tally(c).bs_po += 1; }
        }
        if (res === 'home_run') {
          for (const b of [3, 2, 1]) { const r = state.bases[b]; if (r) { scoreRun(r, batter, 'scored_on_play', e); rbi += 1; state.bases[b] = null; } }
          scoreRun({ ref: batter, responsible: pitcher, unearned: false }, batter, 'scored_on_play', e); rbi += 1;
        } else if (ON_BASE[res]) {
          const base = ON_BASE[res];
          if (state.bases[base]) {
            // The batter's base is taken, so the runner there had to move. On a
            // walk, hit batter or catcher's interference that is the rule (and a
            // forced run is an RBI); on anything else it is the likeliest
            // outcome, applied with a warning so the scorer confirms or corrects.
            const byRule = ['walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference'].includes(res);
            if (!byRule) issue('base_occupied', 'warning', e, `${base}B was still occupied when the batter reached — the runner was moved up one base; correct the runner's advance if it went differently`);
            const push = b => {
              const r = state.bases[b];
              if (!r) return;
              state.bases[b] = null;
              if (b === 3) { scoreRun(r, batter, 'advance', e); if (byRule) rbi += 1; }
              else { push(b + 1); state.bases[b + 1] = r; }
            };
            push(base);
          }
          state.bases[base] = { ref: batter, responsible: pitcher, unearned: res === 'reach_on_error', reached: res };
        }
        if (OUT_RESULTS.has(res)) { recordOut(e); bt.bs_lob += runnersOn(); }
        if (res === 'double_play') { if (!runners.some(r => r.payload?.out)) issue('double_play_missing_runner_out', 'warning', e, 'Double play recorded without a runner out — add the runner event'); }
        if (res === 'triple_play') { if (runners.filter(r => r.payload?.out).length < 2) issue('triple_play_missing_runner_outs', 'warning', e, 'Triple play needs two runner outs'); }
        bt.bs_rbi += p.rbi != null ? p.rbi : rbi;
        // lineup advance
        const lu = state.lineups[side];
        if (lu && lu.slots.length) {
          const cur = lu.slots.find(s => refKey(s.current) === refKey(batter));
          const slotNo = cur ? cur.slot : state.next_slot[side];
          state.next_slot[side] = (slotNo % lu.slots.length) + 1;
        }
        state.open_pa = null;
        entry.pitches = pitches.map(k => ({ id: k.id, result: k.payload?.result, pitch_type: k.payload?.pitch_type || null, radar_reading_id: k.payload?.radar_reading_id || null, velocity: k.velocity ?? null, timecode_s: k.timecode_s ?? null }));
        const velos = entry.pitches.map(x => x.velocity).filter(v => v != null);
        entry.attempt_id = p.attempt_id || null;
        entry.text = `${batter.label || `#${batter.player_id}`}: ${res.replace(/_/g, ' ')}${(p.rbi ?? rbi) ? `, ${p.rbi ?? rbi} RBI` : ''}${pitchCount ? ` (${pitchCount} pitch${pitchCount === 1 ? '' : 'es'}${velos.length ? `, ${Math.max(...velos)} mph` : ''})` : ''}`;
        endHalfIfDone(e);
        break;
      }
      case 'pitch': case 'runner':
        // children are folded into their plate appearance above; a runner event
        // parented to a half inning (between batters) is applied here.
        if (e.event_type === 'runner' && e.parent_event_id && byId.get(e.parent_event_id)?.event_type === 'half_inning') {
          const rp = p;
          const runner = state.bases[rp.from];
          if (!runner) { issue('runner_not_on_base', 'warning', e, `No runner on ${rp.from}B`); break; }
          state.bases[rp.from] = null;
          const out = rp.out || ['out', 'caught_stealing', 'pickoff'].includes(rp.how);
          if (!dis) {
            if (rp.how === 'stolen_base') tally(runner.ref).bs_sb += 1;
            if (rp.how === 'caught_stealing') tally(runner.ref).bs_cs += 1;
            if (rp.how === 'pickoff') tally(runner.ref).bs_pk += 1;
            if (out) creditFielders(rp.fielders);
            if (rp.how === 'error') { const f = errorBy(fieldingSide(), rp); if (f) tally(f).bs_e += 1; state.team[fieldingSide()].e += 1; noteMisplay('an error', e); }
            if (['wild_pitch', 'passed_ball', 'balk'].includes(rp.how)) chargeMisplay(rp.how, e);
          }
          if (out) { recordOut(e); endHalfIfDone(e); }
          else if (rp.to === 4) scoreRun(runner, null, rp.how, e);
          else state.bases[rp.to] = { ...runner, unearned: runner.unearned || rp.how === 'error' };
          entry.attempt_id = rp.attempt_id || null;
          entry.text = `${runner.ref.label || runner.ref.player_id}: ${rp.how.replace(/_/g, ' ')} ${rp.from}B → ${rp.to === 4 ? 'home' : `${rp.to}B`}${rp.out ? ' (out)' : ''}${rp.attempt_id ? ' · timing queued' : ''}`;
        } else {
          entry.text = e.event_type === 'pitch' ? `pitch: ${p.result.replace(/_/g, ' ')}` : `runner: ${p.how}`;
          entry.child = true;
        }
        break;
      case 'state_adjustment': {
        if (!state.half) { issue('no_half_inning', 'blocking', e, 'State adjustment before any half inning'); break; }
        const changes = [];
        if (p.outs !== undefined && p.outs !== state.outs) { changes.push(`outs ${state.outs}→${p.outs}`); state.outs = p.outs; }
        if (p.score) for (const side of ['us', 'them']) if (p.score[side] !== undefined && p.score[side] !== state.score[side]) {
          const delta = p.score[side] - state.score[side];
          changes.push(`${side} runs ${state.score[side]}→${p.score[side]}`);
          state.score[side] = p.score[side]; state.team[side].r += delta;
          const ls = state.line_score[side]; while (ls.length < state.inning) ls.push(0); ls[state.inning - 1] = Math.max(0, ls[state.inning - 1] + delta);
        }
        if (p.bases) for (const b of [1, 2, 3]) if (p.bases[b] !== undefined) {
          const was = state.bases[b];
          if (p.bases[b] === null) { if (was) { changes.push(`${b}B cleared`); state.bases[b] = null; } }
          else {
            const ref = mkRef(state.batting, p.bases[b].player_id, p.bases[b].label);
            if (!was || refKey(was.ref) !== refKey(ref)) { changes.push(`${b}B → ${ref.label || `#${ref.player_id}`}`); state.bases[b] = { ref, responsible: state.pitcher[fieldingSide()], unearned: false, reached: 'adjustment' }; names.set(refKey(ref), ref); }
          }
        }
        if (p.next_slot) for (const side of ['us', 'them']) if (p.next_slot[side] !== undefined && p.next_slot[side] !== state.next_slot[side]) { changes.push(`${side} next batter slot ${state.next_slot[side]}→${p.next_slot[side]}`); state.next_slot[side] = p.next_slot[side]; }
        entry.text = `State adjusted${changes.length ? `: ${changes.join(', ')}` : ' (no change)'} — ${p.note}`;
        issue('state_adjusted', 'info', e, `Scorer adjusted the derived state (${changes.join(', ') || 'no change'}): ${p.note}`);
        endHalfIfDone(e);
        break;
      }
      case 'game_final':
        state.final = { reason: p.reason, note: p.note || '', event_id: e.id };
        if (!state.half_complete && state.outs > 0 && state.outs < 3 && p.reason === 'regulation') issue('final_mid_inning', 'warning', e, 'Game marked final mid-inning');
        entry.text = `Final — ${p.reason.replace(/_/g, ' ')}${p.note ? `: ${p.note}` : ''}`;
        break;
      default:
        entry.text = e.event_type;
    }
    log.push(entry);
  }
  // unresolved disputes are always surfaced
  for (const id of disputed) {
    const e = byId.get(id);
    if (e) issue('unresolved_scoring_judgment', 'warning', e, `${e.event_type.replace(/_/g, ' ')} at sequence ${e.sequence} is under review — excluded from totals`);
  }
  // Before the first pitch, and after a third out that has not yet opened the
  // next half, the scorer needs to see who is up next: that is the upcoming
  // half, derived here so the UI never guesses at home/away.
  const upcoming = (() => {
    if (state.final || state.us_is_home == null) return null;
    const awaySide = state.us_is_home ? 'them' : 'us';
    const homeSide = awaySide === 'us' ? 'them' : 'us';
    if (!state.half) return { inning: 1, half: 'top', batting: awaySide };
    if (!state.half_complete) return null;
    return state.half === 'top' ? { inning: state.inning, half: 'bottom', batting: homeSide } : { inning: state.inning + 1, half: 'top', batting: awaySide };
  })();
  // serialise state
  const homeSide = state.us_is_home ? 'us' : 'them';
  const awaySide = homeSide === 'us' ? 'them' : 'us';
  const out = {
    ...state,
    upcoming,
    pitching_started: undefined,
    result: state.final ? { us: state.score.us, them: state.score.them, winner: state.score.us === state.score.them ? 'tie' : (state.score.us > state.score.them ? 'us' : 'them') } : null,
    line_score: {
      innings: Math.max(state.line_score.us.length, state.line_score.them.length, state.inning || 0),
      away: { side: awaySide, runs: state.line_score[awaySide], ...state.team[awaySide] },
      home: { side: homeSide, runs: state.line_score[homeSide], ...state.team[homeSide] },
    },
    used: undefined, starters: undefined, reentered: undefined,
    lineups: {
      us: state.lineups.us ? { dh: state.lineups.us.dh, slots: state.lineups.us.slots.map(s => ({ slot: s.slot, position: s.position, current: s.current, starter: s.starter })) } : null,
      them: state.lineups.them ? { dh: state.lineups.them.dh, slots: state.lineups.them.slots.map(s => ({ slot: s.slot, position: s.position, current: s.current, starter: s.starter })) } : null,
    },
    expected_batter: upcoming ? currentBatterRef(upcoming.batting) : (state.batting ? currentBatterRef(state.batting) : null),
  };
  const tallyList = [...tallies.entries()].map(([k, t]) => {
    const ref = names.get(k) || {};
    const { outs_pitched, ...rest } = t;
    rest.bs_tb = rest.bs_1b + 2 * rest.bs_2b + 3 * rest.bs_3b + 4 * rest.bs_hr;
    const stats = { ...rest, bs_ip: ipFromOuts(outs_pitched) };
    return { key: k, player_id: ref.player_id ?? null, label: ref.label || '', side: ref.side || null, stats, outs_pitched, rates: ratesFor(stats, outs_pitched), er_uncertain: erUncertain.has(k) };
  });
  return { version: SCOREBOOK_VERSION, state: out, tallies: tallyList, issues, log };
}

// ── Persistence helpers ────────────────────────────────────────────────────
export function loadEvents(db, jobId) {
  return db.prepare(
    "SELECT * FROM cmd_events WHERE job_id = ? AND event_type IN ('lineup','half_inning','plate_appearance','pitch','runner','substitution','game_final','state_adjustment') AND status IN ('active','needs_review') ORDER BY sequence, id"
  ).all(jobId).map(e => ({ ...e, payload: safeJson(e.payload) }));
}
const safeJson = s => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}); } catch { return {}; } };

export function rulesetFor(db, job) {
  const row = job.ruleset_id ? db.prepare('SELECT config FROM rulesets WHERE id = ?').get(job.ruleset_id)
    : db.prepare("SELECT config FROM rulesets WHERE key = 'baseball_default'").get();
  return safeJson(row?.config);
}

export function replayJob(db, jobId) {
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw err('Job not found', 404);
  const events = loadEvents(db, jobId);
  const readingIds = events.filter(e => e.event_type === 'pitch' && e.payload?.radar_reading_id).map(e => e.payload.radar_reading_id);
  if (readingIds.length) {
    const rows = new Map(db.prepare(`SELECT id, velocity, status FROM cmd_radar_readings WHERE id IN (${readingIds.map(() => '?').join(',')})`).all(...readingIds).map(r => [r.id, r]));
    for (const e of events) if (e.event_type === 'pitch' && e.payload?.radar_reading_id) { const r = rows.get(e.payload.radar_reading_id); if (r && r.status !== 'invalid') e.velocity = r.velocity; }
  }
  const disputed = new Set(events.filter(e => e.status === 'needs_review').map(e => e.id));
  const result = replay(events, { ruleset: rulesetFor(db, job), disputed });
  // Decorate tallies with names for our players.
  const ids = result.tallies.filter(t => t.player_id).map(t => t.player_id);
  const names = ids.length ? new Map(db.prepare(`SELECT id, first_name, last_name FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(p => [p.id, `${p.first_name} ${p.last_name}`])) : new Map();
  for (const t of result.tallies) if (t.player_id) t.name = names.get(t.player_id) || t.label;
  for (const side of ['us', 'them']) {
    const lu = result.state.lineups[side];
    if (lu) for (const s of lu.slots) for (const k of ['current', 'starter']) if (s[k]?.player_id) s[k].name = names.get(s[k].player_id) || s[k].label;
  }
  if (result.state.expected_batter?.player_id) result.state.expected_batter.name = names.get(result.state.expected_batter.player_id) || '';
  return { job, events, ...result };
}

const audit = (db, targetTable, targetId, actorId, action, note, prev = '', next = '') => db.prepare(
  'INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(targetTable, targetId, actorId ?? null, action, String(note || '').slice(0, 600), String(prev).slice(0, 600), String(next).slice(0, 600));

// The live scorebook is a game-record source like any other: one per job,
// created on the first event, refreshed after every change.
export function ensureLiveSource(db, jobId, actorId) {
  let src = db.prepare("SELECT * FROM cmd_game_record_sources WHERE job_id = ? AND source_kind = 'live_internal' ORDER BY id LIMIT 1").get(jobId);
  if (!src) {
    const id = db.prepare("INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, note, created_by) VALUES (?, 'live_internal', 'Command scorebook', '', 'Derived from scorebook events (replayed, never stored)', ?)").run(jobId, actorId ?? null).lastInsertRowid;
    src = db.prepare('SELECT * FROM cmd_game_record_sources WHERE id = ?').get(id);
    audit(db, 'cmd_jobs', jobId, actorId, 'game_record_source_attached', 'live_internal — Command scorebook');
  }
  return src;
}

// Rows in the same shape a GameChanger import produces, so the one release
// adapter publishes both. Only our players (rows) publish; opponents stay
// labels. Disputed contributions are already excluded by the replay.
export function liveRecordReport(db, jobId) {
  const rp = replayJob(db, jobId);
  const roster = commandRoster(db, rp.job);
  const rosterById = new Map(roster.map(p => [p.id, p]));
  const rows = rp.tallies.filter(t => t.player_id).map(t => {
    // Publish what the log supports: non-zero box-score fields (PA always), and
    // never an earned-run figure the scorer has not ruled on yet.
    const stats = Object.fromEntries(Object.entries(t.stats).filter(([k, v]) => (k.startsWith('bs_') && v !== 0 || k === 'bs_pa') && k !== 'bs_ip' && !(k === 'bs_er' && t.er_uncertain)));
    if (t.outs_pitched > 0) stats.bs_outs = t.outs_pitched;   // innings are stored as outs; the display shows thirds
    return { key: `live:${t.player_id}`, group: 'scorebook', row: null, jersey: rosterById.get(t.player_id)?.jersey || '', name: t.name || t.label, stats, player_id: t.player_id, player_name: t.name || t.label, resolved_by: 'scorebook', skipped: false };
  });
  const blocking = rp.issues.filter(i => i.level === 'blocking');
  const status = rp.state.final && blocking.length === 0 ? 'validated' : 'validating';
  const warnings = rp.issues.map(i => i.message);
  const heldEr = rp.tallies.filter(t => t.player_id && t.er_uncertain).map(t => t.name || t.label);
  if (heldEr.length) warnings.push(`Earned runs withheld until ruled: ${heldEr.join(', ')}`);
  if (!rp.state.final) warnings.unshift('Game is not final yet — mark it final to validate the record');
  return {
    status,
    report: { blocks: [{ group: 'scorebook', header_row: null, rows: rows.length, unknown_columns: [] }], warnings, rows, unresolved: [], roster: roster.map(p => ({ id: p.id, jersey: p.jersey, name: `${p.first_name} ${p.last_name}`, is_guest: p.is_guest })), scorebook: { version: rp.version, final: rp.state.final, score: rp.state.score, issues: rp.issues } },
  };
}

export function refreshLiveSource(db, jobId, actorId) {
  const src = ensureLiveSource(db, jobId, actorId);
  const { status, report } = liveRecordReport(db, jobId);
  db.prepare("UPDATE cmd_game_record_sources SET validation_status = ?, parsed_report = ?, validated_at = CASE WHEN ? = 'validated' THEN COALESCE(validated_at, datetime('now')) ELSE NULL END WHERE id = ?")
    .run(status, JSON.stringify(report), status, src.id);
  return { source_id: src.id, status, report };
}

function nextSequence(db, jobId) {
  return (db.prepare('SELECT MAX(sequence) m FROM cmd_events WHERE job_id = ?').get(jobId).m || 0) + 1;
}

function describeForAudit(type, p) {
  switch (type) {
    case 'plate_appearance': return `${p.batter_label || p.batter_player_id || 'batter'}: ${p.result}`;
    case 'runner': return `runner ${p.from}B→${p.to === 4 ? 'home' : `${p.to}B`} ${p.how}${p.out ? ' out' : ''}`;
    case 'pitch': return `pitch ${p.result}`;
    case 'half_inning': return `${p.half} ${p.inning}`;
    case 'substitution': return `${p.kind} ${p.player_in_label || p.player_in_id}`;
    case 'lineup': return `${p.side} lineup (${(p.slots || []).length})`;
    case 'game_final': return `final: ${p.reason}`;
    default: return type;
  }
}

// Append one event, auto-open the first half inning and auto-advance halves
// on the third out, keep the live source fresh. Returns the new event plus
// the replayed state.
// Video tagging (PRD §5: the event record captures the timecode and selected
// feed automatically; approved events get a default surrounding clip the
// analyst can adjust). The feed must belong to the job; the clip defaults to
// a few seconds before the moment and a few after.
const DEFAULT_CLIP = { before_s: 4, after_s: 8 };
function tagFor(db, jobId, { selected_feed_id = null, timecode_s = null, clip_start_s = null, clip_end_s = null } = {}) {
  const feed = selected_feed_id == null || selected_feed_id === '' ? null : Number(selected_feed_id);
  if (feed != null && (!Number.isInteger(feed) || !db.prepare('SELECT 1 FROM cmd_video_feeds WHERE id = ? AND job_id = ?').get(feed, jobId))) throw err('selected_feed_id must be a feed attached to this job');
  const t = timecode_s == null || timecode_s === '' ? null : Number(timecode_s);
  if (t != null && !(Number.isFinite(t) && t >= 0)) throw err('timecode_s must be a non-negative number of seconds');
  let c0 = clip_start_s == null || clip_start_s === '' ? null : Number(clip_start_s);
  let c1 = clip_end_s == null || clip_end_s === '' ? null : Number(clip_end_s);
  if ((c0 != null || c1 != null) && !(Number.isFinite(c0) && Number.isFinite(c1) && c0 >= 0 && c1 > c0)) throw err('clip_start_s and clip_end_s must be seconds with the end after the start');
  if (t != null && c0 == null) { c0 = Math.max(0, t - DEFAULT_CLIP.before_s); c1 = t + DEFAULT_CLIP.after_s; }
  return { feed, t, c0, c1 };
}
// A pitch may carry the radar reading that measured it. The reading must be
// this job's; if the pitcher of record is one of ours the reading is matched to
// them (with the pitch type) through the radar lifecycle, so velocity keeps
// one source of truth and publishes exactly once.
function linkReadingToPitch(db, jobId, pitchPayload, pitcherRef, actorId) {
  const id = pitchPayload.radar_reading_id;
  if (!id) return;
  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ? AND job_id = ?').get(id, jobId);
  if (!reading) throw err('radar_reading_id must be a reading on this job');
  if (reading.status === 'invalid') throw err(`Reading ${id} is marked invalid — restore it in the radar queue before linking it to a pitch`);
  const pitcherId = pitcherRef?.player_id || null;
  if (reading.status === 'matched' && reading.player_id && pitcherId && reading.player_id !== pitcherId) throw err(`Reading ${id} is matched to another player — reassign it in the radar queue first`);
  if (pitcherId && (reading.status !== 'matched' || reading.player_id !== pitcherId || (pitchPayload.pitch_type && reading.pitch_type !== pitchPayload.pitch_type))) {
    classifyReading(db, id, { player_id: pitcherId, pitch_or_exit: 'pitch', pitch_type: pitchPayload.pitch_type || reading.pitch_type || 'unknown', status: 'matched', note: reading.note || 'linked from the scorebook' }, actorId);
  }
}
// A timing attempt queued from the scorebook (home-to-first or steal) at the
// play's moment on the selected feed — the running queue picks it up.
function queueAttempt(db, jobId, { attempt_type, player_id, tag }, actorId) {
  if (!player_id) throw err(`Only our players can be timed — ${attempt_type.replace(/_/g, ' ')} needs a rostered runner`);
  if (!tag.feed || tag.t == null) throw err(`Queueing a ${attempt_type.replace(/_/g, ' ')} attempt needs the footage selected and the moment on it`);
  const created = createAttempt(db, jobId, { attempt_type, player_id, feed_id: tag.feed, timecode_s: tag.t }, actorId);
  return typeof created === 'object' && created !== null ? (created.id ?? created.attempt?.id) : created;   // the attempt id, whatever shape createAttempt returns
}
const INSERT_EVENT = `INSERT INTO cmd_events (job_id, sequence, event_type, parent_event_id, player_id, payload, selected_feed_id, timecode_s, clip_start_s, clip_end_s, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function appendEvent(db, jobId, { event_type, parent_event_id = null, payload = {}, selected_feed_id = null, timecode_s = null, clip_start_s = null, clip_end_s = null }, actorId) {
  if (!EVENT_TYPES.includes(event_type)) throw err(`event_type must be one of ${EVENT_TYPES.join(', ')}`);
  validatePayload(event_type, payload);
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw err('Job not found', 404);
  const before = replayJob(db, jobId);
  if (before.state.final && event_type !== 'game_final') throw err('Game is final — void the final event to keep scoring', 409);
  if (event_type === 'state_adjustment' && (!before.state.half || before.state.half_complete)) throw err('Nothing to adjust — no half inning is in progress', 409);
  const tag = tagFor(db, jobId, { selected_feed_id, timecode_s, clip_start_s, clip_end_s });

  const run = db.transaction(() => {
    const ins = db.prepare(INSERT_EVENT);
    let parent = parent_event_id;
    // A plate appearance or between-batter runner event needs an open half inning.
    if (['plate_appearance', 'runner'].includes(event_type) && !parent) {
      const halves = before.events.filter(e => e.event_type === 'half_inning');
      let half = halves.at(-1) || null;
      if (!half || before.state.half_complete) {
        if (before.state.us_is_home == null) throw err('Enter our lineup (with home/away) before scoring a plate appearance');
        const nextHalf = half ? (before.state.half === 'top' ? { inning: before.state.inning, half: 'bottom' } : { inning: before.state.inning + 1, half: 'top' }) : { inning: 1, half: 'top' };
        const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, null, null, actorId).lastInsertRowid;
        audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
        half = { id: hid };
      }
      if (event_type === 'plate_appearance' || (event_type === 'runner' && !parent)) parent = half.id;
    }
    if (event_type === 'pitch' && !parent) throw err('A pitch needs its plate appearance (parent_event_id)');
    if (event_type === 'runner') {
      if (payload.attempt_id && !db.prepare("SELECT 1 FROM cmd_events WHERE id = ? AND job_id = ? AND event_type = 'running_attempt'").get(payload.attempt_id, jobId)) throw err('attempt_id must be a running attempt on this job');
      if (payload.time_steal) { const { time_steal: _requested, ...rest } = payload; payload = { ...rest, attempt_id: queueAttempt(db, jobId, { attempt_type: 'steal', player_id: payload.runner_player_id, tag }, actorId) }; }
    }
    const playerId = payload.batter_player_id || payload.runner_player_id || payload.player_in_id || null;
    const id = ins.run(jobId, nextSequence(db, jobId), event_type, parent, playerId, JSON.stringify(payload), tag.feed, tag.t, tag.c0, tag.c1, actorId).lastInsertRowid;
    audit(db, 'cmd_events', id, actorId, 'created', describeForAudit(event_type, payload));
    // Third out → next half, automatically, so the scorer never has to.
    const after = replayJob(db, jobId);
    if (after.state.half_complete && !after.state.final && !after.state.game_over_suggested) {
      const nextHalf = after.state.half === 'top' ? { inning: after.state.inning, half: 'bottom' } : { inning: after.state.inning + 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, null, null, actorId).lastInsertRowid;
      audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
    }
    refreshLiveSource(db, jobId, actorId);
    return id;
  });
  const id = run();
  const event = db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(id);
  return { event: { ...event, payload: safeJson(event.payload) }, ...replayJob(db, jobId) };
}

// One plate appearance with its pitches and runner plays, in one transaction:
// the PA row first, then children parented to it (lead runner first so a
// batter never lands on an occupied base), then the half auto-advances if the
// play made the third out. This is what the scorer's "save" button calls.
export function appendPlateAppearance(db, jobId, { pa, pitches = [], runners = [], selected_feed_id = null, timecode_s = null, clip_start_s = null, clip_end_s = null }, actorId) {
  validatePayload('plate_appearance', pa || {});
  for (const r of runners) validatePayload('runner', r);
  for (const x of pitches) {
    validatePayload('pitch', x);
    if (x.timecode_s != null && !(Number.isFinite(Number(x.timecode_s)) && Number(x.timecode_s) >= 0)) throw err('pitch timecode_s must be a non-negative number of seconds');
  }
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw err('Job not found', 404);
  const before = replayJob(db, jobId);
  if (before.state.final) throw err('Game is final — void the final event to keep scoring', 409);
  if (before.state.us_is_home == null) throw err('Enter our lineup (with home/away) before scoring a plate appearance');
  // The play's moment defaults to its last pitch; the runner plays share it.
  const lastPitchT = [...pitches].reverse().find(x => x.timecode_s != null)?.timecode_s ?? null;
  const tag = tagFor(db, jobId, { selected_feed_id, timecode_s: timecode_s ?? lastPitchT, clip_start_s, clip_end_s });

  const run = db.transaction(() => {
    const ins = db.prepare(INSERT_EVENT);
    let half = before.events.filter(e => e.event_type === 'half_inning').at(-1) || null;
    if (!half || before.state.half_complete) {
      const nextHalf = half ? (before.state.half === 'top' ? { inning: before.state.inning, half: 'bottom' } : { inning: before.state.inning + 1, half: 'top' }) : { inning: 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, null, null, actorId).lastInsertRowid;
      audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
      half = { id: hid };
    }
    const { time_home_to_first, ...paFields } = pa;
    const paPayload = { ...paFields, pitch_count: pitches.length || pa.pitch_count || 0 };
    // Who is pitching and batting right now decides the radar match and the timing candidate.
    const batting = before.state.upcoming?.batting || before.state.batting;
    const fielding = batting === 'us' ? 'them' : 'us';
    const pitcherRef = pa.pitcher_player_id || pa.pitcher_label ? { player_id: pa.pitcher_player_id || null, label: pa.pitcher_label || '' } : before.state.pitcher[fielding];
    const batterRef = pa.batter_player_id ? { player_id: pa.batter_player_id } : before.state.expected_batter;
    if (time_home_to_first) paPayload.attempt_id = queueAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: batterRef?.player_id, tag }, actorId);
    const paId = ins.run(jobId, nextSequence(db, jobId), 'plate_appearance', half.id, pa.batter_player_id || null, JSON.stringify(paPayload), tag.feed, tag.t, tag.c0, tag.c1, actorId).lastInsertRowid;
    audit(db, 'cmd_events', paId, actorId, 'created', describeForAudit('plate_appearance', paPayload));
    for (const x of pitches) {
      const { timecode_s: pt, ...payload } = x;
      if (payload.pitch_type === '') delete payload.pitch_type;
      linkReadingToPitch(db, jobId, payload, pitcherRef, actorId);
      ins.run(jobId, nextSequence(db, jobId), 'pitch', paId, null, JSON.stringify(payload), tag.feed, pt == null ? null : Number(pt), null, null, actorId);
    }
    for (const r of [...runners].sort((a, b) => b.from - a.from)) {
      const rid = ins.run(jobId, nextSequence(db, jobId), 'runner', paId, r.runner_player_id || null, JSON.stringify(r), tag.feed, tag.t, tag.c0, tag.c1, actorId).lastInsertRowid;
      audit(db, 'cmd_events', rid, actorId, 'created', describeForAudit('runner', r));
    }
    const after = replayJob(db, jobId);
    if (after.state.half_complete && !after.state.final && !after.state.game_over_suggested) {
      const nextHalf = after.state.half === 'top' ? { inning: after.state.inning, half: 'bottom' } : { inning: after.state.inning + 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, null, null, actorId).lastInsertRowid;
      audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
    }
    refreshLiveSource(db, jobId, actorId);
    return paId;
  });
  const paId = run();
  return { event_id: paId, ...replayJob(db, jobId) };
}

// Correction: supersede with a new row at the same sequence and parent;
// children follow the replacement; the audit row keeps both payloads.
export function correctEvent(db, eventId, { payload }, actorId, note = '') {
  const old = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND status IN ('active','needs_review')").get(eventId);
  if (!old) throw err('Event not found or already superseded', 404);
  validatePayload(old.event_type, payload);
  const run = db.transaction(() => {
    const id = db.prepare(INSERT_EVENT).run(old.job_id, old.sequence, old.event_type, old.parent_event_id, payload.batter_player_id || payload.runner_player_id || payload.player_in_id || old.player_id, JSON.stringify(payload), old.selected_feed_id, old.timecode_s, old.clip_start_s, old.clip_end_s, actorId).lastInsertRowid;
    db.prepare("UPDATE cmd_events SET status = 'superseded', superseded_by = ? WHERE id = ?").run(id, old.id);
    db.prepare('UPDATE cmd_events SET parent_event_id = ? WHERE parent_event_id = ?').run(id, old.id);
    audit(db, 'cmd_events', id, actorId, 'corrected', note || `${describeForAudit(old.event_type, safeJson(old.payload))} → ${describeForAudit(old.event_type, payload)}`, String(old.payload).slice(0, 600), JSON.stringify(payload).slice(0, 600));
    afterCorrection(db, old.job_id, actorId, `event ${old.sequence} corrected`);
    return id;
  });
  const id = run();
  return { event_id: id, superseded_id: old.id, ...replayJob(db, old.job_id) };
}

// Re-point an event at the footage: feed, moment, clip bounds. Stats do not
// change, so no re-release; the change is audited.
export function setEventClip(db, eventId, { selected_feed_id, timecode_s, clip_start_s, clip_end_s } = {}, actorId) {
  const ev = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND status IN ('active','needs_review')").get(eventId);
  if (!ev) throw err('Event not found or already superseded', 404);
  const tag = tagFor(db, ev.job_id, {
    selected_feed_id: selected_feed_id === undefined ? ev.selected_feed_id : selected_feed_id,
    timecode_s: timecode_s === undefined ? ev.timecode_s : timecode_s,
    clip_start_s, clip_end_s,
  });
  db.prepare('UPDATE cmd_events SET selected_feed_id = ?, timecode_s = ?, clip_start_s = ?, clip_end_s = ? WHERE id = ?').run(tag.feed, tag.t, tag.c0, tag.c1, eventId);
  audit(db, 'cmd_events', eventId, actorId, 'clip_adjusted',
    `${describeForAudit(ev.event_type, safeJson(ev.payload))} — feed ${tag.feed ?? '—'} at ${tag.t ?? '—'}s, clip ${tag.c0 ?? '—'}–${tag.c1 ?? '—'}s`,
    JSON.stringify({ feed: ev.selected_feed_id, t: ev.timecode_s, clip: [ev.clip_start_s, ev.clip_end_s] }), JSON.stringify({ feed: tag.feed, t: tag.t, clip: [tag.c0, tag.c1] }));
  return { event: db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(eventId), ...replayJob(db, ev.job_id) };
}

// Void: supersede with no replacement (children too). History stays.
export function voidEvent(db, eventId, actorId, note = '') {
  const old = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND status IN ('active','needs_review')").get(eventId);
  if (!old) throw err('Event not found or already superseded', 404);
  const run = db.transaction(() => {
    const kids = db.prepare("SELECT id FROM cmd_events WHERE parent_event_id = ? AND status IN ('active','needs_review')").all(old.id);
    for (const k of kids) db.prepare("UPDATE cmd_events SET status = 'superseded' WHERE id = ?").run(k.id);
    db.prepare("UPDATE cmd_events SET status = 'superseded' WHERE id = ?").run(old.id);
    audit(db, 'cmd_events', old.id, actorId, 'voided', note || describeForAudit(old.event_type, safeJson(old.payload)), old.status, 'superseded');
    afterCorrection(db, old.job_id, actorId, `event ${old.sequence} voided`);
  });
  run();
  return replayJob(db, old.job_id);
}

export function disputeEvent(db, eventId, { note = '' } = {}, actorId) {
  const e = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND status = 'active'").get(eventId);
  if (!e) throw err('Event not found or not active', 404);
  const run = db.transaction(() => {
    db.prepare("UPDATE cmd_events SET status = 'needs_review' WHERE id = ?").run(eventId);
    audit(db, 'cmd_events', eventId, actorId, 'disputed', note, 'active', 'needs_review');
    afterCorrection(db, e.job_id, actorId, `event ${e.sequence} disputed`);
  });
  run();
  return replayJob(db, e.job_id);
}

export function resolveEvent(db, eventId, { note = '' } = {}, actorId) {
  const e = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND status = 'needs_review'").get(eventId);
  if (!e) throw err('Event is not under review', 404);
  const run = db.transaction(() => {
    db.prepare("UPDATE cmd_events SET status = 'active' WHERE id = ?").run(eventId);
    audit(db, 'cmd_events', eventId, actorId, 'resolved', note, 'needs_review', 'active');
    afterCorrection(db, e.job_id, actorId, `event ${e.sequence} resolved`);
  });
  run();
  return replayJob(db, e.job_id);
}

// After any change: refresh the live source; if the record was already
// released and is still valid, re-release so the profile never shows a
// superseded value. Otherwise leave the release to the reviewer.
let releaseHook = null;
export function setGameRecordReleaseHook(fn) { releaseHook = fn; }
function afterCorrection(db, jobId, actorId, why) {
  const { status } = refreshLiveSource(db, jobId, actorId);
  const job = db.prepare('SELECT game_record_status FROM cmd_jobs WHERE id = ?').get(jobId);
  if (job?.game_record_status === 'released') {
    if (status === 'validated' && releaseHook) {
      releaseHook(db, jobId, actorId, why);
    } else {
      audit(db, 'cmd_jobs', jobId, actorId, 'game_record_needs_rerelease', `${why} — published box score is stale until the record is re-validated and re-released`, 'released', 'released');
    }
  }
}
