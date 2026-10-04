// Customer Footage Submission — developer acceptance tests (requirements §12),
// one block per scenario, in the document's order and words. Each block names
// the pass condition it proves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB = `/tmp/dm-intake-acc-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-intake-acc-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.DM_EMAIL_FROM;

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { hashPassword } = await import('./db.js');
const { localPathFor } = await import('./storage.js');
const { createAttempt, markUnavailable } = await import('./measurementLogic.js');
const { classifyReading } = await import('./radarImport.js');
const { decideResult, releaseMetrics } = await import('./releaseLogic.js');

let h, db, call, team, will, admin;

before(async () => {
  h = await startIntakeApp();
  ({ db, call } = h);
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Bingham')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug, age_group) VALUES (?, 'Bingham Miners', 'bingham-miners', '14U')").run(org).lastInsertRowid;
  will = h.internal('fulfillment', 'Will');
  admin = h.internal('admin', 'Admin');
  await call('PUT', '/api/command/intake-settings', { token: admin.token, body: { default_owner_id: will.id } });
});

after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// "New parent submits a game: Creates verified account, athlete candidate,
// consent record, submission, upload/feed records, and Will task; customer
// receives confirmation."
test('§12.1 New parent submits a game', async () => {
  const parent = await h.customer({ email: 'new.parent@example.com', first: 'Morgan', last: 'Lee' });
  const pid = await h.draft(parent.token, {
    athletes: [{ first_name: 'Jordan', last_name: 'Lee', birth_year: 2012, relationship: 'parent', team_label: 'Bingham Miners' }],
    game: { team_label: 'Bingham Miners', level: '14U' },
  });
  const up = await h.upload(parent.token, pid, { bytes: Buffer.from('a full game, recorded behind home') });
  await h.probe(up.registered.file.id);
  const done = await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  assert.equal(done.status, 200);

  const account = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(parent.id);
  assert.ok(account.email_verified_at, 'verified account');
  const sub = h.sub(pid);
  const athlete = db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ?').get(sub.id);
  assert.equal(`${athlete.first_name} ${athlete.last_name}`, 'Jordan Lee', 'athlete candidate');
  assert.equal(athlete.player_id, null, '…a candidate, not a player record');
  const rights = db.prepare('SELECT * FROM intake_rights WHERE submission_id = ?').get(sub.id);
  assert.equal(rights.action, 'grant', 'consent record');
  assert.ok(rights.policy_version && rights.policy_hash && rights.attestation, 'versioned, with the exact wording pinned');
  assert.match(sub.public_id, /^DM-/, 'submission with a public number');
  const file = db.prepare('SELECT * FROM intake_files WHERE submission_id = ?').get(sub.id);
  for (const k of ['account_id', 'original_name', 'size_bytes', 'content_hash', 'storage_key', 'camera_view', 'rights_id', 'retention_deadline', 'status']) {
    assert.ok(file[k] != null && file[k] !== '', `file record carries ${k}`);
  }
  assert.equal(sub.owner_id, will.id, 'Will task: owner');
  assert.ok(sub.next_action && sub.due_at, 'Will task: next action and service target');
  assert.ok(db.prepare("SELECT 1 FROM intake_events WHERE submission_id = ? AND event_type = 'task_created'").get(sub.id));
  // Confirmation: a submission number and the next step, no promised date.
  assert.equal(done.body.submission.public_id, pid);
  const receipt = db.prepare("SELECT * FROM intake_notifications WHERE submission_id = ? AND event_key = 'submission_received'").get(sub.id);
  assert.ok(receipt, 'confirmation recorded (emailed once the provider is live)');
  const shown = done.body.submission.timeline.find(e => e.type === 'submitted');
  assert.match(shown.message, new RegExp(pid));
  assert.doesNotMatch(JSON.stringify(done.body.submission.status), /\bwithin\b|\bdays?\b|\bhours?\b/i, 'no unapproved turnaround promise');
});

