// Customer footage intake through the HTTP API: accounts, ownership, drafts,
// consent, uploads, submission, Will's queue, identity, the Command hand-off,
// roles, team management, notifications and deletion. The doc's own
// acceptance scenarios live in footageIntakeAcceptance.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-intake-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-intake-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.DM_EMAIL_FROM;

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { issueToken } = await import('./customerAuth.js');
const { jobRecipients } = await import('./notifications.js');
const { localPathFor } = await import('./storage.js');
const { hashPassword } = await import('./db.js');

let h, db, call;
let org, team, rae, sam1, sam2;

before(async () => {
  h = await startIntakeApp();
  ({ db, call } = h);
  org = db.prepare("INSERT INTO organizations (name) VALUES ('Canyon')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug, age_group) VALUES (?, 'Canyon Athletics', 'canyon-athletics', '12U')").run(org).lastInsertRowid;
  rae = db.prepare("INSERT INTO players (first_name, last_name, slug, date_of_birth, is_public) VALUES ('Rae', 'Runner', 'rae-runner', '2014-05-01', 1)").run().lastInsertRowid;
  sam1 = db.prepare("INSERT INTO players (first_name, last_name, slug, date_of_birth, is_public) VALUES ('Sam', 'Smith', 'sam-smith', '2014-02-02', 0)").run().lastInsertRowid;
  sam2 = db.prepare("INSERT INTO players (first_name, last_name, slug, date_of_birth, is_public) VALUES ('Sam', 'Smith', 'sam-smith-2', '2014-08-08', 0)").run().lastInsertRowid;
  for (const p of [rae, sam1, sam2]) {
    db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '7', '2026-01-01', '2026-12-31')").run(team, p);
  }
});

after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// ── Accounts ─────────────────────────────────────────────────────────────
test('sign-up creates a customer, signs them in, and records the event; one email, one login', async () => {
  const r = await call('POST', '/api/customer/signup', { body: { first_name: 'Ada', last_name: 'Guardian', email: 'Ada@Example.com ', password: 'long-enough-pw', role: 'guardian', phone: '(801) 555-0100' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'customer');
  assert.equal(r.body.user.email_verified, false);
  const row = db.prepare('SELECT * FROM customer_accounts WHERE email = ?').get('ada@example.com');
  assert.equal(row.phone_normalized, '18015550100');
  assert.ok(row.password_hash && !row.password_hash.includes('long-enough-pw'));
  assert.equal((await call('POST', '/api/customer/signup', { body: { first_name: 'A', last_name: 'G', email: 'ada@example.com', password: 'long-enough-pw', role: 'parent' } })).body.code, 'account_exists');
  db.prepare('INSERT INTO staff_users (email, name, password_hash) VALUES (?, ?, ?)').run('coach.kim@example.com', 'Kim Coach', hashPassword('staff-password'));
  assert.equal((await call('POST', '/api/customer/signup', { body: { first_name: 'K', last_name: 'C', email: 'coach.kim@example.com', password: 'long-enough-pw', role: 'coach' } })).body.code, 'login_exists');
  assert.equal((await call('POST', '/api/customer/signup', { body: { first_name: 'B', last_name: 'C', email: 'b@example.com', password: 'short', role: 'parent' } })).status, 400);
  assert.equal((await call('POST', '/api/customer/signup', { body: { first_name: 'B', last_name: 'C', email: 'b@example.com', password: 'long-enough-pw', role: 'superuser' } })).status, 400);
  // The shared login endpoint signs a customer in and /me knows them.
  const login = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'long-enough-pw' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.admin.role, 'customer');
  assert.equal((await call('GET', '/api/auth/me', { token: login.body.token })).body.admin.customer_role, 'guardian');
  await call('POST', '/api/auth/logout', { token: login.body.token });
  assert.equal((await call('GET', '/api/auth/me', { token: login.body.token })).status, 401);
});

test('email verification links are single-use, expire, and only a hash is stored', async () => {
  const c = await h.customer({ verified: false });
  const token = issueToken(db, c.id, 'verify_email', 48);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_tokens WHERE token_hash = ?').get(token).n, 0, 'the raw token is never stored');
  assert.equal((await call('POST', '/api/customer/verify', { body: { token } })).status, 200);
  assert.ok(db.prepare('SELECT email_verified_at FROM customer_accounts WHERE id = ?').get(c.id).email_verified_at);
  assert.match((await call('POST', '/api/customer/verify', { body: { token } })).body.error, /already been used/);
  const c2 = await h.customer({ verified: false });
  const old = issueToken(db, c2.id, 'verify_email', 48);
  db.prepare("UPDATE customer_tokens SET expires_at = datetime('now', '-1 minute') WHERE account_id = ?").run(c2.id);
  assert.match((await call('POST', '/api/customer/verify', { body: { token: old } })).body.error, /expired/);
  assert.equal((await call('POST', '/api/customer/resend-verification', { token: c.token })).status, 400, 'already verified');
  assert.equal((await call('POST', '/api/customer/resend-verification', { token: c2.token })).status, 200);
});

test('password reset never reveals whether an account exists, and ends every session', async () => {
  const c = await h.customer();
  assert.equal((await call('POST', '/api/customer/forgot-password', { body: { email: 'nobody@example.com' } })).status, 200);
  assert.equal((await call('POST', '/api/customer/forgot-password', { body: { email: c.email } })).status, 200);
  const token = issueToken(db, c.id, 'reset_password', 1);
  assert.equal((await call('POST', '/api/customer/reset-password', { body: { token, password: 'a-brand-new-password' } })).status, 200);
  assert.equal((await call('GET', '/api/customer/me', { token: c.token })).status, 401, 'old session signed out');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: c.email, password: 'a-brand-new-password' } })).status, 200);
  assert.equal((await call('POST', '/api/customer/reset-password', { body: { token, password: 'another-new-password' } })).status, 400, 'single use');
});

