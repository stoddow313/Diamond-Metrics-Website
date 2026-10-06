// Customer/internal notification events (Phase 1, owner-directed). The
// cmd_notifications / intake_notifications row IS the audit record; email
// dispatch is an adapter that activates via env (RESEND_API_KEY +
// DM_EMAIL_FROM) with no workflow changes. Provider: Resend (TDR §3).
import { ENV, log } from './observability.js';

export const EVENT_KEYS = [
  'footage_received', 'review_started', 'metrics_ready',
  'full_review_pending', 'full_review_complete', 'paid_metric_unavailable',
];

const EVENT_SUBJECTS = {
  footage_received: 'Footage received — analysis queued',
  review_started: 'Your game review has started',
  metrics_ready: 'Verified metrics are ready',
  full_review_pending: 'Metrics released — full game review pending',
  full_review_complete: 'Full game review complete',
  paid_metric_unavailable: 'A purchased metric could not be measured',
};

// The site's public address, without a trailing slash. The site, not the API:
// Vercel serves the SPA and proxies /api to Render.
export function publicBaseUrl() {
  return (process.env.DM_PUBLIC_BASE_URL || (ENV === 'production' ? 'https://www.diamondmetrics.ai' : 'http://localhost:5173')).replace(/\/+$/, '');
}

