// TDR §5a release-mapping contract: every reading kept upstream, only
// approved rollups publish, unavailable never becomes zero or a denominator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { velocityRollup, timingRollup, rollupForMetricCode, RELEASE_VERSION } from './metricRelease.js';

const ok = v => ({ value: v, status: 'approved' });
const unavailable = reason => ({ value: null, status: 'unavailable', unavailable_reason: reason });

test('velocity rollup: min/max/avg/count from valid readings only', () => {
  const r = velocityRollup([ok(72.4), ok(75.1), ok(70.2), unavailable('radar_unmatched'), { value: 68, status: 'draft' }],
    { maxKey: 'max_velo', avgKey: 'avg_velo' });
  assert.equal(r.released, true);
  assert.deepEqual(r.entries, [
    { metric_key: 'max_velo', value: 75.1 },
    { metric_key: 'avg_velo', value: 72.6 },
  ]);
  assert.equal(r.sample.valid_readings, 3);
  assert.equal(r.sample.min, 70.2);
  assert.equal(r.sample.unavailable, 1, 'unavailable counted, never averaged');
});

test('timing rollup: best publishes, average + attempts ride as sample', () => {
  const r = timingRollup([ok(4.42), ok(4.31), ok(4.55), unavailable('base_not_visible')], { key: 'home_to_first' });
  assert.deepEqual(r.entries, [{ metric_key: 'home_to_first', value: 4.31 }]);
  assert.equal(r.sample.attempts, 3);
  assert.equal(r.sample.average, 4.43);
  assert.equal(r.sample.unavailable, 1);
});

test('all-unavailable publishes nothing — absence, never zero', () => {
  const r = rollupForMetricCode('steal_time', [unavailable('runner_or_ball_obscured'), unavailable('camera_stopped')]);
  assert.equal(r.released, false);
  assert.deepEqual(r.entries, []);
  assert.equal(r.sample.attempts, 0);
  assert.equal(r.sample.unavailable, 2);
});

test('dispatch covers the Rookie codes and versions the contract', () => {
  assert.equal(RELEASE_VERSION, 'DM_RELEASE_V1');
  assert.ok(rollupForMetricCode('pitch_velocity_radar', [ok(70)]).entries.length === 2);
  assert.ok(rollupForMetricCode('home_to_first', [ok(4.5)]).entries.length === 1);
  assert.equal(rollupForMetricCode('launch_angle_video', [ok(12)]), null, 'unmapped modules refuse to publish');
});