test('a coach portal login submits under the same contact, linked by email', async () => {
  const staffId = db.prepare('SELECT id FROM staff_users WHERE email = ?').get('coach.kim@example.com').id;
  const staffToken = h.principals.createStaffSession(staffId);
  const me = await call('GET', '/api/customer/me', { token: staffToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.via, 'staff');
  assert.equal(me.body.account.role, 'coach');
  assert.equal(me.body.account.has_password, false, 'they keep signing in with the coach login');
  await call('GET', '/api/customer/me', { token: staffToken });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_accounts WHERE email = ?').get('coach.kim@example.com').n, 1, 'never a second contact');
  // An internal session is not a submitter.
  assert.equal((await call('GET', '/api/customer/me', { token: h.internal().token })).status, 401);
});

test('a customer can only ever see their own submissions and files (404, not 403)', async () => {
  const a = await h.customer();
  const b = await h.customer();
  const pid = await h.draft(a.token);
  const up = await h.upload(a.token, pid);
  assert.equal(up.status, 200);
  assert.equal((await call('GET', `/api/intake/submissions/${pid}`, { token: b.token })).status, 404);
  assert.equal((await call('PUT', `/api/intake/submissions/${pid}`, { token: b.token, body: { form: {} } })).status, 404);
  assert.equal((await call('POST', `/api/intake/files/${up.registered.file.id}/complete`, { token: b.token, body: {} })).status, 404);
  assert.equal((await call('DELETE', `/api/intake/files/${up.registered.file.id}`, { token: b.token })).status, 404);
  assert.equal((await call('GET', '/api/intake/submissions', { token: b.token })).body.submissions.length, 0);
  assert.equal((await call('GET', `/api/intake/submissions/${pid}`)).status, 401);
});

// ── Drafts and consent ───────────────────────────────────────────────────
test('drafts keep only staff-verified player links; a profile link pre-fills a public name, never a private one', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token, { athletes: [{ player_id: rae, first_name: 'Rae', last_name: 'Runner', birth_year: 2014, relationship: 'parent' }], terms: false });
  const row = db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ?').get(h.sub(pid).id);
  assert.equal(row.player_id, null, 'a customer cannot attach themselves to a player they are not verified for');
  assert.equal(row.resolution, 'pending');
  const viaProfile = await call('POST', '/api/intake/submissions', { token: c.token, body: { player_slug: 'rae-runner', source_page: '/p/rae-runner' } });
  assert.equal(viaProfile.body.submission.form.athletes[0].first_name, 'Rae');
  assert.equal(viaProfile.body.submission.form.athletes[0].player_id, null, 'a public name is pre-filled, never linked');
  const privateProfile = await call('POST', '/api/intake/submissions', { token: c.token, body: { player_slug: 'sam-smith' } });
  assert.deepEqual(privateProfile.body.submission.form.athletes, [], 'a private (minor) profile is never revealed');
  assert.equal(h.sub(viaProfile.body.submission.public_id).source_page, '/p/rae-runner', 'the entry point is preserved');
});

test('rights: exact wording is served, required uses are enforced, and the record can never be edited or deleted', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token, { terms: false });
  const terms = (await call('GET', `/api/intake/submissions/${pid}/terms`, { token: c.token })).body;
  assert.match(terms.terms.attestation, /parent of each minor athlete/);
  assert.equal(terms.guide.title, 'Rookie filming guide');
  const missing = await call('POST', `/api/intake/submissions/${pid}/rights`, { token: c.token, body: { uses: { analysis: true }, retention_ack: true, guide_ack: true } });
  assert.equal(missing.status, 400);
  assert.equal((await h.upload(c.token, pid)).body.code, 'rights_required', 'no upload before the terms are accepted');
  const ok = await call('POST', `/api/intake/submissions/${pid}/rights`, { token: c.token, body: { uses: { analysis: true, results: true }, contact_permission: false, retention_ack: true, guide_ack: true, restrictions: 'No social media' } });
  assert.equal(ok.status, 201);
  const rights = db.prepare('SELECT * FROM intake_rights WHERE submission_id = ?').get(h.sub(pid).id);
  assert.equal(rights.policy_version, '2026-10-draft-1');
  assert.equal(rights.pending_legal, 1);
  assert.equal(rights.contact_permission, 0);
  assert.equal(JSON.parse(rights.permitted_uses).improvement, false);
  assert.equal(JSON.parse(rights.athlete_ids)[0].first_name, 'Rae', 'which athletes the acceptance covered');
  assert.match(rights.retention_deadline, /^\d{4}-\d{2}-\d{2}/);
  assert.throws(() => db.prepare('UPDATE intake_rights SET contact_permission = 1 WHERE id = ?').run(rights.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM intake_rights WHERE id = ?').run(rights.id), /never deleted/);
});

