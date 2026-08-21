// Metric-release mapping (TDR §5a): atomic Command records → approved display
// rollups for the existing stat_entries path. Pure and versioned; the M5
// release adapter consumes these. metric_results keep every reading/attempt;
// only rollups publish. Unavailable stays unavailable — never zero, never in
// a denominator.
export const RELEASE_VERSION = 'DM_RELEASE_V1';

const round = (v, dp) => (v == null ? null : Number(v.toFixed(dp)));

// results: [{ value, status, unavailable_reason }] — status 'approved' means
// releasable; anything else (draft, unavailable, invalid) never rolls up.
function validValues(results) {
  return results.filter(r => r.status === 'approved' && r.value != null).map(r => Number(r.value));
}

// Radar velocity (pitch or exit): min/max/average over valid readings + count.
export function velocityRollup(results, { maxKey, avgKey, decimals = 1 }) {
  const values = validValues(results);
  const unavailable = results.filter(r => r.status === 'unavailable');
  if (values.length === 0) {
    return { entries: [], sample: { valid_readings: 0, unavailable: unavailable.length }, released: false };
  }
  return {
    entries: [
      { metric_key: maxKey, value: round(Math.max(...values), decimals) },
      { metric_key: avgKey, value: round(values.reduce((a, b) => a + b, 0) / values.length, decimals) },
    ],
    sample: {
      valid_readings: values.length,
      min: round(Math.min(...values), decimals),
      max: round(Math.max(...values), decimals),
      average: round(values.reduce((a, b) => a + b, 0) / values.length, decimals),
      unavailable: unavailable.length,
    },
    released: true,
  };
}

// Timed attempts (home-to-first, steal): best (min) publishes; average and
// attempt count ride as sample metadata. Failed steal attempts still time.
export function timingRollup(results, { key, decimals = 2 }) {
  const values = validValues(results);
  const unavailable = results.filter(r => r.status === 'unavailable');
  if (values.length === 0) {
    return { entries: [], sample: { attempts: 0, unavailable: unavailable.length }, released: false };
  }
  return {
    entries: [{ metric_key: key, value: round(Math.min(...values), decimals) }],
    sample: {
      attempts: values.length,
      best: round(Math.min(...values), decimals),
      average: round(values.reduce((a, b) => a + b, 0) / values.length, decimals),
      unavailable: unavailable.length,
    },
    released: true,
  };
}

// Registry-code dispatch used by the release adapter.
export function rollupForMetricCode(metricCode, results) {
  switch (metricCode) {
    case 'pitch_velocity_radar':
      return velocityRollup(results, { maxKey: 'max_velo', avgKey: 'avg_velo' });
    case 'exit_velocity_radar':
      return velocityRollup(results, { maxKey: 'max_exit_velo', avgKey: 'avg_exit_velo' });
    case 'home_to_first':
      return timingRollup(results, { key: 'home_to_first' });
    case 'steal_time':
      return timingRollup(results, { key: 'steal_time' });
    default:
      return null;   // metric has no Phase 1 rollup mapping
  }
}
