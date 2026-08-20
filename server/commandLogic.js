// Diamond Metrics Command — pure domain logic (no DB access here).
// Registry seed rows mirror the Metric Recipe Appendix; packages mirror the
// PRD §2.1 order model. Status machines implement the two-release model:
// metric release and game record advance independently.

// ── Sellable metric registry (appendix recipes) ──────────────────────────
// Tier meanings (appendix): A standard video/scorebook · B high-FPS/second
// angle · C radar/calibrated device · D pitch-location/calibrated coordinates
// · X not calculable from current DM capture. `active` flips on per delivery
// phase; Phase 1 activates the Rookie core only.
export const REGISTRY_SEED = [
  { metric_code: 'pitch_velocity_radar', label: 'Pitch Velocity — Radar', category: 'rookie', availability_tier: 'C', recipe_version: 'CMD_V1', unit: 'mph', decimals: 1, method: 'radar_verified', publishes_to: ['max_velo', 'avg_velo'], capture_requirements: 'Pocket Radar CSV or approved manual reading matched to pitcher/pitch', active: 1 },
  { metric_code: 'home_to_first', label: 'Home-to-First Time', category: 'rookie', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: ['home_to_first'], capture_requirements: 'Contact and first base visible; 1080p/30 minimum, 60 preferred', active: 1 },
  { metric_code: 'steal_time', label: 'Steal Time', category: 'rookie', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: ['steal_time'], capture_requirements: 'Committed start and destination base visible; 1080p/30 minimum, 60 preferred', active: 1 },
  { metric_code: 'ninety_ft_speed', label: '90-Foot Speed (derived)', category: 'rookie', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 'mph', decimals: 1, method: 'frame_timed', publishes_to: [], dependencies: ['home_to_first'], capture_requirements: 'Valid home-to-first result', active: 1 },
  { metric_code: 'exit_velocity_radar', label: 'Exit Velocity — Radar', category: 'hitting', availability_tier: 'C', recipe_version: 'CMD_V1', unit: 'mph', decimals: 1, method: 'radar_verified', publishes_to: ['max_exit_velo', 'avg_exit_velo'], capture_requirements: 'Radar reading matched to one batted ball', active: 0 },
  { metric_code: 'pitch_velocity_video', label: 'Pitch Velocity — Video Estimate', category: 'pitching', availability_tier: 'B', recipe_version: 'CMD_V1', unit: 'mph', decimals: 1, method: 'video_estimated', publishes_to: [], capture_requirements: 'Calibrated side view, 120 fps preferred', active: 0 },
  { metric_code: 'exit_velocity_video', label: 'Exit Velocity — Video Estimate', category: 'hitting', availability_tier: 'B', recipe_version: 'CMD_V1', unit: 'mph', decimals: 1, method: 'video_estimated', publishes_to: [], capture_requirements: 'Calibrated side view, 120 fps preferred', active: 0 },
  { metric_code: 'launch_angle_video', label: 'Launch Angle — Video Estimate', category: 'hitting', availability_tier: 'B', recipe_version: 'CMD_V1', unit: '°', decimals: 1, method: 'video_estimated', publishes_to: ['launch_angle'], capture_requirements: 'Fixed calibrated side view; 120 fps; contact + 4-5 flight frames', active: 0 },
  { metric_code: 'spray_direction', label: 'Spray Direction', category: 'hitting', availability_tier: 'A', recipe_version: 'CMD_V1', unit: '%', decimals: 0, method: 'manual', publishes_to: ['pull_pct', 'middle_pct', 'oppo_pct'], capture_requirements: 'Behind-home/elevated view sufficient to classify fair BIP', active: 0 },
  { metric_code: 'time_to_home', label: 'Pitcher Time to Home', category: 'pitching', availability_tier: 'B', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: [], capture_requirements: 'Stretch delivery + catcher receive visible; 60 fps minimum', active: 0 },
  { metric_code: 'strike_pct', label: 'Strike Percentage', category: 'pitching', availability_tier: 'A', recipe_version: 'CMD_V1', unit: '%', decimals: 1, method: 'scorebook_derived', publishes_to: ['strike_pct'], capture_requirements: 'Complete pitch-by-pitch scorebook', active: 0 },
  { metric_code: 'whiff_pct', label: 'Whiff Percentage', category: 'pitching', availability_tier: 'A', recipe_version: 'CMD_V1', unit: '%', decimals: 1, method: 'scorebook_derived', publishes_to: ['whiff_pct'], capture_requirements: 'Complete pitch-by-pitch scorebook', active: 0 },
  { metric_code: 'command_target', label: 'Command / Target Accuracy', category: 'pitching', availability_tier: 'A', recipe_version: 'CMD_V1', unit: '', decimals: 0, method: 'manual', publishes_to: ['command_score', 'target_accuracy'], capture_requirements: 'Pitch outcome + analyst intended-location judgment', active: 0 },
  { metric_code: 'ss_to_first', label: 'Shortstop-to-First Time', category: 'fielding', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: [], capture_requirements: 'Release and first-base catch visible', active: 0 },
  { metric_code: 'throw_accuracy', label: 'Throw Accuracy', category: 'fielding', availability_tier: 'A', recipe_version: 'CMD_V1', unit: '%', decimals: 0, method: 'manual', publishes_to: ['throw_accuracy'], capture_requirements: 'Receiver catchable-radius judgment', active: 0 },
  { metric_code: 'of_throw_velocity_video', label: 'OF Throw Velocity — Video Estimate', category: 'fielding', availability_tier: 'B', recipe_version: 'CMD_V1', unit: 'mph', decimals: 0, method: 'video_estimated', publishes_to: ['arm_strength'], capture_requirements: 'Controlled Pro Day; calibrated distance', active: 0 },
  { metric_code: 'reaction_time', label: 'Reaction Time', category: 'athleticism', availability_tier: 'B', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: ['reaction_time'], capture_requirements: 'Controlled Pro Day drill', active: 0 },
  { metric_code: 'sprint_30', label: '30-Yard Sprint', category: 'athleticism', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: ['sprint_30'], capture_requirements: 'Pro Day sprint lane; start/finish visible', active: 0 },
  { metric_code: 'sprint_60', label: '60-Yard Sprint', category: 'athleticism', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 's', decimals: 2, method: 'frame_timed', publishes_to: ['dash_60'], capture_requirements: 'Pro Day sprint lane; start/finish visible', active: 0 },
  { metric_code: 'sprint_speed', label: 'Sprint Speed (derived)', category: 'athleticism', availability_tier: 'A', recipe_version: 'CMD_V1', unit: 'ft/s', decimals: 1, method: 'frame_timed', publishes_to: ['sprint_speed'], dependencies: ['sprint_30', 'sprint_60'], capture_requirements: 'Valid sprint time', active: 0 },
];