// "Existing coach submits footage: Finds/links account and team context; staff
// sees existing history; duplicate game/job suggestion appears."
test('§12.2 Existing coach submits footage', async () => {
  const staffId = db.prepare('INSERT INTO staff_users (email, name, password_hash) VALUES (?, ?, ?)').run('coach.ray@example.com', 'Ray Coach', hashPassword('coach-password')).lastInsertRowid;
  const coachToken = h.principals.createStaffSession(staffId);
  // An earlier submission from this coach already became a job for the team.
  const first = await h.draft(coachToken, { role: 'coach', athletes: [], game: { team_label: 'Bingham Miners', date: '2026-09-13' } });
  await h.upload(coachToken, first, { kind: 'roster', name: 'roster.csv', bytes: Buffer.from('name\nJordan Lee\n') });
  await h.upload(coachToken, first, { bytes: Buffer.from('earlier game') });
  const accountId = db.prepare('SELECT id FROM customer_accounts WHERE email = ?').get('coach.ray@example.com').id;
  db.prepare("UPDATE customer_accounts SET email_verified_at = datetime('now') WHERE id = ?").run(accountId);
  assert.equal((await call('POST', `/api/intake/submissions/${first}/submit`, { token: coachToken })).status, 200);
  const firstId = h.sub(first).id;
  assert.equal((await call('POST', `/api/command/intake/${firstId}/create-job`, { token: will.token, body: { team_id: team } })).status, 201);
  // A separately created job for this weekend's game already exists.
  const existingJob = (await call('POST', '/api/command/jobs', { token: admin.token, body: { team_id: team, game_date: '2026-09-27', opponent_label: 'Herriman', package_key: 'rookie', media_consent: true } })).body.job.id;

  // Finds/links the account and team context: one contact, the coach's team offered.
  const me = (await call('GET', '/api/customer/me', { token: coachToken })).body;
  assert.equal(me.account.via, 'staff');
  assert.deepEqual(me.teams.map(t => t.team_id), [team]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_accounts WHERE email = ?').get('coach.ray@example.com').n, 1);
  const second = await h.draft(coachToken, { role: 'coach', athletes: [{ first_name: 'Jordan', last_name: 'Lee', relationship: 'coach', age_band: '14U' }], game: { team_id: team, team_label: 'Bingham Miners', date: '2026-09-27', opponent_label: 'Herriman' } });
  await h.upload(coachToken, second, { bytes: Buffer.from('this weekend') });
  await call('POST', `/api/intake/submissions/${second}/submit`, { token: coachToken });
  assert.equal(h.sub(second).team_id, team, 'the verified team link is kept');

  // Staff see existing history and the duplicate game/job suggestion.
  const rec = (await call('GET', `/api/command/intake/${h.sub(second).id}`, { token: will.token })).body;
  assert.ok(rec.prior_submissions.some(p => p.public_id === first), 'existing history');
  assert.ok(rec.account.linked_logins.staff, 'linked to the coach login');
  assert.ok(rec.contact_duplicates.some(d => d.kind === 'staff_user'));
  const suggestion = rec.game.job_candidates.find(j => j.id === existingJob);
  assert.ok(suggestion, 'the existing job is suggested before a new one is created');
  assert.ok(suggestion.reasons.includes('same team') && suggestion.reasons.includes('same date') && suggestion.reasons.includes('same opponent'));
});

// "Interrupted large upload: Customer resumes same file without reuploading
// completed parts; final file attaches exactly once."
test('§12.3 Interrupted large upload', async () => {
  const parent = await h.customer();
  const pid = await h.draft(parent.token);
  const bytes = Buffer.from('0123456789'.repeat(10));   // ten 10-byte parts
  const interrupted = await h.upload(parent.token, pid, { bytes, partSize: 10, stopAfterPart: 6 });
  assert.equal(interrupted.sent, 6);
  const resumed = await h.upload(parent.token, pid, { bytes, partSize: 10 });
  assert.equal(resumed.registered.resumed, true);
  assert.equal(resumed.sent, 4, 'only the four missing parts are sent');
  assert.equal(resumed.registered.file.id, interrupted.body.file.id);
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(resumed.registered.file.id);
  assert.deepEqual(fs.readFileSync(localPathFor(file.storage_key)), bytes, 'assembled byte-for-byte');
  await h.probe(file.id);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'guest' } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM intake_files WHERE submission_id = ? AND status != 'deleted'").get(id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_video_feeds WHERE job_id = ?').get(jobId).n, 1, 'attaches exactly once');
});

