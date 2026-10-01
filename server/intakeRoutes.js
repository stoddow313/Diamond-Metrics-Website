// Customer intake routes (customer footage submission §3–§6, §10). Every route
// is scoped to the signed-in submitter: a submission or file that is not
// theirs is a 404, never a 403, so existence is never confirmed.
import express from 'express';
import {
  INTAKE_PACKAGES, ROLES, RELATIONSHIPS, CAMERA_VIEWS, FILE_KINDS, FILMING_GUIDES, GUIDE_VERSION, RIGHTS_POLICY,
  rightsTerms, retentionDays,
} from './intakeLogic.js';
import {
  findSubmission, findOwnFile, createDraft, saveDraft, acceptRights, registerFile, presignFilePart, appendFilePart,
  completeFile, pauseFile, removeFile, submitSubmission, discardDraft, customerReply, requestDeletion,
  customerSubmissionView, customerSubmissionList, customerFileView, refreshCaptureIssues,
} from './intakeService.js';
import { emailConfigured } from './notifications.js';
import { makeLimiter, rateLimit, clientIp } from './rateLimit.js';

export function intakeEnabled(env = process.env) {
  if (env.DM_INTAKE_ENABLED === '1') return true;
  if (env.DM_INTAKE_ENABLED === '0') return false;
  return (env.DM_ENV || env.NODE_ENV) !== 'production';
}

// Everything the intake screens need to render, from the one place the
// server enforces it.
export function intakeConfig() {
  return {
    enabled: intakeEnabled(),
    email_delivery: emailConfigured(),
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, group: r.group })),
    relationships: Object.entries(RELATIONSHIPS).map(([key, label]) => ({ key, label })),
    camera_views: Object.entries(CAMERA_VIEWS).map(([key, label]) => ({ key, label })),
    file_kinds: Object.entries(FILE_KINDS).map(([key, k]) => ({ key, label: k.label, extensions: k.extensions, max_bytes: k.maxBytes })),
    packages: Object.entries(INTAKE_PACKAGES).map(([key, p]) => ({
      key, label: p.label, best_for: p.best_for, upload: p.upload, delivers: p.delivers, expectation: p.expectation,
      self_serve: p.self_serve, note: p.customer_note || '',
    })),
    guides: FILMING_GUIDES,
    guide_version: GUIDE_VERSION,
    policy: { version: RIGHTS_POLICY.version, pending_legal: RIGHTS_POLICY.pending_legal },
    retention_days: retentionDays(),
  };
}

const respond = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const body = { error: err.status ? err.message : `Something went wrong — please try again. (${err.message})` };
    if (err.missing) body.missing = err.missing;
    if (err.code) body.code = err.code;
    res.status(err.status || 500).json(body);
  }
};

export function mountIntakeConfigRoute(app) {
  app.get('/api/intake/config', (_req, res) => res.json(intakeConfig()));
}