// Where links in customer email point.
export function publicUrl(path = '/') {
  return `${publicBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.DM_EMAIL_FROM);
}

// What is missing for customer email to work — shown on /command/ops so the
// setup gap is explicit instead of a silent 'skipped'.
export function emailMissingConfig() {
  return ['RESEND_API_KEY', 'DM_EMAIL_FROM'].filter(k => !process.env[k]);
}

// One message to one recipient through the provider. Never throws: the
// caller records the outcome on its audit row.
export async function sendEmail({ to, subject, text }) {
  if (!emailConfigured()) return { ok: false, error: `Email is not configured — set ${emailMissingConfig().join(' and ')}` };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.DM_EMAIL_FROM, to: [to], subject, text }),
    });
    const body = (await res.text().catch(() => '')).slice(0, 600);
    return { ok: res.ok, status: res.status, provider_response: body, error: res.ok ? '' : body.slice(0, 500) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 500) };
  }
}

export function emitJobEvent(db, { jobId, eventKey, audience = 'customer', payload = {} }) {
  if (!EVENT_KEYS.includes(eventKey)) throw new Error(`Unknown notification event: ${eventKey}`);
  // A synthetic pipeline-test job must never reach a customer. Recorded as
  // suppressed rather than dropped, so the audit trail still shows what
  // would have been sent.
  const synthetic = db.prepare(
    'SELECT o.synthetic FROM cmd_orders o JOIN cmd_jobs j ON j.order_id = o.id WHERE j.id = ?'
  ).get(jobId)?.synthetic;
  if (synthetic) {
    const info = db.prepare(
      "INSERT INTO cmd_notifications (job_id, event_key, audience, payload, email_status) VALUES (?, ?, ?, ?, 'suppressed_synthetic')"
    ).run(jobId, eventKey, audience, JSON.stringify(payload));
    return info.lastInsertRowid;
  }
  const info = db.prepare(
    'INSERT INTO cmd_notifications (job_id, event_key, audience, payload, email_status) VALUES (?, ?, ?, ?, ?)'
  ).run(jobId, eventKey, audience, JSON.stringify(payload), emailConfigured() ? 'queued' : 'skipped');
  const id = info.lastInsertRowid;
  if (emailConfigured() && audience === 'customer') {
    // Fire-and-forget; failures land on the row, never block the workflow.
    dispatchEmail(db, id).catch(() => {});
  }
  return id;
}

// Operator-triggered test send through the exact path customers get, with
// the provider's raw response — the only way to prove DNS/domain
// verification is right before a real order depends on it.
export async function sendTestEmail(to, { env = 'production' } = {}) {
  if (!emailConfigured()) return { ok: false, error: `Email is not configured — set ${emailMissingConfig().join(' and ')} in Render and restart` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: false, error: 'A valid recipient address is required' };
  const r = await sendEmail({
    to,
    subject: `Diamond Metrics — transactional email test (${env})`,
    text: `This is a test of Diamond Metrics customer email from the ${env} environment, sent ${new Date().toISOString()}.\n\nIf you received it, the sending domain and API key are working.`,
  });
  return r.status ? { ok: r.ok, status: r.status, from: process.env.DM_EMAIL_FROM, to, provider_response: r.provider_response } : { ok: false, error: r.error };
}

// Everyone who should hear about a job: the order contact, plus each person
// whose verified, permission-granting intake submission is linked to it.
// Test accounts and synthetic submissions never receive mail.
export function jobRecipients(db, jobId) {
  const out = new Set();
  const order = db.prepare('SELECT o.contact_email FROM cmd_orders o JOIN cmd_jobs j ON j.order_id = o.id WHERE j.id = ?').get(jobId);
  if (order?.contact_email) out.add(order.contact_email.toLowerCase());
  const linked = db.prepare(
    `SELECT DISTINCT a.email FROM intake_submissions s JOIN customer_accounts a ON a.id = s.account_id
      WHERE s.job_id = ? AND s.synthetic = 0 AND a.is_test = 0 AND a.status = 'active' AND a.email_verified_at IS NOT NULL
        AND COALESCE((SELECT r.contact_permission FROM intake_rights r WHERE r.submission_id = s.id ORDER BY r.id DESC LIMIT 1), 0) = 1`
  ).all(jobId);
  for (const r of linked) out.add(r.email);
  return [...out];
}

async function dispatchEmail(db, notificationId) {
  const row = db.prepare(
    `SELECT n.*, t.name AS team_name, j.game_date
     FROM cmd_notifications n
     JOIN cmd_jobs j ON j.id = n.job_id
     JOIN teams t ON t.id = j.team_id
     WHERE n.id = ?`
  ).get(notificationId);
  const recipients = row ? jobRecipients(db, row.job_id) : [];
  if (!row || recipients.length === 0) {
    db.prepare("UPDATE cmd_notifications SET email_status = 'skipped' WHERE id = ?").run(notificationId);
    return;
  }
  // One message per recipient: a coach and a parent linked to the same game
  // must never see each other's address.
  const errors = [];
  for (const to of recipients) {
    const r = await sendEmail({
      to,
      subject: `${EVENT_SUBJECTS[row.event_key]} — ${row.team_name} ${row.game_date}`,
      text: `${EVENT_SUBJECTS[row.event_key]}.\n\nTeam: ${row.team_name}\nGame date: ${row.game_date}\n\nSign in to see the details: ${publicUrl('/submissions')}`,
    });
    if (!r.ok) errors.push(r.error || `HTTP ${r.status}`);
  }
  db.prepare('UPDATE cmd_notifications SET email_status = ?, email_error = ? WHERE id = ?')
    .run(errors.length ? 'failed' : 'sent', errors.join(' | ').slice(0, 500), notificationId);
}

// ── Intake-stage notifications (customer footage submission §6) ─────────
// Receipt, action required and processing complete happen before any job
// exists; job-stage events (analysis started, metrics ready, full game record
// in progress/complete, paid metric unavailable) come from emitJobEvent above.
export const INTAKE_EVENT_KEYS = ['submission_received', 'action_required', 'processing_complete', 'submission_closed'];

const INTAKE_TEMPLATES = {
  submission_received: p => ({
    subject: `We received your footage — ${p.public_id}`,
    text: `Thanks — we received submission ${p.public_id}.\n\nOur team will review it and contact you with next steps. You can check its status any time at ${p.url}.`,
  }),
  action_required: p => ({
    subject: `Action needed on submission ${p.public_id}`,
    text: `We need something from you to continue with submission ${p.public_id}:\n\n${p.message}\n\nReply or upload what we need at ${p.url}.`,
  }),
  processing_complete: p => ({
    subject: `Your footage has been checked — ${p.public_id}`,
    text: `We finished checking the footage for submission ${p.public_id}.${p.attention ? `\n\nSomething needs your attention — see ${p.url}.` : `\n\nWe'll be in touch with next steps. Status: ${p.url}`}`,
  }),
  submission_closed: p => ({
    subject: `Submission ${p.public_id} is closed`,
    text: `Submission ${p.public_id} is now closed.${p.message ? `\n\n${p.message}` : ''}\n\nDetails: ${p.url}`,
  }),
};

export function emitIntakeNotification(db, { submissionId, eventKey, payload = {} }) {
  if (!INTAKE_EVENT_KEYS.includes(eventKey)) throw new Error(`Unknown intake notification: ${eventKey}`);
  const sub = db.prepare(
    `SELECT s.id, s.public_id, s.synthetic, s.account_id, a.email, a.is_test, a.status AS account_status
       FROM intake_submissions s JOIN customer_accounts a ON a.id = s.account_id WHERE s.id = ?`
  ).get(submissionId);
  if (!sub) throw new Error('Unknown submission');
  const rights = db.prepare('SELECT contact_permission FROM intake_rights WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(submissionId);
  const full = { public_id: sub.public_id, url: publicUrl(`/submissions/${sub.public_id}`), ...payload };
  const status = sub.synthetic || sub.is_test ? 'suppressed_synthetic'
    : sub.account_status !== 'active' || !rights?.contact_permission ? 'no_permission'
      : emailConfigured() ? 'queued' : 'skipped';
  const id = db.prepare(
    'INSERT INTO intake_notifications (submission_id, account_id, event_key, payload, email_status) VALUES (?, ?, ?, ?, ?)'
  ).run(sub.id, sub.account_id, eventKey, JSON.stringify(payload), status).lastInsertRowid;
  if (status === 'queued') {
    const { subject, text } = INTAKE_TEMPLATES[eventKey](full);
    sendEmail({ to: sub.email, subject, text }).then(r => {
      db.prepare('UPDATE intake_notifications SET email_status = ?, email_error = ? WHERE id = ?').run(r.ok ? 'sent' : 'failed', r.ok ? '' : String(r.error || '').slice(0, 500), id);
    }).catch(() => {});
  }
  return id;
}

// Account email (verification, password reset). The link carries a secret, so
// it is never stored; without a provider it is logged in development only —
// production falls back to staff verification (owner decision 2026-10-01).
export async function sendAccountEmail(db, { account, kind, url }) {
  const templates = {
    verify_email: {
      subject: 'Confirm your email for Diamond Metrics',
      text: `Hi ${account.first_name || 'there'},\n\nConfirm your email address to finish submitting footage to Diamond Metrics:\n\n${url}\n\nThe link expires in 48 hours. If you didn't create an account, you can ignore this email.`,
    },
    reset_password: {
      subject: 'Reset your Diamond Metrics password',
      text: `Hi ${account.first_name || 'there'},\n\nUse this link to choose a new password:\n\n${url}\n\nThe link expires in 1 hour. If you didn't ask to reset your password, you can ignore this email.`,
    },
  }[kind];
  if (!templates) throw new Error(`Unknown account email: ${kind}`);
  const record = (status, error = '') => db.prepare(
    'INSERT INTO intake_notifications (account_id, event_key, payload, email_status, email_error) VALUES (?, ?, ?, ?, ?)'
  ).run(account.id, kind, '{}', status, error);
  if (!emailConfigured()) {
    record('skipped');
    if (ENV !== 'production') log('info', 'customer_email_link', { kind, email: account.email, url });
    return { delivered: false };
  }
  const r = await sendEmail({ to: account.email, ...templates });
  record(r.ok ? 'sent' : 'failed', r.ok ? '' : String(r.error || '').slice(0, 500));
  return { delivered: r.ok };
}