// "Ambiguous athlete: No profile is auto-linked or made public; submission
// appears in Needs identity review with candidate list."
test('§12.4 Ambiguous athlete', async () => {
  const twins = ['2012-03-03', '2012-11-11'].map((dob, i) => db.prepare(
    "INSERT INTO players (first_name, last_name, slug, date_of_birth, is_public) VALUES ('Casey', 'Morgan', ?, ?, 0)"
  ).run(`casey-morgan-${i}`, dob).lastInsertRowid);
  for (const p of twins) db.prepare("INSERT INTO roster_memberships (team_id, player_id, start_date, end_date) VALUES (?, ?, '2026-01-01', '2026-12-31')").run(team, p);
  const parent = await h.customer();
  const pid = await h.draft(parent.token, { athletes: [{ first_name: 'Casey', last_name: 'Morgan', age_band: '14U', relationship: 'parent' }] });
  const up = await h.upload(parent.token, pid);
  await h.probe(up.registered.file.id);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const sub = h.sub(pid);
  assert.equal(sub.status, 'needs_identity_review');
  const queue = (await call('GET', '/api/command/intake?stage=needs_identity_review', { token: will.token })).body;
  assert.ok(queue.rows.some(r => r.public_id === pid), 'appears in Needs identity review');
  const rec = (await call('GET', `/api/command/intake/${sub.id}`, { token: will.token })).body;
  assert.equal(rec.athletes[0].ambiguous, true);
  assert.deepEqual(rec.athletes[0].candidates.map(c => c.player_id).sort(), twins.sort(), 'with the candidate list');
  assert.ok(rec.athletes[0].candidates.every(c => c.confidence && c.reasons.length), 'each with confidence and reasons');
  assert.equal(db.prepare('SELECT player_id FROM intake_athletes WHERE submission_id = ?').get(sub.id).player_id, null, 'nothing auto-linked');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_athletes WHERE account_id = ?').get(parent.id).n, 0);
  assert.ok(twins.every(p => db.prepare('SELECT is_public FROM players WHERE id = ?').get(p).is_public === 0), 'nothing made public');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM players WHERE first_name = 'Casey' AND last_name = 'Morgan'").get().n, 2, 'no new record created');
  const blocked = await call('POST', `/api/command/intake/${sub.id}/create-job`, { token: will.token, body: { team_id: team } });
  assert.equal(blocked.status, 409, 'no job until identity is resolved');
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: parent.token })).body.submission;
  assert.equal(view.status.key, 'received', 'the customer sees "received", never identity review');
  assert.ok(!JSON.stringify(view).includes('casey-morgan'), 'and never another family’s records');
});