// ── Uploads ──────────────────────────────────────────────────────────────
test('upload → technical check: probe results become plain-language notes; diagnostics stay internal', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  const up = await h.upload(c.token, pid, { bytes: Buffer.from('a'.repeat(5000)) });
  assert.equal(up.status, 200);
  assert.equal(up.body.file.status, 'uploaded');
  assert.equal(up.body.file.status_label, 'Checking the file', 'an unprocessed file is never described as ready');
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(up.registered.file.id);
  assert.equal(fs.readFileSync(localPathFor(file.storage_key)).length, 5000, 'stored byte-for-byte');
  assert.match(file.storage_key, /^originals\/intake\//, 'inherits the originals lifecycle rule');
  assert.ok(file.retention_deadline, 'an explicit deletion date is stored');
  assert.equal(await h.probe(file.id, { width: 1280, height: 720, duration_s: 7000, effective_fps: 29.97, nominal_fps: 29.97, codec: 'hevc', rotation: 0, vfr: 1 }), 'ready');
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  const f = view.files[0];
  assert.equal(f.status_label, 'Received');
  assert.deepEqual(f.issues.map(i => i.severity), ['warning', 'tip']);
  assert.match(f.issues[0].text, /720p/);
  assert.equal(f.summary, '720p · 30 fps · 1h 56m');
  const json = JSON.stringify(view);
  assert.ok(!json.includes('hevc') && !json.includes('VFR') && !json.includes('diagnostics'), 'no internal diagnostics in the customer view');
  assert.ok(db.prepare('SELECT diagnostics FROM intake_files WHERE id = ?').get(file.id).diagnostics.includes('VFR'), 'kept internally');
});

test('an unreadable upload asks the customer for action, after retrying transient failures', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  const up = await h.upload(c.token, pid, { name: 'broken.mov' });
  assert.equal(await h.probe(up.registered.file.id, new Error('connection reset')), 'retry');
  assert.equal(await h.probe(up.registered.file.id, new Error('moov atom not found')), 'needs_customer_action', 'a broken file is permanent at once');
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.status.key, 'draft', 'still a draft overall');
  assert.equal(view.files[0].status_label, 'Action needed', 'the file itself asks for action');
  assert.match(view.files[0].issues[0].text, /could not read this video/);
  assert.ok(view.readiness.some(m => m.code === 'file_action'), 'cannot submit until it is replaced or removed');
  assert.equal((await call('DELETE', `/api/intake/files/${up.registered.file.id}`, { token: c.token })).status, 200);
  assert.ok(!fs.existsSync(localPathFor(db.prepare('SELECT storage_key FROM intake_files WHERE id = ?').get(up.registered.file.id).storage_key)), 'the stored object is deleted');
});

test('interrupted upload resumes the same file without re-sending finished parts; it attaches exactly once', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  const bytes = Buffer.from('x'.repeat(30));
  const first = await h.upload(c.token, pid, { bytes, partSize: 10, stopAfterPart: 2 });
  assert.equal(first.interrupted, true);
  assert.equal(first.sent, 2);
  await call('POST', `/api/intake/files/${first.body.file.id}/pause`, { token: c.token });
  assert.equal(db.prepare('SELECT status FROM intake_files WHERE id = ?').get(first.body.file.id).status, 'paused');
  const resumed = await h.upload(c.token, pid, { bytes, partSize: 10 });
  assert.equal(resumed.registered.resumed, true);
  assert.equal(resumed.registered.file.id, first.body.file.id, 'the same file record');
  assert.deepEqual(resumed.registered.upload.uploaded_parts.map(p => p.partNumber), [1, 2]);
  assert.equal(resumed.sent, 1, 'only the missing part was sent');
  const key = db.prepare('SELECT storage_key FROM intake_files WHERE id = ?').get(first.body.file.id).storage_key;
  assert.equal(fs.readFileSync(localPathFor(key)).toString(), 'x'.repeat(30));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM intake_files WHERE submission_id = ? AND status != 'deleted'").get(h.sub(pid).id).n, 1);
  const again = await h.upload(c.token, pid, { bytes, partSize: 10 });
  assert.equal(again.body.duplicate, true, 'the finished file is not attached twice');
});

