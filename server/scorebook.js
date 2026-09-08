// Core scorekeeping (Phase 2, TDR §7). Events live on cmd_events; everything
// else — game state, lineups, box-score tallies — is REPLAYED from the active
// events, deterministically and versioned. A correction upstream therefore
// recalculates everything downstream by construction: no stale tallies, no
// duplicate tags, no second source of truth.
//
// Event types (payload shapes validated in validatePayload):
//   lineup            { side: 'us'|'them', us_is_home?, dh?, slots: [{ slot, player_id?, label?, position? }] }
//   half_inning       { inning, half: 'top'|'bottom', auto? }
//   plate_appearance  { batter_player_id?, batter_label?, pitcher_player_id?, pitcher_label?, result, rbi?, batted_ball?, direction?, error_player_id?, error_label?, out_of_order_ok?, pitch_count?, note? }
//   pitch             { result: ball|called_strike|swinging_strike|foul|in_play|hit_by_pitch|intentional_ball, pitch_type?, radar_reading_id? }
//   runner            { runner_player_id?, runner_label?, from: 1|2|3, to: 1|2|3|4, how, out?, unearned?, error_player_id?, error_label?, note? }
//   substitution      { kind, side, slot?, base?, player_in_id?, player_in_label?, player_out_id?, player_out_label?, position? }
//   game_final        { reason: regulation|run_rule|time_limit|forfeit|darkness|other, note? }
import { commandRoster } from './commandRoster.js';

export const SCOREBOOK_VERSION = 'CMD_SCOREBOOK_V1';
export const EVENT_TYPES = ['lineup', 'half_inning', 'plate_appearance', 'pitch', 'runner', 'substitution', 'game_final'];
export const PA_RESULTS = [
  'single', 'double', 'triple', 'home_run',
  'walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference',
  'strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout',
  'sacrifice_fly', 'sacrifice_bunt', 'fielders_choice', 'reach_on_error', 'double_play', 'triple_play',
];
export const PITCH_RESULTS = ['ball', 'called_strike', 'swinging_strike', 'foul', 'in_play', 'hit_by_pitch', 'intentional_ball'];
export const RUNNER_HOWS = ['advance', 'stolen_base', 'caught_stealing', 'pickoff', 'wild_pitch', 'passed_ball', 'balk', 'error', 'out', 'scored_on_play', 'defensive_indifference'];
export const SUB_KINDS = ['pinch_hitter', 'pinch_runner', 'courtesy_runner', 'defensive', 'pitching_change', 're_entry'];
export const FINAL_REASONS = ['regulation', 'run_rule', 'time_limit', 'forfeit', 'darkness', 'other'];
export const BATTED_BALLS = ['ground_ball', 'line_drive', 'fly_ball', 'popup', 'bunt'];
export const DIRECTIONS = ['pull', 'middle', 'opposite'];

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const HIT = new Set(['single', 'double', 'triple', 'home_run']);
const NO_AB = new Set(['walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference', 'sacrifice_fly', 'sacrifice_bunt']);
const OUT_RESULTS = new Set(['strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout', 'sacrifice_fly', 'sacrifice_bunt', 'double_play', 'triple_play']);
const ON_BASE = { single: 1, double: 2, triple: 3, home_run: 4, walk: 1, intentional_walk: 1, hit_by_pitch: 1, catcher_interference: 1, fielders_choice: 1, reach_on_error: 1 };

// ── Player references ──────────────────────────────────────────────────────
// Our players are rows; opponents are labels. Either way a ref has a stable key.
export const refKey = r => (r?.player_id ? `p:${r.player_id}` : `l:${r?.side || '?'}:${r?.label || '?'}`);
const mkRef = (side, player_id, label) => ({ side, player_id: player_id ?? null, label: label || (player_id ? '' : 'unknown') });

// ── Payload validation ─────────────────────────────────────────────────────
export function validatePayload(type, p = {}) {
  const need = (cond, msg) => { if (!cond) throw err(msg); };
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
      return;
    case 'pitch':
      need(PITCH_RESULTS.includes(p.result), `pitch result must be one of ${PITCH_RESULTS.join(', ')}`);
      return;
    case 'runner':
      need([1, 2, 3].includes(p.from), 'runner.from must be 1, 2 or 3');
      need([1, 2, 3, 4].includes(p.to), 'runner.to must be 1–4 (4 = home)');
      need(RUNNER_HOWS.includes(p.how), `how must be one of ${RUNNER_HOWS.join(', ')}`);
      if (!p.out) need(p.to > p.from || p.how === 'out', 'a runner who is not out must advance');
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
    default:
      throw err(`Unknown scorebook event type ${type}`);
  }
}

