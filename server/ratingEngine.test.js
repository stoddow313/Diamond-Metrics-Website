// Acceptance tests for the Pro Day rating engine (requirements §11),
// using representative 13U–17U players. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageOnDate, ageGroupForAge, ageFromGradYear, resolveAgeGroup,
  interpolateRating, eventRelativeRating, armBenchmarkKey,
  computeSkills, computeOverall, overallFormulaFor,
  tierFor, archetypeFor, strengthsAndDevelopment, computeRatings,
} from './ratingEngine.js';
import { BENCHMARKS, PG_VERSION, DM13U_VERSION } from './benchmarks.js';

// ── Age-group assignment (§2) ────────────────────────────────────────────

test('age is computed on the event date, birthday-aware', () => {
  assert.equal(ageOnDate('2010-08-01', '2026-07-21'), 15); // birthday after event
  assert.equal(ageOnDate('2010-07-21', '2026-07-21'), 16); // birthday on event day
  assert.equal(ageOnDate('2010-06-01', '2026-07-21'), 16);
});

test('each age maps to its benchmark group; 13U provisional, 14U-17U PG, 18+ event-relative', () => {
  assert.equal(ageGroupForAge(13), '13U');
  assert.equal(BENCHMARKS['13U'].version, DM13U_VERSION);
  for (const age of [14, 15, 16, 17]) {
    assert.equal(ageGroupForAge(age), `${age}U`);
    assert.equal(BENCHMARKS[`${age}U`].version, PG_VERSION);
  }
  assert.equal(ageGroupForAge(18), '18U');
  assert.equal(ageGroupForAge(21), '18U');
  assert.equal(BENCHMARKS['18U'].version, 'EVENT_RELATIVE');
});

test('date of birth wins over grad class; grad class is the fallback', () => {
  const both = resolveAgeGroup({ dateOfBirth: '2011-09-01', gradYear: 2027, eventDate: '2026-07-21' });
  assert.equal(both.source, 'date_of_birth');
  assert.equal(both.group, '14U'); // young for his class — grad year would have said 17U
  const fallback = resolveAgeGroup({ dateOfBirth: null, gradYear: 2027, eventDate: '2026-07-21' });
  assert.equal(fallback.source, 'grad_class');
  assert.equal(ageFromGradYear(2027, '2026-07-21'), 17);
  assert.equal(fallback.group, '17U');
});

// ── External interpolation (§3) ──────────────────────────────────────────

test('anchors land exactly: 17U 60-yard Avg→60, Plus→80, Elite→90', () => {
  const t = BENCHMARKS['17U'].dash_60;
  assert.equal(interpolateRating(7.26, t), 60);
  assert.equal(interpolateRating(6.80, t), 80);
  assert.equal(interpolateRating(6.65, t), 90);
});

test('timed metrics improve as time decreases (§11)', () => {
  const t = BENCHMARKS['16U'].dash_60;
  assert.ok(interpolateRating(6.95, t) > interpolateRating(7.40, t));
});

test('linear interpolation between anchors', () => {
  const t = BENCHMARKS['17U'].max_exit_velo; // 83 / 90 / 93
  assert.equal(interpolateRating(86.5, t), 70);   // halfway avg→plus
  assert.equal(interpolateRating(91.5, t), 85);   // halfway plus→elite
});

test('below-average extrapolates down and clamps at 40; beyond-elite clamps at 99', () => {
  const t = BENCHMARKS['17U'].max_velo; // 82 / 88 / 92
  assert.ok(interpolateRating(78, t) < 60);
  assert.equal(interpolateRating(40, t), 40);
  assert.ok(interpolateRating(93, t) > 90);
  assert.equal(interpolateRating(120, t), 99);
});

test('position-dependent arm benchmarks select the right column', () => {
  assert.equal(armBenchmarkKey('SS'), 'arm_INF');
  assert.equal(armBenchmarkKey('1B'), 'arm_1B');
  assert.equal(armBenchmarkKey('CF'), 'arm_OF');
  assert.equal(armBenchmarkKey('C'), 'arm_C');
  assert.equal(armBenchmarkKey('RHP'), null); // event-relative
});

// ── Event-relative ratings (§5) ──────────────────────────────────────────

test('event percentiles: best=95(cap), midpoint scales, times invert', () => {
  const best = eventRelativeRating(50, [50, 40, 30], false);
  assert.equal(best.rating, 95); // 40 + 55*1 = 95 exactly at cap
  const mid = eventRelativeRating(40, [50, 40, 30], false);
  assert.equal(mid.rating, Math.round(40 + 55 * 0.5));
  const fastest = eventRelativeRating(6.9, [6.9, 7.4, 7.8], true);
  assert.equal(fastest.rating, 95);
});