test('the same file on another of the customer’s submissions is pointed out; another customer’s copy is staff-visible only', async () => {
  const c = await h.customer();
  const pid1 = await h.draft(c.token);
  const pid2 = await h.draft(c.token);
  const bytes = Buffer.from('shared game video');
  await h.upload(c.token, pid1, { bytes });
  const dup = await h.upload(c.token, pid2, { bytes });
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.elsewhere, pid1);
  const other = await h.customer();
  const pid3 = await h.draft(other.token);
  const theirs = await h.upload(other.token, pid3, { bytes });
  assert.equal(theirs.status, 200, 'another family may upload the same game');
  assert.ok(!JSON.stringify(theirs.body).includes(pid1), 'without learning anyone else’s submission');
  const admin = h.internal();
  const record = (await call('GET', `/api/command/intake/${h.sub(pid3).id}`, { token: admin.token })).body;
  assert.equal(record.files[0].duplicates.intake[0].public_id, pid1, 'staff see the duplicate');
});

// ── Submission and the queue ─────────────────────────────────────────────
test('submit is refused until everything required is present, then lands in the queue with a task', async () => {
  const c = await h.customer({ verified: false });
  const pid = await h.draft(c.token, { athletes: [{ first_name: 'Rae', last_name: 'Runner', birth_year: 2014, relationship: 'parent' }] });
  const early = await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  assert.equal(early.status, 400);
  assert.deepEqual(early.body.missing.map(m => m.code).sort(), ['email_unverified', 'video']);
  await h.upload(c.token, pid);
  // Manual verification is the fallback until email is live — staff only, audited, with a note.
  const analyst = h.internal('analyst');
  const will = h.internal('fulfillment', 'Will');
  assert.equal((await call('POST', `/api/command/intake/accounts/${c.id}/verify-email`, { token: analyst.token, body: { note: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/command/intake/accounts/${c.id}/verify-email`, { token: will.token, body: {} })).status, 400);
  assert.equal((await call('POST', `/api/command/intake/accounts/${c.id}/verify-email`, { token: will.token, body: { note: 'Replied from that address' } })).status, 200);
  assert.equal(db.prepare('SELECT verified_via FROM customer_accounts WHERE id = ?').get(c.id).verified_via, 'staff');
  const ok = await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.submission.status.key, 'processing');
  const sub = h.sub(pid);
  assert.equal(sub.status, 'needs_identity_review', 'a new athlete candidate waits for staff');
  assert.equal(sub.next_action, 'Resolve athlete identity');
  assert.ok(sub.due_at, 'an internal service target');
  assert.equal(db.prepare("SELECT email_status FROM intake_notifications WHERE submission_id = ? AND event_key = 'submission_received'").get(sub.id).email_status, 'skipped', 'recorded in-app; email activates with the provider');
  assert.equal((await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token })).status, 409, 'submitting twice is refused');
  const queue = (await call('GET', '/api/command/intake?stage=needs_identity_review', { token: will.token })).body;
  const row = queue.rows.find(r => r.public_id === pid);
  assert.ok(row);
  assert.equal(row.athletes.unresolved, 1);
  assert.equal(row.consent, 'accepted (draft terms)');
  assert.ok(row.flags.includes('payment_unconfirmed'));
});

test('a default owner gets every new submission; the setting is admin-only', async () => {
  const admin = h.internal();
  const will = h.internal('fulfillment', 'Will Owner');
  assert.equal((await call('PUT', '/api/command/intake-settings', { token: will.token, body: { default_owner_id: will.id } })).status, 403);
  assert.equal((await call('PUT', '/api/command/intake-settings', { token: admin.token, body: { default_owner_id: will.id } })).status, 200);
  const c = await h.customer();
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  assert.equal(h.sub(pid).owner_id, will.id);
  await call('PUT', '/api/command/intake-settings', { token: admin.token, body: { default_owner_id: null } });
});

test('identity: candidates carry confidence and reasons; ambiguity needs a staff choice; a new record needs a reason', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token, { athletes: [{ first_name: 'Sam', last_name: 'Smith', birth_year: 2014, relationship: 'parent' }] });
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  const rec = (await call('GET', `/api/command/intake/${id}`, { token: will.token })).body;
  const ath = rec.athletes[0];
  assert.equal(ath.ambiguous, true);
  assert.deepEqual(ath.candidates.map(x => x.player_id).sort(), [sam1, sam2].sort());
  assert.ok(ath.candidates[0].reasons.includes('same first name'));
  assert.ok(ath.candidates[0].reasons.some(r => /roster/.test(r)), 'team roster is a signal');
  assert.equal((await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'new_player' } })).status, 409);
  const linked = await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: sam2 } });
  assert.equal(linked.status, 200);
  assert.equal(h.sub(pid).status, 'ready_for_job', 'identity resolved → ready for the job');
  assert.ok(db.prepare('SELECT 1 FROM customer_athletes WHERE account_id = ? AND player_id = ?').get(c.id, sam2), 'a parent link becomes "my athletes"');
  const event = db.prepare("SELECT data FROM intake_events WHERE submission_id = ? AND event_type = 'identity_linked_existing'").get(id);
  assert.equal(JSON.parse(event.data).candidates.length, 2, 'the candidate list and confidence are kept with the decision');
  const me = (await call('GET', '/api/customer/me', { token: c.token })).body;
  assert.equal(me.athletes[0].player_id, sam2);
  assert.equal(me.athletes[0].slug, null, 'a private profile’s address is not handed out');
});

test('a coach never gains athlete ownership; their link is to the team', async () => {
  const coach = await h.customer({ role: 'coach' });
  const pid = await h.draft(coach.token, { role: 'coach', athletes: [{ first_name: 'Rae', last_name: 'Runner', birth_year: 2014, relationship: 'coach' }] });
  await h.upload(coach.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: coach.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  const ath = (await call('GET', `/api/command/intake/${id}`, { token: will.token })).body.athletes[0];
  assert.equal(ath.ownership, false);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: rae } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_athletes WHERE account_id = ?').get(coach.id).n, 0);
  const created = await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } });
  assert.equal(created.status, 201);
  assert.ok(db.prepare('SELECT 1 FROM customer_team_links WHERE account_id = ? AND team_id = ?').get(coach.id, team));
});

// ── The Command hand-off ─────────────────────────────────────────────────
test('creating the job: feeds are the same stored objects, carrying rights/uploader/deletion date; participants join the roster', async () => {
  const c = await h.customer();
  const outsider = db.prepare("INSERT INTO players (first_name, last_name, slug, is_public) VALUES ('Out', 'Sider', 'out-sider', 0)").run().lastInsertRowid;
  const pid = await h.draft(c.token, { athletes: [{ first_name: 'Out', last_name: 'Sider', birth_year: 2014, relationship: 'parent', jersey: '#44' }], service: { package_key: 'pro', order_reference: 'pi_123' } });
  const up = await h.upload(c.token, pid);
  await h.probe(up.registered.file.id);
  await h.upload(c.token, pid, { kind: 'radar_csv', name: 'radar.csv', bytes: Buffer.from('Speed,Time\n61.2,10:01:00\n63.5,10:03:00\n') });
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  const blocked = await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Resolve every athlete/);
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: outsider } });
  const created = await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(created.body.job_id);
  const order = db.prepare('SELECT * FROM cmd_orders WHERE id = ?').get(job.order_id);
  assert.equal(order.package_key, 'rookie', 'Pro is fulfilled as Rookie until its modules ship');
  assert.match(order.notes, /Customer requested Pro/);
  assert.match(order.notes, /pi_123/);
  assert.equal(order.contact_email, c.email, 'the verified submitter who allowed contact hears about the job');
  assert.equal(db.prepare('SELECT media_consent, sharing_scope FROM cmd_consent WHERE job_id = ?').get(job.id).sharing_scope, 'customer');
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(up.registered.file.id);
  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(file.feed_id);
  assert.equal(feed.storage_key, file.storage_key, 'no copy, no re-upload');
  assert.equal(feed.submission_id, id);
  assert.equal(feed.rights_id, file.rights_id);
  assert.equal(feed.retention_deadline, file.retention_deadline);
  assert.equal(feed.uploader_account_id, c.id);
  assert.equal(feed.capture_profile_key, 'behind_home_1080p60');
  assert.equal(db.prepare("SELECT status FROM cmd_media_jobs WHERE feed_id = ? AND kind = 'probe'").get(feed.id).status, 'queued', 'the normal probe → proxy pipeline takes over');
  const participant = db.prepare('SELECT * FROM cmd_job_participants WHERE job_id = ? AND player_id = ?').get(job.id, outsider);
  assert.equal(participant.jersey, '44');
  const { commandRoster } = await import('./commandRoster.js');
  const entry = commandRoster(db, job).find(p => p.id === outsider);
  assert.equal(entry.source, 'submission');
  assert.equal(entry.is_guest, 0, 'an identified player, not a placeholder');
  assert.equal(h.sub(pid).status, 'linked');
  // Supporting radar export straight into the job's radar queue.
  const radar = db.prepare("SELECT id FROM intake_files WHERE submission_id = ? AND kind = 'radar_csv'").get(id);
  const sent = await call('POST', `/api/command/intake/${id}/files/${radar.id}/send-to-job`, { token: will.token });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_radar_readings WHERE job_id = ?').get(job.id).n, 2);
  assert.equal((await call('POST', `/api/command/intake/${id}/files/${radar.id}/send-to-job`, { token: will.token })).body.result.duplicate, true, 'idempotent');
  assert.equal((await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).status, 409, 'never a second job');
  // Customer sees analysis, not identity or job internals.
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.status.key, 'analysis');
  assert.ok(view.timeline.some(e => e.message === 'Your game is queued for analysis.'));
  assert.ok(!view.timeline.some(e => /Command job #/.test(e.message)), 'internal events stay internal');
});

test('linking to an existing job reuses identical feeds and never mixes test and real work', async () => {
  const will = h.internal('fulfillment');
  const c = await h.customer();
  const pid = await h.draft(c.token, { athletes: [] , role: 'coach' });
  db.prepare("UPDATE customer_accounts SET role = 'coach' WHERE id = ?").run(c.id);
  const bytes = Buffer.from('game shared with an existing job');
  await h.upload(c.token, pid, { kind: 'roster', name: 'roster.csv', bytes: Buffer.from('name\nRae Runner\n') });
  const up = await h.upload(c.token, pid, { bytes });
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const id = h.sub(pid).id;
  const admin = h.internal();
  const existing = await call('POST', '/api/command/jobs', { token: admin.token, body: { team_id: team, game_date: '2026-09-20', package_key: 'rookie', media_consent: true } });
  const jobId = existing.body.job.id;
  const regFile = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(up.registered.file.id);
  db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, size_bytes, content_hash, status) VALUES (?, 'Behind Home', 'k', 'same.mp4', ?, ?, 'ready')").run(jobId, regFile.size_bytes, regFile.content_hash);
  const testJob = await call('POST', '/api/command/jobs', { token: admin.token, body: { team_id: team, game_date: '2026-09-20', package_key: 'rookie', synthetic: true } });
  assert.equal((await call('POST', `/api/command/intake/${id}/link-job`, { token: will.token, body: { job_id: testJob.body.job.id } })).status, 409);
  const rec = (await call('GET', `/api/command/intake/${id}`, { token: will.token })).body;
  assert.ok(rec.game.job_candidates.some(j => j.id === jobId), 'the existing job is suggested before a new one is made');
  assert.equal((await call('POST', `/api/command/intake/${id}/link-job`, { token: will.token, body: { job_id: jobId } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_video_feeds WHERE job_id = ?').get(jobId).n, 1, 'the identical file joins the existing feed');
  assert.ok(db.prepare('SELECT feed_id FROM intake_files WHERE id = ?').get(up.registered.file.id).feed_id);
});

test('release stages flow back to the queue and the customer, and results never show a zero', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: rae } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  // A radar velocity published, a home-to-first unavailable, steal never attempted.
  db.prepare("INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, evidence_kind, evidence_id) VALUES (?, 'pitch_velocity_radar', ?, 64.2, 'mph', 'radar_verified', 'published', 'radar_reading', 9001)").run(jobId, rae);
  db.prepare("INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, unavailable_reason, evidence_kind, evidence_id) VALUES (?, 'home_to_first', ?, NULL, 's', 'frame_timed', 'unavailable', 'base_not_visible', 'measurement', 9002)").run(jobId, rae);
  db.prepare("UPDATE cmd_jobs SET metric_release_status = 'released', game_record_status = 'pending' WHERE id = ?").run(jobId);
  const queue = (await call('GET', '/api/command/intake', { token: will.token })).body;
  assert.equal(queue.rows.find(r => r.public_id === pid).stage, 'metrics_released');
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.status.key, 'metrics_ready');
  assert.equal(view.status.game_record, 'not_started');
  const metrics = view.results.athletes[0].metrics;
  const velo = metrics.find(m => m.metric === 'Pitch Velocity — Radar');
  assert.equal(velo.source, 'Radar verified');
  assert.deepEqual(velo.values.map(v => v.value), [64.2, 64.2]);
  const h2f = metrics.find(m => m.metric === 'Home-to-First Time');
  assert.equal(h2f.available, false);
  assert.match(h2f.reasons[0], /not visible on camera/);
  const steal = metrics.find(m => m.metric === 'Steal Time');
  assert.equal(steal.available, false, 'nothing measured is unavailable, never zero');
  assert.ok(!JSON.stringify(view.results).includes('"value":0'));
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'in_progress' WHERE id = ?").run(jobId);
  assert.equal((await call('GET', '/api/command/intake', { token: will.token })).body.rows.find(r => r.public_id === pid).stage, 'game_record_pending');
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(jobId);
  assert.equal((await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission.status.key, 'complete');
});

// ── Messages, closing, roles ─────────────────────────────────────────────
test('request for information: the customer sees it and replies; internal notes never reach them', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  await call('POST', `/api/command/intake/${id}/notes`, { token: will.token, body: { message: 'Possible sibling of #44 — check' } });
  await call('POST', `/api/command/intake/${id}/messages`, { token: will.token, body: { message: 'Which inning does the clip start in?', request_action: true } });
  assert.equal(h.sub(pid).status, 'needs_customer_action');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM intake_notifications WHERE submission_id = ? AND event_key = 'action_required'").get(id).n, 1);
  let view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.status.key, 'action_required');
  assert.equal(view.message, 'Which inning does the clip start in?');
  assert.ok(!JSON.stringify(view).includes('sibling'), 'internal notes stay internal');
  assert.equal((await call('POST', `/api/intake/submissions/${pid}/reply`, { token: c.token, body: { message: 'Second inning' } })).status, 201);
  const queueRow = (await call('GET', '/api/command/intake?stage=needs_customer_action', { token: will.token })).body.rows.find(r => r.public_id === pid);
  assert.ok(queueRow.flags.includes('customer_replied'));
  await call('PUT', `/api/command/intake/${id}`, { token: will.token, body: { status: 'needs_identity_review' } });
  view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.message, '', 'the request closes with the status');
});

test('declining requires words for the customer; reopening works; nothing is deleted', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const will = h.internal('fulfillment');
  const id = h.sub(pid).id;
  assert.equal((await call('POST', `/api/command/intake/${id}/close`, { token: will.token, body: { outcome: 'declined', reason: 'out of area' } })).status, 400);
  await call('POST', `/api/command/intake/${id}/close`, { token: will.token, body: { outcome: 'declined', reason: 'out of area', customer_message: 'We do not cover that league yet.' } });
  const view = (await call('GET', `/api/intake/submissions/${pid}`, { token: c.token })).body.submission;
  assert.equal(view.status.key, 'declined');
  assert.equal(view.status.detail, 'We do not cover that league yet.');
  assert.equal((await call('POST', `/api/command/intake/${id}/reopen`, { token: will.token })).status, 200);
  assert.equal(h.sub(pid).status, 'new');
});

test('least privilege: analysts read; fulfillment acts; only admins execute deletions or clear escalations', async () => {
  const c = await h.customer();
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  const id = h.sub(pid).id;
  const analyst = h.internal('analyst');
  const will = h.internal('fulfillment');
  const admin = h.internal('admin');
  assert.equal((await call('GET', `/api/command/intake/${id}`, { token: analyst.token })).status, 200);
  assert.equal((await call('PUT', `/api/command/intake/${id}`, { token: analyst.token, body: { next_action: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/command/intake/${id}/escalate`, { token: will.token, body: { note: 'Two families claim the same athlete' } })).status, 200);
  assert.equal((await call('PUT', `/api/command/intake/${id}`, { token: will.token, body: { escalated: false } })).status, 403);
  assert.equal((await call('PUT', `/api/command/intake/${id}`, { token: admin.token, body: { escalated: false } })).status, 200);
  const req = await call('POST', '/api/command/intake-deletions', { token: will.token, body: { scope: 'submission', target_id: id, reason: 'customer_request' } });
  assert.equal(req.status, 201);
  assert.equal((await call('POST', `/api/command/intake-deletions/${req.body.request.id}/execute`, { token: will.token, body: { actions: ['delete_media'] } })).status, 403);
  // Fulfillment can never move a job's release tracks.
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'guest' } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  assert.equal((await call('POST', `/api/command/jobs/${jobId}/status`, { token: will.token, body: { kind: 'metric_release', to: 'in_progress' } })).status, 403);
  const guest = db.prepare('SELECT player_id FROM intake_athletes WHERE id = ?').get(ath.id).player_id;
  assert.ok(db.prepare('SELECT 1 FROM cmd_job_guests WHERE job_id = ? AND player_id = ?').get(jobId, guest), 'the guest path becomes a job placeholder');
});

test('team page: admins create least-privilege logins; no self-lockout; deactivation ends sessions', async () => {
  const admin = h.internal('admin');
  const r = await call('POST', '/api/command/team', { token: admin.token, body: { email: 'will@diamondmetrics.test', name: 'Will', role: 'fulfillment', password: 'temporary-password' } });
  assert.equal(r.status, 201);
  const login = await call('POST', '/api/auth/login', { body: { email: 'will@diamondmetrics.test', password: 'temporary-password' } });
  assert.equal(login.body.admin.role, 'fulfillment');
  assert.equal((await call('GET', '/api/command/team', { token: login.body.token })).status, 403);
  assert.equal((await call('PUT', `/api/command/team/${admin.id}`, { token: admin.token, body: { active: false } })).status, 409);
  const willId = db.prepare('SELECT id FROM admins WHERE email = ?').get('will@diamondmetrics.test').id;
  assert.equal((await call('PUT', `/api/command/team/${willId}`, { token: admin.token, body: { active: false } })).status, 200);
  assert.equal((await call('GET', '/api/command/intake', { token: login.body.token })).status, 401, 'an existing session stops working');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'will@diamondmetrics.test', password: 'temporary-password' } })).status, 401);
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table = 'admins' AND target_id = ? AND note LIKE '%deactivated%'").get(willId));
});

