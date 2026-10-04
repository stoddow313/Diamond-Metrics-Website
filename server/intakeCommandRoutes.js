// Will's intake queue inside Command (customer footage submission §8–§10).
// Any internal role may look; acting needs the fulfillment or admin role;
// executing a deletion or clearing an escalation is admin-only (§2).
import { staffQueue, staffRecord, loadSubmission, updateSubmission, addNote, messageCustomer, escalate, resolveAthlete,
  createJobFromSubmission, linkSubmissionToJob, attachNewFiles, sendSupportingToJob, closeSubmission, reopenSubmission, settingsForIntake } from './intakeFulfillment.js';
import { deletionInventory, createStaffDeletionRequest, executeDeletion, declineDeletion, retentionDue, DELETION_ACTIONS, DELETION_REASONS } from './intakeDeletion.js';
import { markEmailVerified } from './customerAuth.js';
import { addEvent, getAccount, setSetting } from './intakeStore.js';
import { signedPlaybackUrl } from './commandMediaRoutes.js';
import { safeJson } from './intakeLogic.js';

const respond = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : `Intake action failed: ${err.message}` });
  }
};

export function mountIntakeCommandRoutes(app, { db, requireInternal, requireInternalRole, createJob }) {
  const canAct = requireInternalRole('admin', 'fulfillment');
  const adminOnly = requireInternalRole('admin');
  const record = id => staffRecord(db, id);

  app.get('/api/command/intake', requireInternal, respond((req, res) => {
    res.json(staffQueue(db, {
      stage: String(req.query.stage || ''), owner: String(req.query.owner || ''), q: String(req.query.q || ''),
      includeTest: req.query.include_test !== '0',
    }));
  }));

  app.get('/api/command/intake/:id', requireInternal, respond((req, res) => res.json(record(req.params.id))));

  app.put('/api/command/intake/:id', canAct, respond((req, res) => {
    updateSubmission(db, loadSubmission(db, req.params.id), req.body || {}, req.internal);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/notes', canAct, respond((req, res) => {
    addNote(db, loadSubmission(db, req.params.id), req.internal, req.body?.message);
    res.status(201).json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/messages', canAct, respond((req, res) => {
    messageCustomer(db, loadSubmission(db, req.params.id), req.internal, req.body || {});
    res.status(201).json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/escalate', canAct, respond((req, res) => {
    escalate(db, loadSubmission(db, req.params.id), req.internal, req.body?.note);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/athletes/:aid/resolve', canAct, respond((req, res) => {
    resolveAthlete(db, loadSubmission(db, req.params.id), req.params.aid, req.body || {}, req.internal);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/create-job', canAct, respond((req, res) => {
    const jobId = createJobFromSubmission(db, loadSubmission(db, req.params.id), req.body || {}, req.internal, { createJob });
    res.status(201).json({ job_id: jobId, ...record(req.params.id) });
  }));

  app.post('/api/command/intake/:id/link-job', canAct, respond((req, res) => {
    linkSubmissionToJob(db, loadSubmission(db, req.params.id), req.body?.job_id, req.internal);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/close', canAct, respond((req, res) => {
    closeSubmission(db, loadSubmission(db, req.params.id), req.body || {}, req.internal);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/reopen', canAct, respond((req, res) => {
    reopenSubmission(db, loadSubmission(db, req.params.id), req.internal, req.body?.note);
    res.json(record(req.params.id));
  }));

  app.post('/api/command/intake/:id/attach-files', canAct, respond((req, res) => {
    const attached = attachNewFiles(db, loadSubmission(db, req.params.id), req.internal);
    res.json({ attached, ...record(req.params.id) });
  }));

  app.post('/api/command/intake/:id/files/:fid/send-to-job', canAct, respond(async (req, res) => {
    const result = await sendSupportingToJob(db, loadSubmission(db, req.params.id), req.params.fid, req.internal);
    res.json({ result, ...record(req.params.id) });
  }));

  app.get('/api/command/intake/:id/files/:fid/download', requireInternal, respond(async (req, res) => {
    const f = db.prepare("SELECT * FROM intake_files WHERE id = ? AND submission_id = ? AND status != 'deleted'").get(Number(req.params.fid), Number(req.params.id));
    if (!f || !f.storage_key || ['uploading', 'paused'].includes(f.status)) return res.status(404).json({ error: 'File not available' });
    res.json({ url: await signedPlaybackUrl(f.storage_key), name: f.original_name });
  }));

  // Manual verification is the documented fallback until transactional email
  // is live (owner decision 2026-10-01) — audited like everything else.
  app.post('/api/command/intake/accounts/:aid/verify-email', canAct, respond((req, res) => {
    const account = getAccount(db, Number(req.params.aid));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.email_verified_at) return res.status(409).json({ error: 'Already verified' });
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Record how you confirmed the email (e.g. “replied from that address”).' });
    markEmailVerified(db, account.id, { via: 'staff', actorKind: 'staff', actorId: req.internal.id });
    addEvent(db, { accountId: account.id, actorKind: 'staff', actorId: req.internal.id, type: 'email_verified_note', message: note.slice(0, 500) });
    res.json({ ok: true });
  }));

  app.put('/api/command/intake/accounts/:aid', canAct, respond((req, res) => {
    const account = getAccount(db, Number(req.params.aid));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!('is_test' in (req.body || {}))) return res.status(400).json({ error: 'Nothing to update' });
    const next = req.body.is_test ? 1 : 0;
    db.prepare("UPDATE customer_accounts SET is_test = ?, updated_at = datetime('now') WHERE id = ?").run(next, account.id);
    // A test account's open, unlinked submissions follow it (§9 synthetic isolation).
    db.prepare("UPDATE intake_submissions SET synthetic = ? WHERE account_id = ? AND job_id IS NULL AND status NOT IN ('closed', 'declined')").run(next, account.id);
    addEvent(db, { accountId: account.id, actorKind: 'staff', actorId: req.internal.id, type: next ? 'marked_test_account' : 'unmarked_test_account', message: next ? 'Marked as an internal test account' : 'No longer a test account' });
    res.json({ ok: true, is_test: !!next });
  }));

  // ── Deletion / revocation ──────────────────────────────────────────────
  app.get('/api/command/intake-deletions', requireInternal, respond((_req, res) => {
    const requests = db.prepare(
      `SELECT d.*, a.email AS account_email, ad.name AS decided_by_name FROM intake_deletion_requests d
         LEFT JOIN customer_accounts a ON a.id = d.account_id LEFT JOIN admins ad ON ad.id = d.decided_by
        ORDER BY (d.status = 'open') DESC, d.id DESC LIMIT 200`
    ).all().map(r => ({ ...r, actions: safeJson(r.actions, []), result: safeJson(r.result), inventory: undefined }));
    res.json({ requests, retention_due: retentionDue(db), actions: DELETION_ACTIONS, reasons: DELETION_REASONS });
  }));

  app.post('/api/command/intake-deletions', canAct, respond((req, res) => {
    res.status(201).json({ request: createStaffDeletionRequest(db, req.body || {}, req.internal) });
  }));

  app.get('/api/command/intake-deletions/:id', requireInternal, respond((req, res) => {
    const request = db.prepare(
      'SELECT d.*, ad.name AS decided_by_name, a.email AS account_email FROM intake_deletion_requests d LEFT JOIN admins ad ON ad.id = d.decided_by LEFT JOIN customer_accounts a ON a.id = d.account_id WHERE d.id = ?'
    ).get(Number(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json({
      request: { ...request, actions: safeJson(request.actions, []), result: safeJson(request.result), inventory: undefined },
      inventory: request.status === 'open' ? deletionInventory(db, request) : safeJson(request.inventory),
      actions: DELETION_ACTIONS,
    });
  }));

  app.post('/api/command/intake-deletions/:id/execute', adminOnly, respond(async (req, res) => {
    const request = db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(Number(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(await executeDeletion(db, request, req.body || {}, req.internal));
  }));

  app.post('/api/command/intake-deletions/:id/decline', adminOnly, respond((req, res) => {
    const request = db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(Number(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json({ request: declineDeletion(db, request, req.body || {}, req.internal) });
  }));

  // ── Settings ───────────────────────────────────────────────────────────
  app.get('/api/command/intake-settings', requireInternal, respond((_req, res) => res.json(settingsForIntake(db))));

  app.put('/api/command/intake-settings', adminOnly, respond((req, res) => {
    const id = req.body?.default_owner_id ? Number(req.body.default_owner_id) : null;
    if (id && !db.prepare('SELECT 1 FROM admins WHERE id = ? AND active = 1').get(id)) return res.status(400).json({ error: 'default_owner_id must be an active internal account' });
    setSetting(db, 'intake_default_owner_id', id ?? '', req.internal.id);
    res.json(settingsForIntake(db));
  }));
}