test('event-relative ratings cap at 95 and need 2+ participants; nulls excluded', () => {
  assert.equal(eventRelativeRating(50, [50], false), null);
  assert.equal(eventRelativeRating(50, [50, null, undefined], false), null);
});

// ── Skills (§6) ──────────────────────────────────────────────────────────

const R = (rating) => ({ rating, source: 'external' });

test('power = 60% max EV + 30% avg EV + 10% hard-hit', () => {
  const skills = computeSkills({ max_exit_velo: R(90), avg_exit_velo: R(80), hard_hit_pct: R(70) });
  assert.equal(Math.round(skills.power.rating), Math.round(90 * .6 + 80 * .3 + 70 * .1));
  assert.equal(skills.power.partial, false);
});

test('missing lesser components renormalize; missing anchor voids the skill', () => {
  const partial = computeSkills({ max_exit_velo: R(90) });
  assert.equal(partial.power.rating, 90);
  assert.equal(partial.power.partial, true);
  const noAnchor = computeSkills({ avg_exit_velo: R(80), hard_hit_pct: R(70) });
  assert.equal(noAnchor.power, null); // never built without its top-weight metric
});

test('athleticism = 50% speed skill + 25% reaction + 25% arm skill', () => {
  const skills = computeSkills({
    dash_60: R(80), home_to_first: R(80),
    arm_strength: R(70), throw_accuracy: R(70),
    reaction_time: R(60),
  });
  assert.equal(Math.round(skills.athleticism.rating), Math.round(80 * .5 + 60 * .25 + 70 * .25));
});

// ── Overall (§7, §8) ─────────────────────────────────────────────────────

function skillSet(ratings) {
  const out = {};
  for (const [k, v] of Object.entries(ratings)) out[k] = v == null ? null : { rating: v, partial: false };
  return out;
}

test('position-player overall needs at least 3 skills', () => {
  assert.equal(computeOverall('middle_if', skillSet({ power: 80, contact: 75 })), null);
  const ok = computeOverall('middle_if', skillSet({ power: 80, contact: 75, speed: 70 }));
  assert.notEqual(ok, null);
  assert.equal(ok.provisional, true); // incomplete formula → provisional
});

test('pitcher overall requires both pitch velocity and command', () => {
  assert.equal(computeOverall('pitcher', skillSet({ pitch_velocity: 85 })), null);
  assert.equal(computeOverall('pitcher', skillSet({ command: 85 })), null);
  const ok = computeOverall('pitcher', skillSet({ pitch_velocity: 85, command: 75, athleticism: 70 }));
  assert.equal(Math.round(ok.value), Math.round(85 * .45 + 75 * .40 + 70 * .15));
  assert.equal(ok.provisional, false);
});

test('missing skills never count as zero (§8, §11)', () => {
  const full = computeOverall('outfield', skillSet({ power: 80, contact: 80, speed: 80, arm: 80, defense: 80 }));
  const missingTwo = computeOverall('outfield', skillSet({ power: 80, contact: 80, speed: 80 }));
  assert.equal(Math.round(full.value), 80);
  assert.equal(Math.round(missingTwo.value), 80); // renormalized, not dragged to 48
  assert.equal(missingTwo.provisional, true);
});

test('overall formula routes by primary position', () => {
  assert.equal(overallFormulaFor('3B'), 'corner_if');
  assert.equal(overallFormulaFor('SS'), 'middle_if');
  assert.equal(overallFormulaFor('CF'), 'outfield');
  assert.equal(overallFormulaFor('C'), 'catcher');
  assert.equal(overallFormulaFor('LHP'), 'pitcher');
});

// ── Card elements (§9) ───────────────────────────────────────────────────

test('tier boundaries', () => {
  assert.equal(tierFor(94), 'Diamond');
  assert.equal(tierFor(90), 'Diamond');
  assert.equal(tierFor(85), 'Gold');
  assert.equal(tierFor(72), 'Silver');
  assert.equal(tierFor(60), 'Bronze');
  assert.equal(tierFor(55), 'Development');
});

