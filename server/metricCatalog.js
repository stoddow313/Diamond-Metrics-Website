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
//   zeroMeansUnmeasured - a literal 0 can't be a real measurement (0 mph, 0s,
//                0% strike). Imports/entry treat 0 as "not measured" so
//                non-participants never drag averages down. Signed metrics
//                (launch angle, spray) and box counting stats keep real zeros.

export const METRICS = [
  // ── Hitting ──────────────────────────────────────────────────────────
  { key: 'max_exit_velo',  label: 'Max Exit Velocity',     unit: 'mph',  category: 'hitting',  aggregate: 'max',    decimals: 1, zeroMeansUnmeasured: true },
  { key: 'avg_exit_velo',  label: 'Average Exit Velocity', unit: 'mph',  category: 'hitting',  aggregate: 'avg',    decimals: 1, zeroMeansUnmeasured: true },
  { key: 'hard_hit_pct',   label: 'Hard Hit %',            unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'contact_pct',    label: 'Contact %',             unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'launch_angle',   label: 'Launch Angle (Avg)',    unit: '°',    category: 'hitting',  aggregate: 'avg',    decimals: 1 },
  { key: 'quality_la_pct', label: 'Quality Launch Angle %', unit: '%',   category: 'hitting',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'pull_pct',       label: 'Pull %',                unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'middle_pct',     label: 'Middle %',              unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'oppo_pct',       label: 'Opposite Field %',      unit: '%',    category: 'hitting',  aggregate: 'avg',    decimals: 0 },
  { key: 'batting_avg',    label: 'Batting Average',       unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'obp',            label: 'OBP',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'slg',            label: 'SLG',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },
  { key: 'ops',            label: 'OPS',                   unit: '',     category: 'hitting',  aggregate: 'avg',    decimals: 3 },

  // ── Pitching ─────────────────────────────────────────────────────────
  { key: 'max_velo',       label: 'Max Velocity',          unit: 'mph',  category: 'pitching', aggregate: 'max',    decimals: 1, zeroMeansUnmeasured: true },
  { key: 'avg_velo',       label: 'Average Velocity',      unit: 'mph',  category: 'pitching', aggregate: 'avg',    decimals: 1, zeroMeansUnmeasured: true },
  { key: 'strike_pct',     label: 'Strike %',              unit: '%',    category: 'pitching', aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'whiff_pct',      label: 'Whiff %',               unit: '%',    category: 'pitching', aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'command_score',  label: 'Command Score',         unit: '',     category: 'pitching', aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'target_accuracy', label: 'Target Accuracy',      unit: '%',    category: 'pitching', aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },

  // ── Defense ──────────────────────────────────────────────────────────
  { key: 'arm_strength',   label: 'Arm Strength',          unit: 'mph',  category: 'defense',  aggregate: 'max',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'throw_accuracy', label: 'Throw Accuracy',        unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'reaction_time',  label: 'Reaction Time',         unit: 's',    category: 'defense',  aggregate: 'avg',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },
  { key: 'range_score',    label: 'Range Score',           unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'pop_time',       label: 'Pop Time',              unit: 's',    category: 'defense',  aggregate: 'max',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },
  { key: 'blocking_score', label: 'Blocking Score',        unit: '',     category: 'defense',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },
  { key: 'fielding_success', label: 'Fielding Success %',  unit: '%',    category: 'defense',  aggregate: 'avg',    decimals: 0, zeroMeansUnmeasured: true },

  // ── Running ──────────────────────────────────────────────────────────
  { key: 'sprint_speed',   label: 'Sprint Speed',          unit: 'ft/s', category: 'running',  aggregate: 'max',    decimals: 1, zeroMeansUnmeasured: true },
  { key: 'home_to_first',  label: 'Home-to-First Time',    unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },
  { key: 'steal_time',     label: 'Steal Time',            unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },
  { key: 'sprint_30',      label: '30-Yard Sprint',        unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },
  { key: 'dash_60',        label: '60-Yard Dash',          unit: 's',    category: 'running',  aggregate: 'max',    decimals: 2, lowerIsBetter: true, zeroMeansUnmeasured: true },

  // ── Game Summary (box-score counting stats; season totals = sum) ─────
  { key: 'bs_pa',          label: 'Plate Appearances',     short: 'PA',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ab',          label: 'At Bats',               short: 'AB',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_r',           label: 'Runs',                  short: 'R',   unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_h',           label: 'Hits',                  short: 'H',   unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_2b',          label: 'Doubles',               short: '2B',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_3b',          label: 'Triples',               short: '3B',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hr',          label: 'Home Runs',             short: 'HR',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_rbi',         label: 'RBIs',                  short: 'RBI', unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_bb',          label: 'Walks',                 short: 'BB',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_k',           label: 'Strikeouts (Batting)',  short: 'K',   unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hbp',         label: 'Hit By Pitch',          short: 'HBP', unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_sb',          label: 'Stolen Bases',          short: 'SB',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_outs',        label: 'Innings Pitched',       short: 'IP',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0, display: 'innings' },   // stored as outs; shown in thirds
  { key: 'bs_bf',          label: 'Batters Faced',         short: 'BF',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ha',          label: 'Hits Allowed',          short: 'HA',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ra',          label: 'Runs Allowed',          short: 'RA',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_er',          label: 'Earned Runs',           short: 'ER',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_bba',         label: 'Walks Allowed',         short: 'BBA', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_kp',          label: 'Strikeouts (Pitching)', short: 'KP',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hra',         label: 'Home Runs Allowed',     short: 'HRA', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_pitches',     label: 'Pitches Thrown',        short: 'PIT', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_e',           label: 'Errors',                short: 'E',   unit: '', category: 'box', group: 'fielding', aggregate: 'sum', decimals: 0 },
  // The rest of the appendix's stored box-score fields (scorebook-derived or imported).
  { key: 'bs_1b',          label: 'Singles',               short: '1B',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_tb',          label: 'Total Bases',           short: 'TB',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ibb',         label: 'Intentional Walks',     short: 'IBB', unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_sh',          label: 'Sacrifice Hits',        short: 'SH',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_sf',          label: 'Sacrifice Flies',       short: 'SF',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_roe',         label: 'Reached on Error',      short: 'ROE', unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_fc',          label: "Fielder's Choice",      short: 'FC',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_lob',         label: 'Left on Base',          short: 'LOB', unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_cs',          label: 'Caught Stealing',       short: 'CS',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_pk',          label: 'Picked Off',            short: 'PK',  unit: '', category: 'box', group: 'batting', aggregate: 'sum', decimals: 0 },
  { key: 'bs_gs',          label: 'Games Started',         short: 'GS',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_strikes',     label: 'Strikes Thrown',        short: 'STR', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_balls',       label: 'Balls Thrown',          short: 'BAL', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ibba',        label: 'Intentional Walks Allowed', short: 'IBBA', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_hbpa',        label: 'Hit Batters',           short: 'HB',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_wp',          label: 'Wild Pitches',          short: 'WP',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_bk',          label: 'Balks',                 short: 'BK',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_ir',          label: 'Inherited Runners',     short: 'IR',  unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_irs',         label: 'Inherited Runners Scored', short: 'IRS', unit: '', category: 'box', group: 'pitching', aggregate: 'sum', decimals: 0 },
  { key: 'bs_po',          label: 'Putouts',               short: 'PO',  unit: '', category: 'box', group: 'fielding', aggregate: 'sum', decimals: 0 },
  { key: 'bs_a',           label: 'Assists',               short: 'A',   unit: '', category: 'box', group: 'fielding', aggregate: 'sum', decimals: 0 },
  { key: 'bs_dp',          label: 'Double Plays',          short: 'DP',  unit: '', category: 'box', group: 'fielding', aggregate: 'sum', decimals: 0 },
  { key: 'bs_pb',          label: 'Passed Balls',          short: 'PB',  unit: '', category: 'box', group: 'fielding', aggregate: 'sum', decimals: 0 },
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
export const ZERO_UNMEASURED_KEYS = new Set(METRICS.filter(m => m.zeroMeansUnmeasured).map(m => m.key));

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
