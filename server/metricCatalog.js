// Single source of truth for every stat Diamond Metrics captures.
// Derived from Diamond_Metrics_Mockup_Metrics.docx.
//
// Each metric:
//   key        - stable identifier stored in stat_entries.metric_key
//   label      - display name
//   unit       - display unit ('' for unitless scores/counts)
//   category   - hitting | pitching | defense | running
//   aggregate  - how to roll up per-game values into a career/profile number:
//                'max' (best mark), 'avg' (mean across games), 'latest' (most recent)
//   decimals   - display precision
//   lowerIsBetter - for times (60-yard dash etc.), best mark = min

export const METRICS = [
  // ── Hitting ──────────────────────────────────────────────────────────
  { key: 'max_exit_velo',  label: 'Max Exit Velocity',     unit: 'mph',  category: 'hitting',  aggregate: 'max',    decimals: 1 },
  { key: 'avg_exit_velo',  label: 'Average Exit Velocity', unit: 'mph',  category: 'hitting',  aggregate: 'avg',    decimals: 1 },
  { key: 'hard_hit_pct',   label: 'Hard Hit %',            unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'contact_pct',    label: 'Contact %',             unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'launch_angle',   label: 'Launch Angle (Avg)',    unit: '°',    category: 'hitting',  aggregate: 'avg',    decimals: 1 },
  { key: 'pull_pct',       label: 'Pull %',                unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'middle_pct',     label: 'Middle %',              unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'oppo_pct',       label: 'Opposite Field %',      unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'batting_avg',    label: 'Batting Average',       unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'obp',            label: 'OBP',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'slg',            label: 'SLG',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'ops',            label: 'OPS',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },

  // ── Pitching ─────────────────────────────────────────────────────────
  { key: 'max_velo',       label: 'Max Velocity',          unit: 'mph',  category: 'pitching', aggregate: 'max',    decimals: 1 },
  { key: 'avg_velo',       label: 'Average Velocity',      unit: 'mph',  category: 'pitching', aggregate: 'avg',    decimals: 1 },
  { key: 'strike_pct',     label: 'Strike %',              unit: '%',    category: 'pitching', aggregate: 'avg',    decimals: 0 },
  { key: 'whiff_pct',      label: 'Whiff %',               unit: '%',    category: 'pitching', aggregate: 'avg',    decimals: 0 },
  { key: 'command_score',  label: 'Command Score',         unit: '',     category: 'pitching', aggregate: 'avg',    decimals: 0 },

  // ── Defense ──────────────────────────────────────────────────────────
  { key: 'arm_strength',   label: 'Arm Strength',          unit: 'mph',  category: 'defense',  aggregate: 'max',    decimals: 0 },
  { key: 'throw_accuracy', label: 'Throw Accuracy',        unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0 },
  { key: 'reaction_time',  label: 'Reaction Time',         unit: 's',    category: 'defense',  aggregate: 'avg',    decimals: 2, lowerIsBetter: true },
  { key: 'range_score',    label: 'Range Score',           unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0 },
  { key: 'pop_time',       label: 'Pop Time',              unit: 's',    category: 'defense',  aggregate: 'max',    decimals: 2, lowerIsBetter: true },
  { key: 'blocking_score', label: 'Blocking Score',        unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0 },

  // ── Running ──────────────────────────────────────────────────────────
  { key: 'sprint_speed',   label: 'Sprint Speed',          unit: 'ft/s', category: 'running',  aggregate: 'max',    decimals: 1 },
  { key: 'home_to_first',  label: 'Home-to-First Time',    unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true },
  { key: 'sprint_30',      label: '30-Yard Sprint',        unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true },
  { key: 'dash_60',        label: '60-Yard Dash',          unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true },
];

export const CATEGORIES = [
  { key: 'hitting',  label: 'Hitting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'defense',  label: 'Defense' },
  { key: 'running',  label: 'Running' },
];

// Player attribute ratings (0-100), stored on the player record itself.
export const ATTRIBUTES = ['power', 'contact', 'speed', 'arm', 'defense', 'athleticism'];

// Hero metrics adapt to position (per the mockup doc). Order matters.
export const HERO_SETS = {
  positionPlayer: ['max_exit_velo', 'avg_exit_velo', 'hard_hit_pct', 'contact_pct', 'sprint_speed', 'dash_60', 'arm_strength'],
  pitcher:        ['max_velo', 'avg_velo', 'strike_pct', 'whiff_pct', 'command_score', 'arm_strength'],
  catcher:        ['pop_time', 'max_exit_velo', 'contact_pct', 'arm_strength', 'throw_accuracy', 'blocking_score'],
};

export function heroSetForPosition(primaryPosition) {
  const pos = (primaryPosition || '').toUpperCase();
  if (pos === 'C') return HERO_SETS.catcher;
  if (['RHP', 'LHP', 'P', 'SP', 'RP'].includes(pos)) return HERO_SETS.pitcher;
  return HERO_SETS.positionPlayer;
}

export const VALID_METRIC_KEYS = new Set(METRICS.map(m => m.key));

// Game/event types the admin can log stats against.
export const GAME_TYPES = ['game', 'practice', 'showcase', 'bullpen', 'scrimmage', 'athletic_testing'];