test('archetypes: top-skill mapping, combos, pitcher split, two-way', () => {
  assert.equal(archetypeFor({ skills: skillSet({ power: 90, contact: 70, defense: 65 }), isPitcher: false, isTwoWay: false }), 'Power Bat');
  assert.equal(archetypeFor({ skills: skillSet({ power: 90, speed: 88, contact: 70 }), isPitcher: false, isTwoWay: false }), 'Power-Speed Athlete');
  assert.equal(archetypeFor({ skills: skillSet({ arm: 90, defense: 88, power: 70 }), isPitcher: false, isTwoWay: false }), 'Strong-Arm Defender');
  assert.equal(archetypeFor({ skills: skillSet({ pitch_velocity: 88, command: 75 }), isPitcher: true, isTwoWay: false }), 'Velocity Pitcher');
  assert.equal(archetypeFor({ skills: skillSet({ pitch_velocity: 75, command: 88 }), isPitcher: true, isTwoWay: false }), 'Command Pitcher');
  assert.equal(archetypeFor({ skills: {}, isPitcher: false, isTwoWay: true }), 'Two-Way Prospect');
});

test('strengths are the top two skills; missing skills are never development areas (§8)', () => {
  const { strengths, developmentAreas } = strengthsAndDevelopment(
    skillSet({ power: 88, contact: 60, speed: 75, arm: null, defense: 65 }),
    'outfield'
  );
  assert.deepEqual(strengths, ['power', 'speed']);
  assert.ok(!developmentAreas.includes('arm'));
  assert.ok(developmentAreas.includes('contact'));
});

// ── Full pipeline with representative players (§11) ──────────────────────

const EVENT = '2026-07-21';

test('17U shortstop: full pipeline end to end', () => {
  const stats = {
    max_exit_velo: 93, avg_exit_velo: 88, hard_hit_pct: 48, contact_pct: 82, quality_la_pct: 40,
    dash_60: 6.65, home_to_first: 4.1, arm_strength: 88, throw_accuracy: 85,
    reaction_time: 0.22, fielding_success: 90,
  };
  const participants = [stats,
    { ...stats, max_exit_velo: 85, dash_60: 7.2, hard_hit_pct: 30, contact_pct: 70, throw_accuracy: 60, reaction_time: 0.3, fielding_success: 70, home_to_first: 4.5, quality_la_pct: 25, avg_exit_velo: 80, arm_strength: 80 },
    { ...stats, max_exit_velo: 80, dash_60: 7.6, hard_hit_pct: 25, contact_pct: 60, throw_accuracy: 50, reaction_time: 0.35, fielding_success: 60, home_to_first: 4.8, quality_la_pct: 20, avg_exit_velo: 75, arm_strength: 74 },
  ];
  const r = computeRatings({ stats, participants, dateOfBirth: '2009-02-10', eventDate: EVENT, primaryPosition: 'SS' });

  assert.equal(r.ageGroup, '17U');
  assert.equal(r.benchmark.version, PG_VERSION);
  assert.equal(r.metrics.max_exit_velo.rating, 90);      // 17U elite anchor
  assert.equal(r.metrics.max_exit_velo.source, 'external');
  assert.equal(r.metrics.dash_60.rating, 90);            // 17U elite time
  assert.equal(r.metrics.arm_strength.rating, 90); // 17U INF arm elite = 88 mph
  assert.equal(r.metrics.throw_accuracy.source, 'event_percentile');
  assert.ok(r.overall && r.overall.value >= 80);
  assert.equal(r.overall.formula, 'middle_if');
  assert.equal(r.label, 'Provisional Pro Day Rating');
  assert.equal(r.tier, tierFor(r.overall.value));
  assert.equal(r.strengths.length, 2);
});

test('13-year-old uses the provisional 13U table (§11)', () => {
  const stats = { max_exit_velo: 81, dash_60: 7.05 };
  const r = computeRatings({ stats, participants: [stats], dateOfBirth: '2013-01-15', eventDate: EVENT, primaryPosition: '2B' });
  assert.equal(r.ageGroup, '13U');
  assert.equal(r.benchmark.version, DM13U_VERSION);
  assert.equal(r.benchmark.provisional, true);
  assert.equal(r.metrics.max_exit_velo.rating, 90); // 13U elite = 81
  assert.equal(r.metrics.dash_60.rating, 90);       // 13U elite = 7.05
});