export function mountIntakeRoutes(app, { db, requireSubmitter }) {
  const drafts = makeLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });
  const writes = makeLimiter({ limit: 600, windowMs: 60 * 60 * 1000 });
  const perAccount = limiter => rateLimit([{ limiter, key: req => `acct:${req.account.id}`, message: 'Too many requests.' }]);
  const sub = req => findSubmission(db, req.params.pid, req.account.id);
  const file = req => findOwnFile(db, req.params.id, req.account.id);

  app.get('/api/intake/submissions', requireSubmitter, respond((req, res) => {
    res.json({ submissions: customerSubmissionList(db, req.account) });
  }));

  app.post('/api/intake/submissions', requireSubmitter, perAccount(drafts), respond((req, res) => {
    const draft = createDraft(db, req.account, req.body || {});
    res.status(201).json({ submission: customerSubmissionView(db, draft, req.account) });
  }));

  app.get('/api/intake/submissions/:pid', requireSubmitter, respond((req, res) => {
    res.json({ submission: customerSubmissionView(db, sub(req), req.account) });
  }));

  app.put('/api/intake/submissions/:pid', requireSubmitter, perAccount(writes), respond((req, res) => {
    const saved = saveDraft(db, sub(req), req.account, req.body || {});
    // The customer-facing capture notes depend on the package and coverage.
    for (const f of db.prepare("SELECT * FROM intake_files WHERE submission_id = ? AND kind = 'video'").all(saved.id)) refreshCaptureIssues(db, f);
    res.json({ submission: customerSubmissionView(db, saved, req.account) });
  }));

  // The exact wording the customer is about to accept, built by the same
  // function that hashes it on acceptance.
  app.get('/api/intake/submissions/:pid/terms', requireSubmitter, respond((req, res) => {
    const s = sub(req);
    res.json({
      terms: s.submitter_role ? rightsTerms({ role: s.submitter_role, retention: retentionDays() }) : null,
      guide: FILMING_GUIDES[s.package_key] || FILMING_GUIDES.rookie,
    });
  }));

  app.post('/api/intake/submissions/:pid/rights', requireSubmitter, perAccount(writes), respond((req, res) => {
    const s = sub(req);
    acceptRights(db, s, req.account, req.body || {}, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json({ submission: customerSubmissionView(db, sub(req), req.account) });
  }));

  app.post('/api/intake/submissions/:pid/files', requireSubmitter, perAccount(writes), respond(async (req, res) => {
    const r = await registerFile(db, sub(req), req.account, req.body || {});
    res.status(r.duplicate ? 200 : 201).json({ ...r, file: r.file ? customerFileView(r.file) : null });
  }));

  app.post('/api/intake/files/:id/parts/presign', requireSubmitter, respond(async (req, res) => {
    res.json({ url: await presignFilePart(db, file(req), req.body || {}) });
  }));

  app.post('/api/intake/files/:id/parts/:partNumber', requireSubmitter, express.raw({ type: '*/*', limit: '64mb' }), respond((req, res) => {
    appendFilePart(db, file(req), req.params.partNumber, req.body);
    res.json({ ok: true, received: req.body.length });
  }));

  app.post('/api/intake/files/:id/complete', requireSubmitter, respond(async (req, res) => {
    res.json({ file: customerFileView(await completeFile(db, file(req), req.body || {})) });
  }));

  app.post('/api/intake/files/:id/pause', requireSubmitter, respond((req, res) => {
    res.json({ file: customerFileView(pauseFile(db, file(req))) });
  }));

  app.delete('/api/intake/files/:id', requireSubmitter, respond(async (req, res) => {
    const f = file(req);
    const s = db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(f.submission_id);
    await removeFile(db, s, f, req.account);
    res.json({ submission: customerSubmissionView(db, s, req.account) });
  }));

  app.post('/api/intake/submissions/:pid/submit', requireSubmitter, respond((req, res) => {
    const s = submitSubmission(db, sub(req), req.account);
    res.json({ submission: customerSubmissionView(db, s, req.account) });
  }));

  app.post('/api/intake/submissions/:pid/discard', requireSubmitter, respond((req, res) => {
    discardDraft(db, sub(req), req.account);
    res.json({ ok: true });
  }));

  app.post('/api/intake/submissions/:pid/reply', requireSubmitter, perAccount(writes), respond((req, res) => {
    const s = sub(req);
    customerReply(db, s, req.account, req.body?.message);
    res.status(201).json({ submission: customerSubmissionView(db, sub(req), req.account) });
  }));

  app.post('/api/intake/submissions/:pid/deletion-request', requireSubmitter, respond((req, res) => {
    const s = sub(req);
    if (s.status === 'draft') return res.status(409).json({ error: 'Discard the draft instead — nothing has been sent to us yet.' });
    requestDeletion(db, req.account, { submission: s, scope: 'submission', note: req.body?.note });
    res.status(201).json({ submission: customerSubmissionView(db, sub(req), req.account) });
  }));

  app.post('/api/intake/account/deletion-request', requireSubmitter, respond((req, res) => {
    const r = requestDeletion(db, req.account, { scope: 'account', note: req.body?.note });
    res.status(201).json({ request: { status: r.status, created_at: r.created_at } });
  }));
}