// ── Notifications and test isolation ─────────────────────────────────────
test('job email reaches the order contact and each verified submitter who allowed contact — never a test account', async () => {
  const will = h.internal('fulfillment');
  const parent = await h.customer();
  const pid = await h.draft(parent.token);
  await h.upload(parent.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: parent.token });
  const id = h.sub(pid).id;
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id);
  await call('POST', `/api/command/intake/${id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'link', player_id: rae } });
  const jobId = (await call('POST', `/api/command/intake/${id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  // A second family on the same game, who declined contact.
  const quiet = await h.customer();
  const pid2 = await h.draft(quiet.token, { terms: false });
  await call('POST', `/api/intake/submissions/${pid2}/rights`, { token: quiet.token, body: { uses: { analysis: true, results: true }, contact_permission: false, retention_ack: true, guide_ack: true } });
  await h.upload(quiet.token, pid2, { bytes: Buffer.from('second family video') });
  await call('POST', `/api/intake/submissions/${pid2}/submit`, { token: quiet.token });
  const id2 = h.sub(pid2).id;
  const ath2 = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(id2);
  await call('POST', `/api/command/intake/${id2}/athletes/${ath2.id}/resolve`, { token: will.token, body: { action: 'link', player_id: rae } });
  await call('POST', `/api/command/intake/${id2}/link-job`, { token: will.token, body: { job_id: jobId } });
  assert.deepEqual(jobRecipients(db, jobId), [parent.email]);
  assert.equal(db.prepare("SELECT email_status FROM intake_notifications WHERE submission_id = ? AND event_key = 'submission_received'").get(id2).email_status, 'no_permission');
});

