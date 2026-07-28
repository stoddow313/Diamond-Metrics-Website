// Pro Day rating engine — "Diamond Metrics Player Profile Requirements (V1)" §§1–9.
//
// Pure calculation module: no database access. Callers pass raw measurements
// and the event's comparison population; results carry full provenance
// (benchmark group/version and whether each metric rating is external or
// event-relative). Null stays null throughout — missing data never becomes 0.

import { BENCHMARKS, BENCHMARK_SOURCE, CALCULATION_VERSION, RATING_LABEL } from './benchmarks.js';

// ── Age-group assignment (§2) ────────────────────────────────────────────

export function ageOnDate(dobIso, eventIso) {
  if (!dobIso || !eventIso) return null;
  const dob = new Date(dobIso + 'T00:00:00Z');
  const event = new Date(eventIso + 'T00:00:00Z');
  if (isNaN(dob) || isNaN(event) || event < dob) return null;
  let age = event.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    event.getUTCMonth() < dob.getUTCMonth() ||
    (event.getUTCMonth() === dob.getUTCMonth() && event.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function ageGroupForAge(age) {
  if (age == null) return null;
  if (age <= 13) return '13U';
  if (age >= 18) return '18U';
  return `${age}U`;
}

// Fallback only (§2): same-class athletes can differ in age.
export function ageFromGradYear(gradYear, eventIso) {
  if (!gradYear || !eventIso) return null;
  const eventYear = new Date(eventIso + 'T00:00:00Z').getUTCFullYear();
  if (isNaN(eventYear)) return null;
  return 18 - (Number(gradYear) - eventYear);
}

export function resolveAgeGroup({ dateOfBirth, gradYear, eventDate }) {
  const dobAge = ageOnDate(dateOfBirth, eventDate);
  if (dobAge != null) return { age: dobAge, group: ageGroupForAge(dobAge), source: 'date_of_birth' };
  const gradAge = ageFromGradYear(gradYear, eventDate);
  if (gradAge != null) return { age: gradAge, group: ageGroupForAge(gradAge), source: 'grad_class' };
  return { age: null, group: null, source: null };
}

// ── External benchmark interpolation (§3) ────────────────────────────────
// Anchors: Average = 60, Plus = 80, Elite = 90. Below-average extrapolates
// the Avg→Plus slope (clamped 40); beyond-elite extrapolates the Plus→Elite
// slope (clamped 99). Timed metrics reverse direction.

export function interpolateRating(value, threshold) {
  const { avg, plus, elite, lowerIsBetter } = threshold;
  // Normalize so "better" is always numerically higher.
  const v = lowerIsBetter ? -value : value;
  const a = lowerIsBetter ? -avg : avg;
  const p = lowerIsBetter ? -plus : plus;
  const e = lowerIsBetter ? -elite : elite;

  let rating;
  if (v <= a) rating = 60 - ((a - v) / (p - a)) * 20;
  else if (v <= p) rating = 60 + ((v - a) / (p - a)) * 20;
  else if (v <= e) rating = 80 + ((v - p) / (e - p)) * 10;
  else rating = 90 + ((v - e) / (e - p)) * 10;

  return Math.max(40, Math.min(99, rating));
}

// ── Event-relative percentile ratings (§5) ───────────────────────────────
// eventRating = 40 + 55 * percentile, capped at 95 (96–99 is reserved for
// beyond an approved external Elite threshold). Percentile inverts for
// timed metrics. Requires at least two participants who attempted the drill.

export function eventRelativeRating(value, allValues, lowerIsBetter = false) {
  const values = allValues.filter(v => v !== null && v !== undefined);
  if (value == null || values.length < 2) return null;
  const n = values.length;
  const worse = values.filter(v => (lowerIsBetter ? v > value : v < value)).length;
  const ties = values.filter(v => v === value).length - 1; // excluding self
  const percentile = Math.max(0, Math.min(1, (worse + 0.5 * Math.max(0, ties)) / (n - 1)));
  return { rating: Math.min(95, Math.round(40 + 55 * percentile)), percentile };
}

// ── Metric-level rating (§§3–5) ──────────────────────────────────────────

// Which arm-velocity benchmark column applies to a primary position (§4).
export function armBenchmarkKey(primaryPosition) {
  const pos = (primaryPosition || '').toUpperCase();
  if (pos === 'C') return 'arm_C';
  if (pos === '1B') return 'arm_1B';
  if (['LF', 'CF', 'RF', 'OF'].includes(pos)) return 'arm_OF';
  if (['2B', '3B', 'SS', 'IF'].includes(pos)) return 'arm_INF';
  return null; // pitchers, UTIL, unknown → event-relative
}

const TIMED_METRICS = new Set(['dash_60', 'home_to_first', 'sprint_30', 'reaction_time', 'pop_time']);

function externalThreshold(metricKey, table, primaryPosition) {
  if (!table) return null;
  if (metricKey === 'arm_strength') {
    const key = armBenchmarkKey(primaryPosition);
    return key ? table[key] ?? null : null;
  }
  return table[metricKey] ?? null;
}

// eventValues: same-drill values from all linked event participants (incl. this player)
export function rateMetric(metricKey, value, { benchmarkTable, primaryPosition, eventValues = [] }) {
  if (value === null || value === undefined) return null;

  const threshold = externalThreshold(metricKey, benchmarkTable, primaryPosition);
  if (threshold) {
    return { value, rating: interpolateRating(value, threshold), source: 'external' };
  }
  const rel = eventRelativeRating(value, eventValues, TIMED_METRICS.has(metricKey));
  if (rel) return { value, rating: rel.rating, source: 'event_percentile', percentile: rel.percentile };
  return { value, rating: null, source: 'insufficient_population' };
}

// ── Skill formulas (§6) ──────────────────────────────────────────────────
// A skill computes when its highest-weight metric is rated; missing lesser
// components renormalize the remaining weights (partial = provisional input).

const SKILL_FORMULAS = {
  power:          [['max_exit_velo', 0.60], ['avg_exit_velo', 0.30], ['hard_hit_pct', 0.10]],
  contact:        [['contact_pct', 0.60], ['avg_exit_velo', 0.25], ['quality_la_pct', 0.15]],
  speed:          [['dash_60', 0.70], ['home_to_first', 0.30]],
  arm:            [['arm_strength', 0.70], ['throw_accuracy', 0.30]],
  defense:        [['reaction_time', 0.45], ['throw_accuracy', 0.40], ['fielding_success', 0.15]],
  pitch_velocity: [['max_velo', 0.70], ['avg_velo', 0.30]],
  command:        [['target_accuracy', 0.60], ['strike_pct', 0.40]],
  catching:       [['pop_time', 0.50], ['throw_accuracy', 0.30], ['blocking_score', 0.20]],
};

function weightedAverage(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  return pairs.reduce((s, [v, w]) => s + v * (w / total), 0);
}

export function computeSkills(metricRatings) {
  const rated = k => (metricRatings[k]?.rating != null ? metricRatings[k].rating : null);
  const skills = {};

  for (const [skill, formula] of Object.entries(SKILL_FORMULAS)) {
    const present = formula.filter(([k]) => rated(k) != null);
    const anchorPresent = rated(formula[0][0]) != null; // highest-weight component
    if (!anchorPresent || present.length === 0) {
      skills[skill] = null;
      continue;
    }
    skills[skill] = {
      rating: weightedAverage(present.map(([k, w]) => [rated(k), w])),
      partial: present.length < formula.length,
      components: present.map(([k]) => k),
    };
  }

  // Athleticism = 50% Speed skill + 25% Reaction metric + 25% Arm skill (§6).
  const speed = skills.speed?.rating ?? null;
  const reaction = rated('reaction_time');
  const arm = skills.arm?.rating ?? null;
  const athleticParts = [
    speed != null ? [speed, 0.50] : null,
    reaction != null ? [reaction, 0.25] : null,
    arm != null ? [arm, 0.25] : null,
  ].filter(Boolean);
  skills.athleticism = speed != null && athleticParts.length > 0
    ? { rating: weightedAverage(athleticParts), partial: athleticParts.length < 3, components: ['speed', 'reaction_time', 'arm'].slice(0, athleticParts.length) }
    : null;

  return skills;
}

// ── Position Overall (§7) ────────────────────────────────────────────────

const OVERALL_FORMULAS = {
  corner_if: { label: 'Corner IF', weights: { power: 0.30, contact: 0.20, speed: 0.15, arm: 0.15, defense: 0.20 } },
  middle_if: { label: 'Middle IF', weights: { power: 0.15, contact: 0.20, speed: 0.20, arm: 0.20, defense: 0.25 } },
  outfield:  { label: 'Outfield', weights: { power: 0.20, contact: 0.20, speed: 0.20, arm: 0.20, defense: 0.20 } },
  catcher:   { label: 'Catcher', weights: { power: 0.15, contact: 0.15, speed: 0.10, arm: 0.15, catching: 0.35, athleticism: 0.10 } },
  pitcher:   { label: 'Pitcher', weights: { pitch_velocity: 0.45, command: 0.40, athleticism: 0.15 } },
};

export function overallFormulaFor(primaryPosition) {
  const pos = (primaryPosition || '').toUpperCase();
  if (['RHP', 'LHP', 'P', 'SP', 'RP'].includes(pos)) return 'pitcher';
  if (pos === 'C') return 'catcher';
  if (['1B', '3B'].includes(pos)) return 'corner_if';
  if (['2B', 'SS', 'IF'].includes(pos)) return 'middle_if';
  // OF and UTIL use the balanced 20%-each formula.
  return 'outfield';
}

// §8 gating: position players need ≥3 calculated skills; pitchers need both
// Pitch Velocity and Command. Partial formulas mark the Overall provisional.
export function computeOverall(formulaKey, skills) {
  const formula = OVERALL_FORMULAS[formulaKey];
  const entries = Object.entries(formula.weights);
  const present = entries.filter(([k]) => skills[k]?.rating != null);

  if (formulaKey === 'pitcher') {
    if (skills.pitch_velocity?.rating == null || skills.command?.rating == null) return null;
  } else if (present.length < 3) {
    return null;
  }

  const partialInputs = present.some(([k]) => skills[k].partial);
  return {
    value: weightedAverage(present.map(([k, w]) => [skills[k].rating, w])),
    formula: formulaKey,
    formulaLabel: formula.label,
    provisional: present.length < entries.length || partialInputs,
    skillsUsed: present.map(([k]) => k),
  };
}

// ── Generated card elements (§9) ─────────────────────────────────────────

export function tierFor(overall) {
  if (overall == null) return null;
  if (overall >= 90) return 'Diamond';
  if (overall >= 80) return 'Gold';
  if (overall >= 70) return 'Silver';
  if (overall >= 60) return 'Bronze';
  return 'Development';
}

const POSITION_SKILLS = ['power', 'contact', 'speed', 'arm', 'defense', 'catching', 'athleticism'];
const ARCHETYPE_BY_TOP_SKILL = {
  power: 'Power Bat',
  contact: 'Contact Hitter',
  speed: 'Speed Threat',
  defense: 'Defensive Specialist',
  catching: 'Defensive Specialist',
  arm: 'Strong-Arm Defender',
  athleticism: 'Power-Speed Athlete',
};

export function archetypeFor({ skills, isPitcher, isTwoWay }) {
  if (isTwoWay) return 'Two-Way Prospect';
  if (isPitcher) {
    const pv = skills.pitch_velocity?.rating ?? -1;
    const cmd = skills.command?.rating ?? -1;
    if (pv < 0 && cmd < 0) return null;
    return pv >= cmd ? 'Velocity Pitcher' : 'Command Pitcher';
  }
  const ranked = POSITION_SKILLS
    .filter(k => skills[k]?.rating != null)
    .sort((a, b) => skills[b].rating - skills[a].rating);
  if (ranked.length === 0) return null;
  const topTwo = new Set(ranked.slice(0, 2));
  if (topTwo.has('power') && topTwo.has('speed')) return 'Power-Speed Athlete';
  if (topTwo.has('arm') && topTwo.has('defense')) return 'Strong-Arm Defender';
  return ARCHETYPE_BY_TOP_SKILL[ranked[0]] || null;
}

export function strengthsAndDevelopment(skills, formulaKey) {
  // Rank only skills relevant to the player's overall formula, falling back
  // to all position skills; missing skills are never development areas (§8).
  const relevant = Object.keys(OVERALL_FORMULAS[formulaKey].weights);
  const ranked = relevant
    .filter(k => skills[k]?.rating != null)
    .sort((a, b) => skills[b].rating - skills[a].rating);
  const strengths = ranked.slice(0, 2);
  // Development areas never overlap strengths (a skill can't be both).
  const rest = ranked.slice(2);
  return {
    strengths,
    developmentAreas: rest.slice(-2).reverse(),
  };
}

// ── Full pipeline (§1) ───────────────────────────────────────────────────
// stats: { metric_key: value } for this player's pro-day event
// participants: array of stats objects for every linked event participant
//               (including this player) — used for event-relative percentiles

const PITCHER_POSITIONS = new Set(['RHP', 'LHP', 'P', 'SP', 'RP']);

export function computeRatings({
  stats,
  participants = [],
  dateOfBirth = null,
  gradYear = null,
  eventDate,
  primaryPosition = '',
  secondaryPosition = '',
}) {
  const ageInfo = resolveAgeGroup({ dateOfBirth, gradYear, eventDate });
  const benchmarkTable = ageInfo.group ? BENCHMARKS[ageInfo.group] : null;
  const usableTable = benchmarkTable && benchmarkTable.version !== 'EVENT_RELATIVE' ? benchmarkTable : null;

  // Metric ratings with provenance.
  const metricRatings = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value === null || value === undefined) continue;
    const eventValues = participants.map(p => p[key]).filter(v => v !== null && v !== undefined);
    const rated = rateMetric(key, value, { benchmarkTable: usableTable, primaryPosition, eventValues });
    if (rated) metricRatings[key] = { ...rated, rating: rated.rating != null ? rated.rating : null };
  }

  const skills = computeSkills(metricRatings);

  // Primary overall + two-way handling (§7).
  const isPitcherPrimary = PITCHER_POSITIONS.has((primaryPosition || '').toUpperCase());
  const primaryFormula = overallFormulaFor(primaryPosition);
  const primaryOverall = computeOverall(primaryFormula, skills);

  let secondaryOverall = null;
  let secondaryFormula = null;
  if (isPitcherPrimary) {
    // Position-player side: use their secondary position's formula if listed.
    const firstSecondary = (secondaryPosition || '').split(',')[0].trim();
    secondaryFormula = firstSecondary ? overallFormulaFor(firstSecondary) : 'outfield';
    if (secondaryFormula === 'pitcher') secondaryFormula = 'outfield';
    secondaryOverall = computeOverall(secondaryFormula, skills);
    // "Both sides have sufficient data" (§7): the position-player side of a
    // two-way needs a batting skill, not just running/defense drills.
    if (secondaryOverall && skills.power == null && skills.contact == null) {
      secondaryOverall = null;
    }
  } else {
    secondaryFormula = 'pitcher';
    secondaryOverall = computeOverall('pitcher', skills);
  }
  const isTwoWay = primaryOverall != null && secondaryOverall != null;

  const overallValue = primaryOverall ? Math.round(primaryOverall.value) : null;
  const archetype = archetypeFor({ skills, isPitcher: isPitcherPrimary, isTwoWay });
  const { strengths, developmentAreas } = strengthsAndDevelopment(skills, primaryFormula);

  const roundedSkills = {};
  for (const [k, v] of Object.entries(skills)) {
    roundedSkills[k] = v ? { ...v, rating: Math.round(v.rating) } : null;
  }

  return {
    label: RATING_LABEL,
    calculationVersion: CALCULATION_VERSION,
    calculatedAt: new Date().toISOString(),
    age: ageInfo.age,
    ageGroup: ageInfo.group,
    ageSource: ageInfo.source,
    benchmark: {
      group: ageInfo.group,
      version: benchmarkTable ? benchmarkTable.version : null,
      source: usableTable ? BENCHMARK_SOURCE : 'event_relative',
      provisional: benchmarkTable ? !!benchmarkTable.provisional : true,
    },
    metrics: metricRatings,
    skills: roundedSkills,
    overall: primaryOverall ? { ...primaryOverall, value: overallValue } : null,
    secondaryOverall: secondaryOverall
      ? { ...secondaryOverall, value: Math.round(secondaryOverall.value) }
      : null,
    isTwoWay,
    tier: tierFor(overallValue),
    archetype,
    strengths,
    developmentAreas,
  };
}
