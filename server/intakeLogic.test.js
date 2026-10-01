// Customer footage intake — pure logic (normalization, status model, the
// customer-facing capture language, consent hashing, submit readiness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail, normalizePhone, normalizeName, isValidEmail, newPublicId, isoDate, addDays,
  queueStage, customerStatus, captureIssues, submissionCaptureNotes, plainReason,
  rightsTerms, policyHash, submitReadiness, retentionDays, INTAKE_PACKAGES, OWNERSHIP_RELATIONSHIPS,
} from './intakeLogic.js';

test('contact details normalize for duplicate detection only', () => {
  assert.equal(normalizeEmail('  Pat.Parent@Example.COM '), 'pat.parent@example.com');
  assert.equal(normalizePhone('(801) 555-0134'), '18015550134', '10 digits read as North American');
  assert.equal(normalizePhone('+1 801 555 0134'), '18015550134');
  assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958');
  assert.equal(normalizePhone('555'), '', 'too short to be a number');
  assert.equal(normalizeName('  José  O’Neil-Smith '), 'jose oneilsmith');
  assert.ok(isValidEmail('a@b.co'));
  assert.ok(!isValidEmail('a@b'));
});

test('public submission ids are readable aloud and never ambiguous', () => {
  for (let i = 0; i < 200; i++) {
    const id = newPublicId();
    assert.match(id, /^DM-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    assert.ok(!/[01OILU]/.test(id.slice(3)), id);
  }
});

test('dates are strict ISO calendar dates', () => {
  assert.equal(isoDate('2026-09-27'), '2026-09-27');
  assert.equal(isoDate('2026-02-30'), null);
  assert.equal(isoDate('9/27/2026'), null);
  assert.equal(addDays('2026-01-31 10:00:00', 1), '2026-02-01 10:00:00');
});

test('retention defaults to 180 days and only accepts a sane override', () => {
  assert.equal(retentionDays({}), 180);
  assert.equal(retentionDays({ DM_INTAKE_RETENTION_DAYS: '90' }), 90);
  assert.equal(retentionDays({ DM_INTAKE_RETENTION_DAYS: '3' }), 180, 'below the floor falls back');
});

test('queue stage: intake stages are stored, fulfillment stages are derived from the job', () => {
  const sub = (status, job_id = null) => ({ status, job_id });
  assert.equal(queueStage(sub('draft')), 'draft');
  assert.equal(queueStage(sub('needs_identity_review')), 'needs_identity_review');
  assert.equal(queueStage(sub('declined')), 'closed');
  const job = (m, g) => ({ metric_release_status: m, game_record_status: g });
  assert.equal(queueStage(sub('linked', 1), job('in_progress', 'pending')), 'in_analysis');
  assert.equal(queueStage(sub('linked', 1), job('released', 'pending')), 'metrics_released');
  assert.equal(queueStage(sub('linked', 1), job('released', 'in_progress')), 'game_record_pending');
  assert.equal(queueStage(sub('linked', 1), job('released', 'released')), 'complete');
  assert.equal(queueStage(sub('linked', 1), job('released', 'not_ordered')), 'complete');
  assert.equal(queueStage(sub('linked', 1), job('needs_correction', 'released')), 'in_analysis', 'a reopened release is back in analysis');
  assert.equal(queueStage(sub('needs_customer_action', 1), job('released', 'pending')), 'needs_customer_action', 'an open customer request wins');
});

test('customer status never exposes identity review, and separates metrics from the game record', () => {
  const files = [{ kind: 'video', status: 'ready' }];
  assert.equal(customerStatus({ sub: { status: 'needs_identity_review' }, files }).key, 'received');
  assert.equal(customerStatus({ sub: { status: 'new' }, files: [{ kind: 'video', status: 'processing' }] }).key, 'processing');
  assert.equal(customerStatus({ sub: { status: 'new' }, files: [{ kind: 'video', status: 'needs_customer_action' }] }).key, 'action_required');
  const linked = { status: 'linked', job_id: 1 };
  const m = customerStatus({ sub: linked, job: { metric_release_status: 'released', game_record_status: 'in_progress' }, files });
  assert.equal(m.key, 'metrics_ready');
  assert.equal(m.game_record, 'in_progress');
  assert.match(m.detail, /full game record is still in progress/);
  assert.equal(customerStatus({ sub: linked, job: { metric_release_status: 'approved', game_record_status: 'pending' }, files }).key, 'analysis');
  assert.equal(customerStatus({ sub: linked, job: { metric_release_status: 'released', game_record_status: 'released' }, files }).key, 'complete');
  assert.equal(customerStatus({ sub: { status: 'declined', customer_message: 'Out of our service area' }, files }).detail, 'Out of our service area');
});

test('capture findings: plain language, never a rejection for quality alone', () => {
  const ok = captureIssues({ width: 1920, height: 1080, duration_s: 7000, effective_fps: 59.94, camera_view: 'behind_home' });
  assert.deepEqual(ok, []);
  const weak = captureIssues({ width: 1280, height: 720, duration_s: 7000, effective_fps: 29.97, camera_view: 'behind_home' });
  assert.deepEqual(weak.map(i => i.code), ['resolution_below_minimum', 'frame_rate_below_preferred']);
  assert.ok(weak.every(i => i.severity !== 'action'), 'a 720p file is accepted; affected metrics become unavailable later');
  const slow = captureIssues({ width: 1920, height: 1080, duration_s: 7000, effective_fps: 24, camera_view: 'behind_home' });
  assert.ok(slow.some(i => i.code === 'frame_rate_below_minimum'));
  const portrait = captureIssues({ width: 1920, height: 1080, rotation: 90, duration_s: 7000, effective_fps: 60, camera_view: 'behind_home' });
  assert.ok(portrait.some(i => i.code === 'portrait'), 'rotation metadata makes a 1920×1080 phone file portrait');
  const broken = captureIssues({ width: null, height: null, duration_s: null });
  assert.equal(broken[0].severity, 'action');
  const proSide = captureIssues({ width: 3840, height: 2160, duration_s: 7000, effective_fps: 59.94, camera_view: 'side_first_base' }, { packageKey: 'pro' });
  assert.ok(proSide.some(i => i.code === 'side_frame_rate_below_preferred'));
  const clip = captureIssues({ width: 1920, height: 1080, duration_s: 300, effective_fps: 60, camera_view: 'behind_home' }, { fullGame: true });
  assert.ok(clip.some(i => i.code === 'short_for_full_game'));
  for (const i of [...weak, ...slow, ...portrait, ...broken, ...proSide, ...clip]) {
    assert.doesNotMatch(i.text, /vfr|codec|ffprobe|diagnos/i, 'internal detail stays internal');
  }
});

test('submission-level notes: Pro without a side angle, no primary view', () => {
  const v = (camera_view) => ({ kind: 'video', status: 'ready', camera_view });
  assert.deepEqual(submissionCaptureNotes({ packageKey: 'pro', files: [v('behind_home')] }).map(n => n.code), ['pro_without_side_angle']);
  assert.deepEqual(submissionCaptureNotes({ packageKey: 'pro', files: [v('behind_home'), v('side_third_base')] }), []);
  assert.deepEqual(submissionCaptureNotes({ packageKey: 'rookie', files: [v('side_first_base')] }).map(n => n.code), ['no_primary_view']);
});

test('unavailable reasons have customer wording; unknown codes get a safe default', () => {
  assert.match(plainReason('insufficient_capture_quality'), /video quality/);
  assert.match(plainReason('missing_radar'), /radar/);
  assert.match(plainReason('something_new'), /could not verify/);
});

test('rights terms depend on the role, and the hash pins the exact wording', () => {
  const parent = rightsTerms({ role: 'parent', retention: 180 });
  const coach = rightsTerms({ role: 'coach', retention: 180 });
  assert.match(parent.attestation, /parent of each minor athlete/);
  assert.match(coach.attestation, /does not give me ownership/);
  assert.notEqual(policyHash(parent), policyHash(coach));
  assert.equal(policyHash(parent), policyHash(rightsTerms({ role: 'parent', retention: 180 })), 'same text, same hash');
  assert.notEqual(policyHash(parent), policyHash(rightsTerms({ role: 'parent', retention: 90 })), 'retention is part of what was accepted');
  assert.ok(parent.pending_legal, 'draft wording is flagged until legal approves it');
  assert.throws(() => rightsTerms({ role: '' }), /role/);
});

test('ownership is only ever a family relationship', () => {
  assert.deepEqual(OWNERSHIP_RELATIONSHIPS.sort(), ['guardian', 'invite_claim', 'parent', 'self']);
});

test('Hall of Fame is never a self-serve upload; Pro carries an honest note', () => {
  assert.equal(INTAKE_PACKAGES.hall_of_fame.self_serve, false);
  assert.equal(INTAKE_PACKAGES.pro.command_package, 'rookie');
  assert.match(INTAKE_PACKAGES.pro.customer_note, /Rookie foundation/);
});

test('submit readiness lists every missing piece in plain language', () => {
  const base = {
    sub: { submitter_role: 'parent', package_key: 'rookie', kind: 'footage', game_date: '2026-09-20', team_label: 'Canyon', event_label: 'Fall Classic', level: '12U', footage_context: JSON.stringify({ coverage: 'full' }) },
    account: { email_verified_at: '2026-09-20 10:00:00' },
    athletes: [{ first_name: 'Rae', last_name: 'Runner', birth_year: 2014, relationship: 'parent' }],
    files: [{ kind: 'video', status: 'ready', camera_view: 'behind_home' }],
    rights: { action: 'grant' },
  };
  assert.deepEqual(submitReadiness(base), []);
  const codes = r => submitReadiness(r).map(m => m.code);
  assert.deepEqual(codes({ ...base, account: {} }), ['email_unverified']);
  assert.deepEqual(codes({ ...base, rights: null }), ['rights']);
  assert.deepEqual(codes({ ...base, files: [{ kind: 'video', status: 'paused', camera_view: 'behind_home' }] }), ['uploads']);
  assert.deepEqual(codes({ ...base, athletes: [{ first_name: 'Rae', last_name: '', relationship: 'parent' }] }), ['athlete_0_name', 'athlete_0_age']);
  assert.deepEqual(codes({ ...base, sub: { ...base.sub, event_label: '', footage_context: '{"coverage":"full","no_event":true}' } }), [], 'a regular-season game needs no event');
  // A coach may attach a roster instead of naming athletes.
  const coach = { ...base, sub: { ...base.sub, submitter_role: 'coach' }, athletes: [] };
  assert.deepEqual(codes(coach), ['athlete']);
  assert.deepEqual(codes({ ...coach, files: [...base.files, { kind: 'roster', status: 'ready' }] }), []);
  // Hall of Fame is an inquiry: no game, files or terms needed to submit.
  assert.deepEqual(codes({ ...base, sub: { submitter_role: 'parent', package_key: 'hall_of_fame', kind: 'inquiry' }, files: [], rights: null }), []);
});