test('14U catcher: pop time + catcher arm benchmarks and catcher overall', () => {
  const stats = {
    pop_time: 1.98, arm_strength: 75, throw_accuracy: 80, blocking_score: 85,
    max_exit_velo: 84, avg_exit_velo: 78, hard_hit_pct: 35, contact_pct: 75, quality_la_pct: 30,
    dash_60: 7.2, home_to_first: 4.4, reaction_time: 0.26, fielding_success: 82,
  };
  const others = [
    { ...stats, pop_time: 2.2, throw_accuracy: 55, blocking_score: 60, reaction_time: 0.33, fielding_success: 60, contact_pct: 60, hard_hit_pct: 20, quality_la_pct: 18, home_to_first: 4.7 },
    { ...stats, pop_time: 2.35, throw_accuracy: 45, blocking_score: 50, reaction_time: 0.4, fielding_success: 50, contact_pct: 55, hard_hit_pct: 15, quality_la_pct: 12, home_to_first: 5.0 },
  ];
  const r = computeRatings({ stats, participants: [stats, ...others], dateOfBirth: '2012-03-05', eventDate: EVENT, primaryPosition: 'C' });
  assert.equal(r.ageGroup, '14U');
  assert.equal(r.metrics.pop_time.rating, 90);       // 14U elite pop = 1.98
  assert.equal(r.metrics.pop_time.source, 'external');
  assert.equal(r.metrics.arm_strength.rating, 90);   // 14U catcher velo elite = 75
  assert.ok(r.skills.catching?.rating != null);
  assert.equal(r.overall.formula, 'catcher');
});

test('15U pitcher: two-way when both sides qualify, pitcher-only otherwise', () => {
  const pitcherOnly = {
    max_velo: 85, avg_velo: 80, strike_pct: 65, target_accuracy: 78,
    dash_60: 7.4, home_to_first: 4.5, reaction_time: 0.3, arm_strength: 80, throw_accuracy: 70,
  };
  const others = [
    { ...pitcherOnly, max_velo: 78, strike_pct: 55, target_accuracy: 60, reaction_time: 0.36, throw_accuracy: 55, home_to_first: 4.8 },
    { ...pitcherOnly, max_velo: 74, strike_pct: 50, target_accuracy: 50, reaction_time: 0.4, throw_accuracy: 45, home_to_first: 5.0 },
  ];
  const r = computeRatings({ stats: pitcherOnly, participants: [pitcherOnly, ...others], dateOfBirth: '2011-04-20', eventDate: EVENT, primaryPosition: 'RHP', secondaryPosition: 'OF' });
  assert.equal(r.ageGroup, '15U');
  assert.equal(r.metrics.max_velo.rating, 90); // 15U pitch elite = 85
  assert.ok(r.overall != null);
  assert.equal(r.overall.formula, 'pitcher');
  assert.equal(r.isTwoWay, false); // no hitting data → no position-player overall
  assert.ok(['Velocity Pitcher', 'Command Pitcher'].includes(r.archetype));

  const twoWayStats = { ...pitcherOnly, max_exit_velo: 86, avg_exit_velo: 80, hard_hit_pct: 40, contact_pct: 78, quality_la_pct: 30, fielding_success: 80 };
  const r2 = computeRatings({ stats: twoWayStats, participants: [twoWayStats, ...others], dateOfBirth: '2011-04-20', eventDate: EVENT, primaryPosition: 'RHP', secondaryPosition: 'OF' });
  assert.equal(r2.isTwoWay, true);
  assert.equal(r2.archetype, 'Two-Way Prospect');
  assert.equal(r2.secondaryOverall.formula, 'outfield');
});

test('16U with missing measurements: nulls stay null, overall gates correctly (§11)', () => {
  const stats = { max_exit_velo: 90, avg_exit_velo: 84, dash_60: 6.91 }; // no defense/arm data at all
  const r = computeRatings({ stats, participants: [stats], dateOfBirth: '2010-01-10', eventDate: EVENT, primaryPosition: '3B' });
  assert.equal(r.ageGroup, '16U');
  assert.equal(r.metrics.max_exit_velo.rating, 90);   // 16U elite = 90
  assert.equal(r.skills.arm, null);
  assert.equal(r.skills.defense, null);
  assert.equal(r.skills.contact, null);               // anchor (contact %) missing
  assert.equal(r.overall, null);                       // only 2 of 5 skills → no overall
  assert.ok(!r.developmentAreas.includes('arm'));      // missing ≠ development area
});

test('18+ players rate event-relative until an external table is approved', () => {
  const stats = { max_exit_velo: 95, dash_60: 6.8 };
  const others = [{ max_exit_velo: 88, dash_60: 7.1 }, { max_exit_velo: 84, dash_60: 7.4 }];
  const r = computeRatings({ stats, participants: [stats, ...others], dateOfBirth: '2007-05-01', eventDate: EVENT, primaryPosition: 'OF' });
  assert.equal(r.ageGroup, '18U');
  assert.equal(r.metrics.max_exit_velo.source, 'event_percentile');
  assert.equal(r.metrics.max_exit_velo.rating, 95); // best in event, capped
});
