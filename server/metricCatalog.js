// Single source of truth for every stat Diamond Metrics captures.
// Derived from Diamond_Metrics_Mockup_Metrics.docx.
//
// Each metric:
//   key        - stable identifier stored in stat_entries.metric_key
//   label      - display name
//   unit       - display unit ('' for unitless scores/counts)
//   category   - hitting | pitching | defense | running
//   aggregate  - how to roll up per-game values into a career/profile number:
//                'max' (best mark), 'avg' (mean across games), 'latest' (most recent),
//                'sum' (season total — box-score counting stats)
//   decimals   - display precision
//   lowerIsBetter - for times (60-yard dash etc.), best mark = min
//   short      - compact column header for box-score tables (game summary only)

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

  // ── Game Summary (box-score counting stats; season totals = sum) ─────
  { key: 'bs_pa',          label: 'Plate Appearances',     short: 'PA',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ab',          label: 'At Bats',               short: 'AB',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_r',           label: 'Runs',                  short: 'R',   unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_h',           label: 'Hits',                  short: 'H',   unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_2b',          label: 'Doubles',               short: '2B',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_3b',          label: 'Triples',               short: '3B',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hr',          label: 'Home Runs',             short: 'HR',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_rbi',         label: 'RBIs',                  short: 'RBI', unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_bb',          label: 'Walks',                 short: 'BB',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_k',           label: 'Strikeouts (Batting)',  short: 'K',   unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hbp',         label: 'Hit By Pitch',          short: 'HBP', unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_sb',          label: 'Stolen Bases',          short: 'SB',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ip',          label: 'Innings Pitched',       short: 'IP',  unit: '', category: 'box', aggregate: 'sum', decimals: 1 },
  { key: 'bs_bf',          label: 'Batters Faced',         short: 'BF',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ha',          label: 'Hits Allowed',          short: 'HA',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ra',          label: 'Runs Allowed',          short: 'RA',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_er',          label: 'Earned Runs',           short: 'ER',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_bba',         label: 'Walks Allowed',         short: 'BBA', unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_kp',          label: 'Strikeouts (Pitching)', short: 'KP',  unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hra',         label: 'Home Runs Allowed',     short: 'HRA', unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_pitches',     label: 'Pitches Thrown',        short: 'PIT', unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
  { key: 'bs_e',           label: 'Errors',                short: 'E',   unit: '', category: 'box', aggregate: 'sum', decimals: 0 },
];

export const CATEGORIES = [
  { key: 'box',      label: 'Game Summary' },
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
// 'pro_day' events power the shareable Pro Day player card.
export const GAME_TYPES = ['game', 'practice', 'showcase', 'bullpen', 'scrimmage', 'athletic_testing', 'pro_day'];

// Position groups used for card archetypes and event-ranking cohorts.
export function positionGroup(primaryPosition) {
  const pos = (primaryPosition || '').toUpperCase();
  if (pos === 'C') return 'C';
  if (['RHP', 'LHP', 'P', 'SP', 'RP'].includes(pos)) return 'P';
  if (['LF', 'CF', 'RF', 'OF'].includes(pos)) return 'OF';
  if (['1B', '2B', '3B', 'SS', 'IF'].includes(pos)) return 'INF';
  return 'UTIL';
}