// ── Packages (PRD §2.1) ──────────────────────────────────────────────────
export const PACKAGES = {
  rookie: {
    label: 'Rookie',
    metric_codes: ['pitch_velocity_radar', 'home_to_first', 'steal_time', 'ninety_ft_speed'],
  },
  rookie_plus: {
    label: 'Rookie + add-ons',
    metric_codes: ['pitch_velocity_radar', 'home_to_first', 'steal_time', 'ninety_ft_speed'],
    allows_addons: true,
  },
  pro: {
    label: 'Pro',
    metric_codes: REGISTRY_SEED.filter(r => r.metric_code !== 'ninety_ft_speed').map(r => r.metric_code),
  },
  custom: { label: 'Custom order', metric_codes: [], allows_addons: true },
};

// Resolve the requirement set for an order. Add-ons only apply to packages
// that allow them; unknown or inactive (unshipped-module) codes are rejected
// rather than silently dropped — sales cannot order unsupported combinations.
export function buildRequirements({ packageKey, addonCodes = [], registry }) {
  const pkg = PACKAGES[packageKey];
  if (!pkg) throw new Error(`Unknown package: ${packageKey}`);
  const byCode = new Map(registry.map(r => [r.metric_code, r]));
  const codes = new Set(pkg.metric_codes);
  if (addonCodes.length && !pkg.allows_addons) {
    throw new Error(`Package ${packageKey} does not accept add-ons`);
  }
  for (const code of addonCodes) codes.add(code);
  const requirements = [];
  for (const code of codes) {
    const row = byCode.get(code);
    if (!row) throw new Error(`Unknown metric code: ${code}`);
    if (!row.active) throw new Error(`Metric not yet available to order: ${code}`);
    requirements.push({
      metric_code: code,
      priority: row.category === 'rookie' ? 10 : 100,
      capture_requirement: row.capture_requirements,
      enabled: 1,
    });
  }
  if (requirements.length === 0) throw new Error('Order has no metric requirements');
  return requirements.sort((a, b) => a.priority - b.priority || a.metric_code.localeCompare(b.metric_code));
}

// ── Status machines (two-release model) ──────────────────────────────────
export const METRIC_RELEASE_STATES = ['not_started', 'in_progress', 'ready_for_review', 'needs_correction', 'approved', 'released'];
export const GAME_RECORD_STATES = ['pending', 'in_progress', 'validated', 'released', 'not_ordered'];

const METRIC_TRANSITIONS = {
  not_started: ['in_progress'],
  in_progress: ['ready_for_review'],
  ready_for_review: ['needs_correction', 'approved'],
  needs_correction: ['in_progress', 'ready_for_review'],
  approved: ['released', 'needs_correction'],
  released: ['needs_correction'],          // corrections reopen with history retained
};
const RECORD_TRANSITIONS = {
  pending: ['in_progress', 'not_ordered'],
  in_progress: ['validated'],
  validated: ['released', 'in_progress'],
  released: ['in_progress'],
  not_ordered: ['pending'],
};

export function canTransition(kind, from, to) {
  const table = kind === 'metric_release' ? METRIC_TRANSITIONS : RECORD_TRANSITIONS;
  return (table[from] || []).includes(to);
}

// Reviewer-only gates: approval and release require reviewer or admin.
export function roleCanTransition(role, kind, to) {
  if (kind === 'metric_release' && ['approved', 'released'].includes(to)) {
    return role === 'admin' || role === 'reviewer';
  }
  if (kind === 'game_record' && ['validated', 'released'].includes(to)) {
    return role === 'admin' || role === 'reviewer';
  }
  return ['admin', 'analyst', 'reviewer'].includes(role);
}

export const CAPTURE_PROFILE_SEED = [
  { key: 'behind_home_1080p60', label: 'Behind Home 1080p/60', expected_metrics: ['pitch_velocity_radar', 'home_to_first', 'steal_time', 'spray_direction', 'strike_pct', 'whiff_pct'], notes: 'Standard game capture position.' },
  { key: 'first_base_line_4k120', label: '1B Line 4K/120', expected_metrics: ['exit_velocity_video', 'launch_angle_video', 'pitch_velocity_video', 'time_to_home'], notes: 'High-FPS side angle for advanced measurement.' },
  { key: 'pro_day_sprint_lane', label: 'Pro Day sprint lane', expected_metrics: ['sprint_30', 'sprint_60', 'sprint_speed', 'reaction_time'], notes: 'Controlled session lane with fixed start/finish markers.' },
];
