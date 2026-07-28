// Age-group benchmark thresholds for the Pro Day rating engine.
//
// Source of truth: "Diamond Metrics Player Profile Requirements (V1)" §4.
// 14U–17U values are Perfect Game, "FAQ Showcase Questions: Part 3"
// (2024 PG showcase circuit): https://www.perfectgame.org/Articles/View.aspx?article=18181
// 13U values are Diamond Metrics provisional estimates (PG publishes no
// compatible 13U table) and must not be represented as official PG numbers.
// Values are entered verbatim from the requirements document — do not
// substitute researched numbers.

export const PG_VERSION = 'PG_2024_V1';
export const DM13U_VERSION = 'DM_13U_PROVISIONAL_V1';
export const CALCULATION_VERSION = 'DM_RATING_V1';
export const RATING_LABEL = 'Provisional Pro Day Rating';
export const BENCHMARK_SOURCE = 'Perfect Game 2024 showcase circuit (FAQ Showcase Questions: Part 3)';

// Threshold shape: { avg, plus, elite, lowerIsBetter? }
// Rating anchors (§3): Average = 60, Plus = 80, Elite = 90.
export const BENCHMARKS = {
  '13U': {
    version: DM13U_VERSION,
    provisional: true,
    dash_60:       { avg: 7.90, plus: 7.30, elite: 7.05, lowerIsBetter: true },
    max_velo:      { avg: 69, plus: 78, elite: 80 },
    max_exit_velo: { avg: 72, plus: 80, elite: 81 },
    arm_INF:       { avg: 71, plus: 78, elite: 81 },
    arm_OF:        { avg: 73, plus: 80, elite: 83 },
    arm_1B:        { avg: 69, plus: 77, elite: 79 },
    arm_C:         { avg: 66, plus: 71, elite: 73 },
    pop_time:      { avg: 2.28, plus: 2.07, elite: 2.03, lowerIsBetter: true },
  },
  '14U': {
    version: PG_VERSION,
    provisional: false,
    dash_60:       { avg: 7.71, plus: 7.20, elite: 7.00, lowerIsBetter: true },
    max_velo:      { avg: 72, plus: 80, elite: 83 },
    max_exit_velo: { avg: 75, plus: 82, elite: 84 },
    arm_INF:       { avg: 72, plus: 80, elite: 83 },
    arm_OF:        { avg: 75, plus: 82, elite: 85 },
    arm_1B:        { avg: 71, plus: 78, elite: 80 },
    arm_C:         { avg: 68, plus: 73, elite: 75 },
    pop_time:      { avg: 2.20, plus: 2.03, elite: 1.98, lowerIsBetter: true },
  },
  '15U': {
    version: PG_VERSION,
    provisional: false,
    dash_60:       { avg: 7.52, plus: 7.10, elite: 6.95, lowerIsBetter: true },
    max_velo:      { avg: 76, plus: 81, elite: 85 },
    max_exit_velo: { avg: 78, plus: 83, elite: 86 },
    arm_INF:       { avg: 76, plus: 83, elite: 85 },
    arm_OF:        { avg: 77, plus: 84, elite: 87 },
    arm_1B:        { avg: 74, plus: 79, elite: 82 },
    arm_C:         { avg: 71, plus: 76, elite: 79 },
    pop_time:      { avg: 2.12, plus: 1.96, elite: 1.91, lowerIsBetter: true },
  },
  '16U': {
    version: PG_VERSION,
    provisional: false,
    dash_60:       { avg: 7.50, plus: 7.13, elite: 6.91, lowerIsBetter: true },
    max_velo:      { avg: 79, plus: 86, elite: 89 },
    max_exit_velo: { avg: 81, plus: 85, elite: 90 },
    arm_INF:       { avg: 77, plus: 84, elite: 86 },
    arm_OF:        { avg: 79, plus: 87, elite: 89 },
    arm_1B:        { avg: 74, plus: 80, elite: 83 },
    arm_C:         { avg: 73, plus: 78, elite: 80 },
    pop_time:      { avg: 2.16, plus: 1.94, elite: 1.89, lowerIsBetter: true },
  },
  '17U': {
    version: PG_VERSION,
    provisional: false,
    dash_60:       { avg: 7.26, plus: 6.80, elite: 6.65, lowerIsBetter: true },
    max_velo:      { avg: 82, plus: 88, elite: 92 },
    max_exit_velo: { avg: 83, plus: 90, elite: 93 },
    arm_INF:       { avg: 78, plus: 86, elite: 88 },
    arm_OF:        { avg: 82, plus: 88, elite: 91 },
    arm_1B:        { avg: 76, plus: 82, elite: 84 },
    arm_C:         { avg: 75, plus: 79, elite: 82 },
    pop_time:      { avg: 2.01, plus: 1.90, elite: 1.84, lowerIsBetter: true },
  },
  // 18+ is event-relative until an external table is approved (§2).
  '18U': {
    version: 'EVENT_RELATIVE',
    provisional: true,
  },
};
