// Customer/internal notification events (Phase 1, owner-directed). The
// cmd_notifications row IS the audit record; email dispatch is an adapter
// that activates via env (RESEND_API_KEY + DM_EMAIL_FROM) with no workflow
// changes. Provider recommendation: Resend (TDR §3).
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

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.DM_EMAIL_FROM);
}

// What is missing for customer email to work — shown on /command/ops so the
// setup gap is explicit instead of a silent 'skipped'.
export function emailMissingConfig() {
  return ['RESEND_API_KEY', 'DM_EMAIL_FROM'].filter(k => !process.env[k]);
}

// Operator-triggered test send through the exact path customers get, with
// the provider's raw response — the only way to prove DNS/domain
// verification is right before a real order depends on it.
export async function sendTestEmail(to, { env = 'production' } = {}) {
  if (!emailConfigured()) return { ok: false, error: `Email is not configured — set ${emailMissingConfig().join(' and ')} in Render and restart` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: false, error: 'A valid recipient address is required' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.DM_EMAIL_FROM,
        to: [to],
        subject: `Diamond Metrics — transactional email test (${env})`,
        text: `This is a test of Diamond Metrics customer email from the ${env} environment, sent ${new Date().toISOString()}.\n\nIf you received it, the sending domain and API key are working.`,
      }),
    });
    const body = (await res.text().catch(() => '')).slice(0, 600);
    return { ok: res.ok, status: res.status, from: process.env.DM_EMAIL_FROM, to, provider_response: body };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function dispatchEmail(db, notificationId) {
  const row = db.prepare(
    `SELECT n.*, o.contact_email, t.name AS team_name, j.game_date
     FROM cmd_notifications n
     JOIN cmd_jobs j ON j.id = n.job_id
     JOIN cmd_orders o ON o.id = j.order_id
     JOIN teams t ON t.id = j.team_id
     WHERE n.id = ?`
  ).get(notificationId);
  if (!row || !row.contact_email) {
    db.prepare("UPDATE cmd_notifications SET email_status = 'skipped' WHERE id = ?").run(notificationId);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.DM_EMAIL_FROM,
        to: [row.contact_email],
        subject: `${EVENT_SUBJECTS[row.event_key]} — ${row.team_name} ${row.game_date}`,
        text: `${EVENT_SUBJECTS[row.event_key]}.\n\nTeam: ${row.team_name}\nGame date: ${row.game_date}\n\nSign in to Diamond Metrics for details.`,
      }),
    });
    const detail = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 500);
    db.prepare('UPDATE cmd_notifications SET email_status = ?, email_error = ? WHERE id = ?')
      .run(res.ok ? 'sent' : 'failed', detail, notificationId);
  } catch (err) {
    db.prepare("UPDATE cmd_notifications SET email_status = 'failed', email_error = ? WHERE id = ?").run(String(err?.message || err).slice(0, 500), notificationId);
  }
}
