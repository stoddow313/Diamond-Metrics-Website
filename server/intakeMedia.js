// Technical check of customer uploads as soon as they land (customer footage
// submission §6 "Technical validation"): resolution, frame rate, orientation,
// duration, codec, corruption. Probe only — the constant-frame-rate review
// proxy is made when the file becomes a Command feed, so a declined or
// duplicate submission never costs an encode.
//
// The customer sees plain-language findings; the raw probe output stays in
// internal diagnostics (§6 "keep detailed diagnostics internal").
import { probeFile } from './mediaWorker.js';
import { gatewayUrlFor } from './mediaGateway.js';
import { captureIssues, safeJson } from './intakeLogic.js';
import { addEvent } from './intakeStore.js';
import { emitIntakeNotification } from './notifications.js';
import { log, captureError } from './observability.js';

export const MAX_PROBE_ATTEMPTS = 3;
// ffprobe errors that mean the file itself is broken; retrying cannot help.
const PERMANENT = /invalid data|moov atom not found|could not find codec|no such file|end of file|not a video|unsupported/i;

const IN_FLIGHT = "('uploading', 'paused', 'uploaded', 'processing')";

export async function probeIntakeFile(db, file, { probe = probeFile, sourceUrl = gatewayUrlFor } = {}) {
  const claimed = db.prepare(
    "UPDATE intake_files SET status = 'processing', probe_attempts = probe_attempts + 1, updated_at = datetime('now') WHERE id = ? AND status = 'uploaded'"
  ).run(file.id);
  if (claimed.changes === 0) return 'skipped';
  const attempt = file.probe_attempts + 1;
  const sub = db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(file.submission_id);
  const ctx = safeJson(sub.footage_context);

  let meta = null;
  let diagnostic = '';
  try {
    meta = await probe(await sourceUrl(file.storage_key));
  } catch (err) {
    diagnostic = String(err?.stderr || err?.message || err).trim().slice(-500);
  }
  if (!meta && attempt < MAX_PROBE_ATTEMPTS && !PERMANENT.test(diagnostic)) {
    db.prepare("UPDATE intake_files SET status = 'uploaded', diagnostics = ?, updated_at = datetime('now') WHERE id = ?")
      .run(`probe attempt ${attempt} failed: ${diagnostic}`, file.id);
    log('warn', 'intake_probe_retry', { file_id: file.id, attempt, diagnostic });
    return 'retry';
  }

  const merged = { ...file, ...(meta || { width: null, height: null, duration_s: null }) };
  const issues = captureIssues(merged, {
    packageKey: sub.package_key || 'rookie',
    fullGame: ctx.coverage === 'full' ? true : ctx.coverage === 'clips' ? false : null,
  });
  const unreadable = issues.some(i => i.severity === 'action');
  const diag = meta
    ? `probed ${meta.codec || '?'} ${meta.width}x${meta.height} rot ${meta.rotation || 0} @ ${meta.effective_fps ? meta.effective_fps.toFixed(3) : '?'} fps (nominal ${meta.nominal_fps ? meta.nominal_fps.toFixed(3) : '?'})${meta.vfr ? ' VFR' : ''}, ${meta.duration_s ? `${meta.duration_s.toFixed(1)} s` : 'no duration'}`
    : `unreadable after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${diagnostic || 'no output'}`;
  db.prepare(
    `UPDATE intake_files SET status = ?, duration_s = ?, codec = ?, width = ?, height = ?, rotation = ?, nominal_fps = ?, effective_fps = ?, vfr = ?,
            issues = ?, diagnostics = ?, processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(unreadable ? 'needs_customer_action' : 'ready', meta?.duration_s ?? null, meta?.codec || '', meta?.width ?? null, meta?.height ?? null,
    meta?.rotation ?? 0, meta?.nominal_fps ?? null, meta?.effective_fps ?? null, meta?.vfr ?? 0, JSON.stringify(issues), diag, file.id);

  const notes = issues.filter(i => i.severity !== 'tip').length;
  addEvent(db, {
    submissionId: sub.id, accountId: file.account_id, actorKind: 'system', type: 'file_checked', visibility: 'customer',
    message: unreadable ? `We could not read ${file.original_name}` : `Checked ${file.original_name}${notes ? ` — ${notes} note${notes === 1 ? '' : 's'}` : ''}`,
    data: { file_id: file.id, status: unreadable ? 'needs_customer_action' : 'ready', issue_codes: issues.map(i => i.code) },
  });
  log('info', 'intake_probe_finished', { file_id: file.id, unreadable, issues: issues.map(i => i.code) });

  // Processing-complete is a customer message about a submitted request;
  // drafts show the same state on screen while the customer is still there.
  if (sub.status !== 'draft') {
    const pending = db.prepare(`SELECT COUNT(*) n FROM intake_files WHERE submission_id = ? AND kind = 'video' AND status IN ${IN_FLIGHT}`).get(sub.id).n;
    if (pending === 0) {
      const attention = db.prepare("SELECT COUNT(*) n FROM intake_files WHERE submission_id = ? AND status = 'needs_customer_action'").get(sub.id).n > 0;
      emitIntakeNotification(db, { submissionId: sub.id, eventKey: 'processing_complete', payload: { attention } });
    }
  }
  return unreadable ? 'needs_customer_action' : 'ready';
}

export async function drainIntakeProbes(db, opts = {}) {
  // Each file is tried at most once per pass, so a transient failure waits for
  // the next tick instead of spinning.
  const ids = db.prepare("SELECT id FROM intake_files WHERE kind = 'video' AND status = 'uploaded' ORDER BY updated_at, id LIMIT 20").all().map(r => r.id);
  const outcomes = [];
  for (const id of ids) {
    const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(id);
    if (file?.status === 'uploaded') outcomes.push(await probeIntakeFile(db, file, opts));
  }
  return outcomes;
}

export function startIntakeProber(db, { intervalMs = 4000 } = {}) {
  // A probe interrupted by a restart goes back in the queue.
  const recovered = db.prepare("UPDATE intake_files SET status = 'uploaded' WHERE status = 'processing'").run().changes;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await drainIntakeProbes(db); }
    catch (err) { captureError(err, { event: 'intake_probe_failed', component: 'intake_prober' }); }
    finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  log('info', 'intake_prober_started', { interval_ms: intervalMs, recovered });
  return timer;
}