test('a test account’s submissions are synthetic end to end', async () => {
  const will = h.internal('fulfillment');
  const tester = await h.customer();
  await call('PUT', `/api/command/intake/accounts/${tester.id}`, { token: will.token, body: { is_test: true } });
  const pid = await h.draft(tester.token);
  await h.upload(tester.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: tester.token });
  const sub = h.sub(pid);
  assert.equal(sub.synthetic, 1);
  assert.equal(db.prepare('SELECT email_status FROM intake_notifications WHERE submission_id = ?').get(sub.id).email_status, 'suppressed_synthetic');
  assert.equal((await call('GET', `/api/intake/submissions/${pid}`, { token: tester.token })).body.submission.test, true);
  const ath = db.prepare('SELECT id FROM intake_athletes WHERE submission_id = ?').get(sub.id);
  await call('POST', `/api/command/intake/${sub.id}/athletes/${ath.id}/resolve`, { token: will.token, body: { action: 'guest' } });
  const jobId = (await call('POST', `/api/command/intake/${sub.id}/create-job`, { token: will.token, body: { team_id: team } })).body.job_id;
  assert.equal(db.prepare('SELECT o.synthetic FROM cmd_orders o JOIN cmd_jobs j ON j.order_id = o.id WHERE j.id = ?').get(jobId).synthetic, 1);
  assert.deepEqual(jobRecipients(db, jobId), [], 'a test account is never emailed about a job');
  assert.equal((await call('GET', '/api/command/intake?include_test=0', { token: will.token })).body.rows.some(r => r.public_id === pid), false);
});