// "Insufficient capture: Feed records technical QA; analyst marks only affected
// metrics unavailable with reason; customer sees understandable result."
test('§12.5 Insufficient capture', async () => {
  const pitcher = db.prepare("INSERT INTO players (first_name, last_name, slug, is_public) VALUES ('Taylor', 'Arm', 'taylor-arm', 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, start_date, end_date) VALUES (?, ?, '2026-01-01', '2026-12-31')").run(team, pitcher);
  const parent = await h.customer();
  const pid = await h.draft(parent.token, { athletes: [{ first_name: 'Taylor', last_name: 'Arm', birth_year: 2012, relationship: 'parent' }] });
  const up = await h.upload(parent.token, pid);
  await h.probe(up.registered.file.id, { width: 1280, height: 720, duration_s: 7000, effective_fps: 29.97, nominal_fps: 29.97, codec: 'h264', rotation: 0, vfr: 0 });
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(up.registered.file.id);
  assert.equal(file.status, 'ready', 'the file is accepted');
  assert.ok(JSON.parse(file.issues).some(i => i.code === 'resolution_below_minimum'), 'technical QA recorded');
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: pitcher } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  const feedId = db.prepare('SELECT feed_id FROM intake_files WHERE id = ?').get(file.id).feed_id;

  // The analyst: radar velocity is fine; the 720p home-to-first is not.
  const reading = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 66.4, 'unmatched', ?)").run(jobId, admin.id).lastInsertRowid;
  classifyReading(db, reading, { player_id: pitcher, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, admin.id);
  const attempt = createAttempt(db, jobId, { attempt_type: 'home_to_first', player_id: pitcher, feed_id: feedId }, admin.id);
  markUnavailable(db, attempt.id, { reason: 'insufficient_capture_quality', note: '720p — first-base touch not legible' }, admin.id);
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id = ? AND status = 'draft'").all(jobId)) decideResult(db, r.id, { decision: 'approved' }, admin.id);
  releaseMetrics(db, jobId, admin.id);
  db.prepare("UPDATE cmd_jobs SET metric_release_status = 'released' WHERE id = ?").run(jobId);

  const results = (await call('GET', `/api/intake/submissions/${pid}`, { token: parent.token })).body.submission.results.athletes[0].metrics;
  const velo = results.find(m => m.metric === 'Pitch Velocity — Radar');
  assert.equal(velo.available, true, 'only the affected metric is unavailable');
  assert.equal(velo.source, 'Radar verified');
  const h2f = results.find(m => m.metric === 'Home-to-First Time');
  assert.equal(h2f.available, false);
  assert.equal(h2f.reasons[0], 'The video quality was not sufficient for this measurement.', 'an understandable reason');
  assert.ok(!JSON.stringify(results).includes('legible'), 'not the analyst’s internal note');
  assert.equal(db.prepare(
    "SELECT COUNT(*) n FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND s.metric_key = 'home_to_first'"
  ).get(jobId).n, 0, 'never stored as zero, never in an average');
});

// "Metrics before scorebook: Metrics may release while game record remains in
// progress; customer portal clearly distinguishes the two states."
test('§12.6 Metrics before scorebook', async () => {
  const parent = await h.customer();
  const pid = await h.draft(parent.token);
  await h.upload(parent.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'guest' } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  const state = async () => (await call('GET', `/api/intake/submissions/${pid}`, { token: parent.token })).body.submission.status;

  db.prepare("UPDATE cmd_jobs SET metric_release_status = 'released', game_record_status = 'in_progress' WHERE id = ?").run(jobId);
  let s = await state();
  assert.equal(s.key, 'metrics_ready');
  assert.equal(s.game_record, 'in_progress');
  assert.match(s.detail, /metrics are ready.*full game record is still in progress/i, 'the two states are stated separately');
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(jobId);
  s = await state();
  assert.equal(s.key, 'complete');
  assert.equal(s.game_record, 'complete');
  // Staff see the same split.
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'validated' WHERE id = ?").run(jobId);
  assert.equal((await call('GET', '/api/command/intake', { token: will.token })).body.rows.find(r => r.public_id === pid).stage, 'game_record_pending');
});

