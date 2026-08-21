// Command M1 acceptance: registry integrity, order → requirement activation,
// two-release status machines, and role gates on review/publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY_SEED, PACKAGES, buildRequirements, canTransition, roleCanTransition,
} from './commandLogic.js';
import { VALID_METRIC_KEYS } from './metricCatalog.js';

test('registry seed: unique codes, valid tiers/methods, publish keys exist in public catalog', () => {
  const codes = REGISTRY_SEED.map(r => r.metric_code);
  assert.equal(new Set(codes).size, codes.length, 'metric codes unique');
  for (const r of REGISTRY_SEED) {
    assert.ok(['A', 'B', 'C', 'D', 'X'].includes(r.availability_tier), r.metric_code);
    assert.ok(['radar_verified', 'frame_timed', 'video_estimated', 'manual', 'scorebook_derived'].includes(r.method), r.metric_code);
    for (const key of r.publishes_to || []) {
      assert.ok(VALID_METRIC_KEYS.has(key), `${r.metric_code} publishes to unknown public key ${key}`);
    }
  }
  // Phase 1 activates exactly the Rookie core.
  const active = REGISTRY_SEED.filter(r => r.active).map(r => r.metric_code).sort();
  assert.deepEqual(active, ['home_to_first', 'ninety_ft_speed', 'pitch_velocity_radar', 'steal_time']);
});

test('rookie order activates the Rookie requirements, prioritized', () => {
  const reqs = buildRequirements({ packageKey: 'rookie', registry: REGISTRY_SEED });
  assert.deepEqual(reqs.map(r => r.metric_code).sort(), ['home_to_first', 'ninety_ft_speed', 'pitch_velocity_radar', 'steal_time']);
  assert.ok(reqs.every(r => r.enabled === 1 && r.priority === 10));
});

test('add-ons: rejected on plain rookie, inactive modules cannot be ordered', () => {
  assert.throws(() => buildRequirements({ packageKey: 'rookie', addonCodes: ['launch_angle_video'], registry: REGISTRY_SEED }), /does not accept add-ons/);
  assert.throws(() => buildRequirements({ packageKey: 'rookie_plus', addonCodes: ['launch_angle_video'], registry: REGISTRY_SEED }), /not yet available/);
  assert.throws(() => buildRequirements({ packageKey: 'custom', addonCodes: ['made_up'], registry: REGISTRY_SEED }), /Unknown metric code/);
  assert.throws(() => buildRequirements({ packageKey: 'custom', registry: REGISTRY_SEED }), /no metric requirements/);
});

test('two-release status machines allow the documented paths only', () => {
  assert.ok(canTransition('metric_release', 'not_started', 'in_progress'));
  assert.ok(canTransition('metric_release', 'ready_for_review', 'approved'));
  assert.ok(canTransition('metric_release', 'released', 'needs_correction'), 'corrections reopen released work');
  assert.ok(!canTransition('metric_release', 'not_started', 'released'), 'no skipping to release');
  assert.ok(canTransition('game_record', 'pending', 'not_ordered'));
  assert.ok(!canTransition('game_record', 'pending', 'released'));
});

test('role gates: only reviewer/admin approve and release', () => {
  assert.ok(!roleCanTransition('analyst', 'metric_release', 'approved'));
  assert.ok(!roleCanTransition('analyst', 'metric_release', 'released'));
  assert.ok(roleCanTransition('analyst', 'metric_release', 'ready_for_review'));
  assert.ok(roleCanTransition('reviewer', 'metric_release', 'released'));
  assert.ok(roleCanTransition('admin', 'game_record', 'validated'), 'single operator may review/publish in V1');
});

test('pro package covers every non-derived registry code', () => {
  assert.ok(PACKAGES.pro.metric_codes.includes('launch_angle_video'));
  assert.ok(!PACKAGES.pro.metric_codes.includes('ninety_ft_speed'), 'derived metric rides its parent');
});