// ── Deletion ─────────────────────────────────────────────────────────────
test('closing an account anonymizes it, redacts what the customer wrote, and keeps the shape of the audit', async () => {
  const admin = h.internal();
  const c = await h.customer({ phone: '801-555-0199' });
  const pid = await h.draft(c.token);
  await h.upload(c.token, pid);
  await call('POST', `/api/intake/submissions/${pid}/submit`, { token: c.token });
  await call('POST', `/api/intake/submissions/${pid}/reply`, { token: c.token, body: { message: 'My number is 801-555-0199' } });
  const r = await call('POST', '/api/intake/account/deletion-request', { token: c.token, body: { note: 'Please delete everything' } });
  assert.equal(r.status, 201);
  const request = db.prepare("SELECT * FROM intake_deletion_requests WHERE scope = 'account' AND target_id = ?").get(c.id);
  const done = await call('POST', `/api/command/intake-deletions/${request.id}/execute`, { token: admin.token, body: { actions: ['delete_media', 'revoke_consent', 'close_account'], note: 'Verified by phone' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.request.status, 'completed');
  const acct = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(c.id);
  assert.equal(acct.status, 'closed');
  assert.equal(acct.phone, '');
  assert.match(acct.email, /^deleted-\d+@deleted\.invalid$/);
  assert.equal((await call('GET', '/api/customer/me', { token: c.token })).status, 401, 'sessions are gone');
  const reply = db.prepare("SELECT * FROM intake_events WHERE account_id = ? AND event_type = 'customer_reply'").get(c.id);
  assert.equal(reply.message, '[redacted]');
  assert.throws(() => db.prepare("UPDATE intake_events SET event_type = 'other' WHERE id = ?").run(reply.id), /append-only/, 'redaction is the only edit');
  assert.throws(() => db.prepare('DELETE FROM intake_events WHERE id = ?').run(reply.id), /append-only/);
  assert.equal(db.prepare("SELECT action FROM intake_rights WHERE submission_id = ? ORDER BY id DESC LIMIT 1").get(h.sub(pid).id).action, 'revoke');
  assert.equal((await call('POST', `/api/command/intake-deletions/${request.id}/execute`, { token: admin.token, body: { actions: ['delete_media'] } })).status, 409, 'decided once');
});

test('rate limits stop a burst of sign-ups for one email', async () => {
  process.env.DM_RATE_LIMITS = '1';
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await call('POST', '/api/customer/signup', { body: { first_name: 'R', last_name: 'L', email: 'burst@example.com', password: 'x' } })).status);
    }
    assert.ok(codes.includes(429), codes.join(','));
  } finally {
    process.env.DM_RATE_LIMITS = '0';
  }
});