// ── Replay ─────────────────────────────────────────────────────────────────
function emptyTally() {
  return { bs_pa: 0, bs_ab: 0, bs_r: 0, bs_h: 0, bs_2b: 0, bs_3b: 0, bs_hr: 0, bs_rbi: 0, bs_bb: 0, bs_k: 0, bs_hbp: 0, bs_sb: 0,
           bs_bf: 0, bs_ha: 0, bs_ra: 0, bs_er: 0, bs_bba: 0, bs_kp: 0, bs_hra: 0, bs_pitches: 0, outs_pitched: 0, bs_e: 0 };
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
  };
  const tallies = new Map();
  const names = new Map();
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

  const scoreRun = (runner, batterRef, how, e) => {
    state.score[state.batting] += 1;
    if (isDisputed(e)) return;
    tally(runner.ref).bs_r += 1;
    if (runner.responsible) {
      const t = tally(runner.responsible);
      t.bs_ra += 1;
      const unearned = runner.unearned || ['error', 'passed_ball'].includes(how) || e.payload?.unearned;
      if (!unearned) t.bs_er += 1;
    }
  };
  const recordOut = (e) => {
    state.outs += 1;
    const p = state.pitcher[fieldingSide()];
    if (p && !isDisputed(e)) tally(p).outs_pitched += 1;
  };
  const endHalfIfDone = () => {
    if (state.outs >= 3) {
      state.half_complete = true;
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
    const entry = { id: e.id, sequence: e.sequence, type: e.event_type, inning: state.inning, half: state.half, outs_before: state.outs, disputed: dis, text: '' };
    switch (e.event_type) {
      case 'lineup': {
        const slots = (p.slots || []).map(s => {
          const ref = mkRef(p.side, s.player_id, s.label || (s.player_id ? '' : `#${s.slot}`));
          return { slot: s.slot, position: s.position || '', starter: ref, current: ref };
        });
        state.lineups[p.side] = { slots, dh: !!p.dh };
        for (const s of slots) { state.starters[p.side].add(refKey(s.starter)); state.used[p.side].add(refKey(s.starter)); names.set(refKey(s.starter), s.starter); }
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
        state.bases = { 1: null, 2: null, 3: null }; state.half_complete = false; state.open_pa = null;
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
        if (p.kind !== 'courtesy_runner') state.used[side].add(inKey);   // a courtesy runner has not entered the game
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
        // pitches
        const pitchCount = pitches.length || p.pitch_count || 0;
        pt.bs_pitches += pitchCount;
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
          if (rp.how === 'stolen_base' && !isDisputed(r)) tally(runner.ref).bs_sb += 1;
          if (rp.how === 'error' && (rp.error_player_id || rp.error_label) && !isDisputed(r)) tally(mkRef(fieldingSide(), rp.error_player_id, rp.error_label)).bs_e += 1;
        }
        // the batter
        const res = p.result;
        bt.bs_pa += 1; pt.bs_bf += 1;
        if (!NO_AB.has(res)) bt.bs_ab += 1;
        if (HIT.has(res)) { bt.bs_h += 1; pt.bs_ha += 1; if (res === 'double') bt.bs_2b += 1; if (res === 'triple') bt.bs_3b += 1; if (res === 'home_run') { bt.bs_hr += 1; pt.bs_hra += 1; } }
        if (res === 'walk' || res === 'intentional_walk') { bt.bs_bb += 1; pt.bs_bba += 1; }
        if (res === 'hit_by_pitch') bt.bs_hbp += 1;
        if (res === 'strikeout' || res === 'strikeout_looking') { bt.bs_k += 1; pt.bs_kp += 1; }
        if (res === 'reach_on_error' && (p.error_player_id || p.error_label) && !dis) tally(mkRef(fieldingSide(), p.error_player_id, p.error_label)).bs_e += 1;
        if (res === 'home_run') {
          for (const b of [3, 2, 1]) { const r = state.bases[b]; if (r) { scoreRun(r, batter, 'scored_on_play', e); rbi += 1; state.bases[b] = null; } }
          scoreRun({ ref: batter, responsible: pitcher, unearned: false }, batter, 'scored_on_play', e); rbi += 1;
        } else if (ON_BASE[res]) {
          const base = ON_BASE[res];
          if (state.bases[base]) issue('base_occupied', 'warning', e, `${base}B was still occupied when the batter reached — record the runner's advance first`);
          state.bases[base] = { ref: batter, responsible: pitcher, unearned: res === 'reach_on_error', reached: res };
        }
        if (OUT_RESULTS.has(res)) recordOut(e);
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
        entry.text = `${batter.label || `#${batter.player_id}`}: ${res.replace(/_/g, ' ')}${(p.rbi ?? rbi) ? `, ${p.rbi ?? rbi} RBI` : ''}${pitchCount ? ` (${pitchCount} pitch${pitchCount === 1 ? '' : 'es'})` : ''}`;
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
          if (rp.out || ['out', 'caught_stealing', 'pickoff'].includes(rp.how)) { recordOut(e); endHalfIfDone(e); }
          else if (rp.to === 4) scoreRun(runner, null, rp.how, e);
          else state.bases[rp.to] = { ...runner, unearned: runner.unearned || rp.how === 'error' };
          if (rp.how === 'stolen_base' && !dis) tally(runner.ref).bs_sb += 1;
          entry.text = `${runner.ref.label || runner.ref.player_id}: ${rp.how.replace(/_/g, ' ')} ${rp.from}B → ${rp.to === 4 ? 'home' : `${rp.to}B`}${rp.out ? ' (out)' : ''}`;
        } else {
          entry.text = e.event_type === 'pitch' ? `pitch: ${p.result.replace(/_/g, ' ')}` : `runner: ${p.how}`;
          entry.child = true;
        }
        break;
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
  const out = {
    ...state,
    upcoming,
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
    return { key: k, player_id: ref.player_id ?? null, label: ref.label || '', side: ref.side || null, stats: { ...rest, bs_ip: ipFromOuts(outs_pitched) }, outs_pitched };
  });
  return { version: SCOREBOOK_VERSION, state: out, tallies: tallyList, issues, log };
}