// "Deletion/revocation request: Staff can locate linked account/submission/
// feed/Command records, execute approved policy action, and retain audit event."
test('§12.7 Deletion/revocation request', async () => {
  const kid = db.prepare("INSERT INTO players (first_name, last_name, slug, is_public) VALUES ('Avery', 'Quinn', 'avery-quinn', 1)").run().lastInsertRowid;
  const parent = await h.customer();
  const pid = await h.draft(parent.token, { athletes: [{ first_name: 'Avery', last_name: 'Quinn', birth_year: 2012, relationship: 'parent' }] });
  const up = await h.upload(parent.token, pid);
  await h.probe(up.registered.file.id);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: kid } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  const feedId = db.prepare('SELECT feed_id FROM intake_files WHERE id = ?').get(up.registered.file.id).feed_id;
  // The pipeline made a proxy from it.
  const proxyKey = `renditions/${feedId}/proxy.mp4`;
  fs.mkdirSync(path.dirname(localPathFor(proxyKey)), { recursive: true });
  fs.writeFileSync(localPathFor(proxyKey), 'proxy');
  db.prepare("INSERT INTO cmd_media_renditions (feed_id, kind, storage_key) VALUES (?, 'proxy', ?)").run(feedId, proxyKey);

  // The customer asks; staff locate everything linked.
  assert.equal((await call('POST', `/api/intake/submissions/${pid}/deletion-request`, { token: parent.token, body: { note: 'Please remove the video' } })).status, 201);
  const request = db.prepare("SELECT * FROM intake_deletion_requests WHERE scope = 'submission' AND target_id = ?").get(id);
  const found = (await call('GET', `/api/command/intake-deletions/${request.id}`, { token: will.token })).body.inventory;
  assert.equal(found.account.id, parent.id, 'linked account');
  assert.equal(found.submissions[0].public_id, pid, 'linked submission');
  assert.equal(found.files[0].id, up.registered.file.id, 'linked file');
  assert.deepEqual(found.feeds.map(f => f.id), [feedId], 'linked Command feed');
  assert.equal(found.renditions[0].storage_key, proxyKey, 'derived copies');
  assert.deepEqual(found.jobs.map(j => j.id), [jobId], 'linked Command job');
  assert.deepEqual(found.public_profiles.map(p => p.player_id), [kid], 'derived public visibility');
  assert.ok(found.retention_exceptions.length >= 1, 'retention exceptions are stated');

  // Execute the approved policy action (admin) and keep the audit.
  const done = await call('POST', `/api/command/intake-deletions/${request.id}/execute`, { token: admin.token, body: { actions: ['delete_media', 'revoke_consent', 'hide_profiles'], note: 'Approved per policy' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.request.status, 'completed');
  const fileKey = db.prepare('SELECT storage_key, status FROM intake_files WHERE id = ?').get(up.registered.file.id);
  assert.equal(fileKey.status, 'deleted');
  assert.ok(!fs.existsSync(localPathFor(fileKey.storage_key)) && !fs.existsSync(localPathFor(proxyKey)), 'the original and its copies are gone');
  assert.equal(db.prepare('SELECT status FROM cmd_video_feeds WHERE id = ?').get(feedId).status, 'deleted');
  assert.equal(db.prepare('SELECT is_public FROM players WHERE id = ?').get(kid).is_public, 0);
  assert.equal(db.prepare('SELECT action FROM intake_rights WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(id).action, 'revoke');
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table = 'cmd_jobs' AND target_id = ? AND action = 'media_deleted'").get(jobId), 'Command audit');
  assert.ok(db.prepare("SELECT 1 FROM intake_events WHERE submission_id = ? AND event_type = 'deletion_executed'").get(id), 'intake audit event retained');
  const stored = JSON.parse(db.prepare('SELECT inventory, result FROM intake_deletion_requests WHERE id = ?').get(request.id).result);
  assert.ok(stored.steps.length >= 4 && stored.steps.every(s => s.ok), 'each step and its outcome is recorded');
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: parent.token })).body.submission;
  assert.ok(view.timeline.some(e => e.message === 'Your deletion request has been completed.'));
});