// ── Persistence helpers ────────────────────────────────────────────────────
export function loadEvents(db, jobId) {
  return db.prepare(
    "SELECT * FROM cmd_events WHERE job_id = ? AND event_type IN ('lineup','half_inning','plate_appearance','pitch','runner','substitution','game_final') AND status IN ('active','needs_review') ORDER BY sequence, id"
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
    const stats = Object.fromEntries(Object.entries(t.stats).filter(([k, v]) => k.startsWith('bs_') && v !== 0 || k === 'bs_pa'));
    return { key: `live:${t.player_id}`, group: 'scorebook', row: null, jersey: rosterById.get(t.player_id)?.jersey || '', name: t.name || t.label, stats, player_id: t.player_id, player_name: t.name || t.label, resolved_by: 'scorebook', skipped: false };
  });
  const blocking = rp.issues.filter(i => i.level === 'blocking');
  const status = rp.state.final && blocking.length === 0 ? 'validated' : 'validating';
  const warnings = rp.issues.map(i => i.message);
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
export function appendEvent(db, jobId, { event_type, parent_event_id = null, payload = {}, selected_feed_id = null, timecode_s = null }, actorId) {
  if (!EVENT_TYPES.includes(event_type)) throw err(`event_type must be one of ${EVENT_TYPES.join(', ')}`);
  validatePayload(event_type, payload);
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw err('Job not found', 404);
  const before = replayJob(db, jobId);
  if (before.state.final && event_type !== 'game_final') throw err('Game is final — void the final event to keep scoring', 409);

  const run = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO cmd_events (job_id, sequence, event_type, parent_event_id, player_id, payload, selected_feed_id, timecode_s, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let parent = parent_event_id;
    // A plate appearance or between-batter runner event needs an open half inning.
    if (['plate_appearance', 'runner'].includes(event_type) && !parent) {
      const halves = before.events.filter(e => e.event_type === 'half_inning');
      let half = halves.at(-1) || null;
      if (!half || before.state.half_complete) {
        if (before.state.us_is_home == null) throw err('Enter our lineup (with home/away) before scoring a plate appearance');
        const nextHalf = half ? (before.state.half === 'top' ? { inning: before.state.inning, half: 'bottom' } : { inning: before.state.inning + 1, half: 'top' }) : { inning: 1, half: 'top' };
        const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, actorId).lastInsertRowid;
        audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
        half = { id: hid };
      }
      if (event_type === 'plate_appearance' || (event_type === 'runner' && !parent)) parent = half.id;
    }
    if (event_type === 'pitch' && !parent) throw err('A pitch needs its plate appearance (parent_event_id)');
    const playerId = payload.batter_player_id || payload.runner_player_id || payload.player_in_id || null;
    const id = ins.run(jobId, nextSequence(db, jobId), event_type, parent, playerId, JSON.stringify(payload), selected_feed_id, timecode_s, actorId).lastInsertRowid;
    audit(db, 'cmd_events', id, actorId, 'created', describeForAudit(event_type, payload));
    // Third out → next half, automatically, so the scorer never has to.
    const after = replayJob(db, jobId);
    if (after.state.half_complete && !after.state.final && !after.state.game_over_suggested) {
      const nextHalf = after.state.half === 'top' ? { inning: after.state.inning, half: 'bottom' } : { inning: after.state.inning + 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, actorId).lastInsertRowid;
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
export function appendPlateAppearance(db, jobId, { pa, pitches = [], runners = [], selected_feed_id = null, timecode_s = null }, actorId) {
  validatePayload('plate_appearance', pa || {});
  for (const r of runners) validatePayload('runner', r);
  for (const x of pitches) validatePayload('pitch', x);
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw err('Job not found', 404);
  const before = replayJob(db, jobId);
  if (before.state.final) throw err('Game is final — void the final event to keep scoring', 409);
  if (before.state.us_is_home == null) throw err('Enter our lineup (with home/away) before scoring a plate appearance');

  const run = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO cmd_events (job_id, sequence, event_type, parent_event_id, player_id, payload, selected_feed_id, timecode_s, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let half = before.events.filter(e => e.event_type === 'half_inning').at(-1) || null;
    if (!half || before.state.half_complete) {
      const nextHalf = half ? (before.state.half === 'top' ? { inning: before.state.inning, half: 'bottom' } : { inning: before.state.inning + 1, half: 'top' }) : { inning: 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, actorId).lastInsertRowid;
      audit(db, 'cmd_events', hid, actorId, 'created', `${nextHalf.half} ${nextHalf.inning} (auto)`);
      half = { id: hid };
    }
    const paPayload = { ...pa, pitch_count: pitches.length || pa.pitch_count || 0 };
    const paId = ins.run(jobId, nextSequence(db, jobId), 'plate_appearance', half.id, pa.batter_player_id || null, JSON.stringify(paPayload), selected_feed_id, timecode_s, actorId).lastInsertRowid;
    audit(db, 'cmd_events', paId, actorId, 'created', describeForAudit('plate_appearance', paPayload));
    for (const x of pitches) ins.run(jobId, nextSequence(db, jobId), 'pitch', paId, null, JSON.stringify(x), null, null, actorId);
    for (const r of [...runners].sort((a, b) => b.from - a.from)) {
      const rid = ins.run(jobId, nextSequence(db, jobId), 'runner', paId, r.runner_player_id || null, JSON.stringify(r), null, null, actorId).lastInsertRowid;
      audit(db, 'cmd_events', rid, actorId, 'created', describeForAudit('runner', r));
    }
    const after = replayJob(db, jobId);
    if (after.state.half_complete && !after.state.final && !after.state.game_over_suggested) {
      const nextHalf = after.state.half === 'top' ? { inning: after.state.inning, half: 'bottom' } : { inning: after.state.inning + 1, half: 'top' };
      const hid = ins.run(jobId, nextSequence(db, jobId), 'half_inning', null, null, JSON.stringify({ ...nextHalf, auto: true }), null, null, actorId).lastInsertRowid;
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
    const id = db.prepare(
      `INSERT INTO cmd_events (job_id, sequence, event_type, parent_event_id, player_id, payload, selected_feed_id, timecode_s, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(old.job_id, old.sequence, old.event_type, old.parent_event_id, payload.batter_player_id || payload.runner_player_id || payload.player_in_id || old.player_id, JSON.stringify(payload), old.selected_feed_id, old.timecode_s, actorId).lastInsertRowid;
    db.prepare("UPDATE cmd_events SET status = 'superseded', superseded_by = ? WHERE id = ?").run(id, old.id);
    db.prepare('UPDATE cmd_events SET parent_event_id = ? WHERE parent_event_id = ?').run(id, old.id);
    audit(db, 'cmd_events', id, actorId, 'corrected', note || `${describeForAudit(old.event_type, safeJson(old.payload))} → ${describeForAudit(old.event_type, payload)}`, String(old.payload).slice(0, 600), JSON.stringify(payload).slice(0, 600));
    afterCorrection(db, old.job_id, actorId, `event ${old.sequence} corrected`);
    return id;
  });
  const id = run();
  return { event_id: id, superseded_id: old.id, ...replayJob(db, old.job_id) };
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
