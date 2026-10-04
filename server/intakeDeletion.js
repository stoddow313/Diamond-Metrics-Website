// Deletion and revocation (customer footage submission §10): a controlled
// workflow that identifies everything a request touches — the account, its
// submissions and files, the Command feeds and derived copies made from them,
// the evidence and published values that cite them, public profile
// visibility, and the retention exceptions — then executes only the actions an
// admin approved, recording each step's outcome and an audit event.
import { deleteObject, abortUpload } from './storage.js';
import { addEvent, getAccount, latestRights } from './intakeStore.js';
import { safeJson } from './intakeLogic.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export const DELETION_ACTIONS = {
  delete_media: 'Delete the uploaded files and every copy made from them (review proxies, thumbnails, clips)',
  revoke_consent: 'Record the footage terms as revoked — no further use, no further contact',
  hide_profiles: 'Make the account holder’s athletes’ public profiles private',
  close_account: 'Close the account and remove its personal details',
};
export const DELETION_REASONS = ['customer_request', 'consent_revoked', 'retention_expired', 'other'];

function scopeOf(db, request) {
  let subs = [];
  let files = [];
  if (request.scope === 'account') {
    subs = db.prepare('SELECT * FROM intake_submissions WHERE account_id = ?').all(request.target_id);
  } else if (request.scope === 'submission') {
    subs = db.prepare('SELECT * FROM intake_submissions WHERE id = ?').all(request.target_id);
  } else if (request.scope === 'file') {
    files = db.prepare('SELECT * FROM intake_files WHERE id = ?').all(request.target_id);
    subs = files.length ? db.prepare('SELECT * FROM intake_submissions WHERE id = ?').all(files[0].submission_id) : [];
  }
  if (request.scope !== 'file') files = subs.flatMap(s => db.prepare('SELECT * FROM intake_files WHERE submission_id = ?').all(s.id));
  return { subs, files };
}

export function deletionInventory(db, request) {
  const { subs, files } = scopeOf(db, request);
  const accountId = request.scope === 'account' ? request.target_id : request.account_id ?? subs[0]?.account_id;
  const account = accountId ? getAccount(db, accountId) : null;
  // Every Command feed made from these files, plus any other feed that points
  // at the same stored object (an analyst may have registered it again).
  const feedIds = new Set(files.map(f => f.feed_id).filter(Boolean));
  for (const f of files) {
    if (!f.storage_key) continue;
    for (const r of db.prepare('SELECT id FROM cmd_video_feeds WHERE storage_key = ?').all(f.storage_key)) feedIds.add(r.id);
  }
  const feeds = [...feedIds].map(id => db.prepare('SELECT id, job_id, label, status, storage_key FROM cmd_video_feeds WHERE id = ?').get(id)).filter(Boolean);
  const renditions = feeds.flatMap(fd => db.prepare('SELECT id, feed_id, kind, storage_key FROM cmd_media_renditions WHERE feed_id = ?').all(fd.id));
  const jobIds = [...new Set([...subs.map(s => s.job_id).filter(Boolean), ...feeds.map(f => f.job_id)])];
  const jobs = jobIds.map(id => db.prepare(
    `SELECT j.id, j.game_date, j.metric_release_status, j.game_record_status, t.name AS team_name, o.synthetic
       FROM cmd_jobs j JOIN teams t ON t.id = j.team_id JOIN cmd_orders o ON o.id = j.order_id WHERE j.id = ?`
  ).get(id)).filter(Boolean);
  const evidence = feeds.length ? db.prepare(
    `SELECT r.id, r.job_id, r.metric_code, r.status, r.player_id FROM cmd_metric_results r
       JOIN cmd_measurements m ON r.evidence_kind = 'measurement' AND m.id = r.evidence_id
       JOIN cmd_media_renditions rr ON rr.id = m.rendition_id
      WHERE rr.feed_id IN (${feeds.map(() => '?').join(',')}) AND r.superseded_by IS NULL`
  ).all(...feeds.map(f => f.id)) : [];
  const owned = account ? db.prepare(
    `SELECT ca.player_id, p.first_name, p.last_name, p.is_public, p.slug FROM customer_athletes ca JOIN players p ON p.id = ca.player_id WHERE ca.account_id = ?`
  ).all(account.id) : [];
  const inScope = request.scope === 'account' ? owned
    : owned.filter(p => subs.some(s => db.prepare('SELECT 1 FROM intake_athletes WHERE submission_id = ? AND player_id = ?').get(s.id, p.player_id)));
  const published = evidence.filter(r => r.status === 'published');
  const exceptions = [];
  if (published.length) exceptions.push(`${published.length} published result${published.length === 1 ? ' was' : 's were'} measured from this footage. Deleting the media keeps those values (the frames and timestamps stay as evidence) unless they are withdrawn in Command.`);
  if (jobs.some(j => j.metric_release_status !== 'released')) exceptions.push('A linked Command job is still in analysis — deleting the media stops that work.');
  if (feeds.some(f => !files.some(x => x.feed_id === f.id))) exceptions.push('An analyst registered the same file on another job; it is included so no copy survives.');
  return {
    account: account ? {
      id: account.id, email: account.email, name: `${account.first_name} ${account.last_name}`.trim(), status: account.status,
      sessions: db.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE account_id = ?').get(account.id).n,
    } : null,
    submissions: subs.map(s => ({ id: s.id, public_id: s.public_id, status: s.status, job_id: s.job_id })),
    files: files.map(f => ({ id: f.id, submission_id: f.submission_id, kind: f.kind, original_name: f.original_name, size_bytes: f.size_bytes, status: f.status, storage_key: f.storage_key, feed_id: f.feed_id, retention_deadline: f.retention_deadline })),
    feeds, renditions, jobs,
    evidence: { results: evidence.length, published: published.length },
    athletes: inScope.map(p => ({ player_id: p.player_id, name: `${p.first_name} ${p.last_name}`, is_public: !!p.is_public })),
    public_profiles: inScope.filter(p => p.is_public).map(p => ({ player_id: p.player_id, name: `${p.first_name} ${p.last_name}`, slug: p.slug })),
    retention_exceptions: exceptions,
  };
}

export function createStaffDeletionRequest(db, { scope, target_id, reason = 'other', note = '' }, actor) {
  if (!['account', 'submission', 'file'].includes(scope)) fail('scope must be account, submission or file');
  if (!DELETION_REASONS.includes(reason)) fail(`reason must be one of ${DELETION_REASONS.join(', ')}`);
  const target = Number(target_id);
  const accountId = scope === 'account' ? db.prepare('SELECT id FROM customer_accounts WHERE id = ?').get(target)?.id
    : scope === 'submission' ? db.prepare('SELECT account_id FROM intake_submissions WHERE id = ?').get(target)?.account_id
      : db.prepare('SELECT account_id FROM intake_files WHERE id = ?').get(target)?.account_id;
  if (!accountId) fail('Target not found', 404);
  const open = db.prepare("SELECT * FROM intake_deletion_requests WHERE scope = ? AND target_id = ? AND status = 'open'").get(scope, target);
  if (open) return open;
  const id = db.prepare(
    `INSERT INTO intake_deletion_requests (scope, target_id, account_id, requested_by_kind, requested_by_id, reason, note) VALUES (?, ?, ?, 'staff', ?, ?, ?)`
  ).run(scope, target, accountId, actor.id, reason, String(note || '').slice(0, 1000)).lastInsertRowid;
  const subId = scope === 'submission' ? target : scope === 'file' ? db.prepare('SELECT submission_id FROM intake_files WHERE id = ?').get(target).submission_id : null;
  addEvent(db, { submissionId: subId, accountId, actorKind: 'staff', actorId: actor.id, type: 'deletion_request_opened', message: `${reason.replace(/_/g, ' ')} — ${scope}${note ? `: ${note}` : ''}`, data: { request_id: id } });
  return db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(id);
}

export async function executeDeletion(db, request, { actions = [], note = '' } = {}, actor) {
  if (request.status !== 'open') fail('This request has already been decided.', 409);
  const chosen = [...new Set(actions)];
  if (!chosen.length) fail('Choose at least one action.');
  for (const a of chosen) if (!DELETION_ACTIONS[a]) fail(`Unknown action: ${a}`);
  if (chosen.includes('close_account') && request.scope !== 'account') fail('Closing the account needs an account-scope request.');
  const inventory = deletionInventory(db, request);
  const { subs, files } = scopeOf(db, request);
  const steps = [];
  const step = (action, target, ok, detail = '') => steps.push({ action, target, ok, detail });

  if (chosen.includes('delete_media')) {
    for (const f of files.filter(x => x.status !== 'deleted')) {
      try {
        if (['uploading', 'paused'].includes(f.status) && f.upload_id) await abortUpload(f.storage_key, f.upload_id);
        else if (f.storage_key) await deleteObject(f.storage_key);
        db.prepare("UPDATE intake_files SET status = 'deleted', upload_id = NULL, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(f.id);
        step('delete_media', `file ${f.id} (${f.original_name})`, true);
      } catch (err) { step('delete_media', `file ${f.id}`, false, String(err.message || err)); }
    }
    for (const r of inventory.renditions) {
      try { await deleteObject(r.storage_key); step('delete_media', `rendition ${r.id} (${r.kind})`, true); }
      catch (err) { step('delete_media', `rendition ${r.id}`, false, String(err.message || err)); }
    }
    for (const fd of inventory.feeds) {
      try { if (fd.storage_key) await deleteObject(fd.storage_key); } catch { /* the intake file step already reported it */ }
      db.prepare("UPDATE cmd_media_jobs SET status = 'failed', error = 'media deleted under a deletion request' WHERE feed_id = ? AND status IN ('queued', 'running')").run(fd.id);
      db.prepare("UPDATE cmd_video_feeds SET status = 'deleted', error = ?, updated_at = datetime('now') WHERE id = ?").run(`Media deleted under deletion request #${request.id}`, fd.id);
      db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'media_deleted', ?)")
        .run(fd.job_id, actor.id, `feed ${fd.id} (${fd.label}) — deletion request #${request.id}`);
      step('delete_media', `Command feed ${fd.id} on job ${fd.job_id}`, true);
    }
  }

  if (chosen.includes('revoke_consent')) {
    for (const s of subs) {
      const r = latestRights(db, s.id);
      if (!r || r.action === 'revoke') continue;
      db.prepare(
        `INSERT INTO intake_rights (submission_id, account_id, action, supersedes_id, policy_key, policy_version, policy_hash, pending_legal,
                                    relationship, attestation, permitted_uses, contact_permission, retention_ack, retention_days, retention_deadline,
                                    restrictions, athlete_ids, guide_version, guide_ack, actor_kind, actor_id)
         VALUES (?, ?, 'revoke', ?, ?, ?, ?, ?, ?, '', ?, 0, 0, ?, ?, ?, ?, ?, 0, 'staff', ?)`
      ).run(s.id, s.account_id, r.id, r.policy_key, r.policy_version, r.policy_hash, r.pending_legal, r.relationship,
        JSON.stringify(Object.fromEntries(Object.keys(safeJson(r.permitted_uses)).map(k => [k, false]))),
        r.retention_days, r.retention_deadline, `revoked under deletion request #${request.id}`, r.athlete_ids, r.guide_version, actor.id);
      step('revoke_consent', `submission ${s.public_id}`, true);
    }
  }

  if (chosen.includes('hide_profiles')) {
    for (const p of inventory.public_profiles) {
      db.prepare("UPDATE players SET is_public = 0, updated_at = datetime('now') WHERE id = ?").run(p.player_id);
      step('hide_profiles', `player ${p.player_id} (${p.name})`, true);
    }
  }

  if (chosen.includes('close_account') && inventory.account) {
    const id = inventory.account.id;
    db.transaction(() => {
      db.prepare(
        `UPDATE customer_accounts SET email = ?, first_name = 'Deleted', last_name = 'account', phone = '', phone_normalized = '', organization = '',
                password_hash = NULL, status = 'closed', staff_user_id = NULL, player_user_id = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(`deleted-${id}@deleted.invalid`, id);
      db.prepare('DELETE FROM customer_sessions WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM customer_tokens WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM customer_athletes WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM customer_team_links WHERE account_id = ?').run(id);
      db.prepare(
        "UPDATE intake_submissions SET status = 'closed', close_reason = 'account_deleted', closed_at = datetime('now'), updated_at = datetime('now') WHERE account_id = ? AND status NOT IN ('closed', 'declined')"
      ).run(id);
      // What the customer wrote is redacted; the shape of the history stays.
      db.prepare(`UPDATE intake_events SET message = '[redacted]', data = '{"redacted":true}' WHERE account_id = ? AND actor_kind = 'customer' AND message != '[redacted]'`).run(id);
    })();
    step('close_account', `account ${id}`, true);
  }

  const failed = steps.filter(s => !s.ok);
  db.prepare(
    `UPDATE intake_deletion_requests SET status = ?, actions = ?, inventory = ?, result = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`
  ).run(failed.length ? 'open' : 'completed', JSON.stringify(chosen), JSON.stringify(inventory), JSON.stringify({ steps }), actor.id, String(note || '').slice(0, 1000), request.id);
  for (const s of subs) {
    addEvent(db, {
      submissionId: s.id, accountId: s.account_id, actorKind: 'staff', actorId: actor.id, type: failed.length ? 'deletion_partial' : 'deletion_executed',
      visibility: failed.length ? 'internal' : 'customer',
      message: failed.length ? `Deletion request #${request.id}: ${failed.length} step${failed.length === 1 ? '' : 's'} failed — retry from the request` : 'Your deletion request has been completed.',
      data: { request_id: request.id, actions: chosen, failed: failed.length },
    });
  }
  if (!subs.length && inventory.account) {
    addEvent(db, { accountId: inventory.account.id, actorKind: 'staff', actorId: actor.id, type: 'deletion_executed', message: `Deletion request #${request.id}`, data: { request_id: request.id, actions: chosen } });
  }
  return { request: db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(request.id), steps };
}

export function declineDeletion(db, request, { note = '' } = {}, actor) {
  if (request.status !== 'open') fail('This request has already been decided.', 409);
  if (!String(note || '').trim()) fail('Record why the request is declined.');
  db.prepare("UPDATE intake_deletion_requests SET status = 'declined', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?")
    .run(actor.id, String(note).slice(0, 1000), request.id);
  const subId = request.scope === 'submission' ? request.target_id : null;
  addEvent(db, { submissionId: subId, accountId: request.account_id, actorKind: 'staff', actorId: actor.id, type: 'deletion_declined', message: String(note).slice(0, 1000), data: { request_id: request.id } });
  return db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(request.id);
}

// Files past their explicit deletion date (§6 Retention). Nothing deletes on
// its own in this release: staff open a retention_expired request from here.
export function retentionDue(db) {
  return db.prepare(
    `SELECT f.id, f.original_name, f.kind, f.retention_deadline, f.status, f.feed_id, s.id AS submission_id, s.public_id, a.email
       FROM intake_files f JOIN intake_submissions s ON s.id = f.submission_id JOIN customer_accounts a ON a.id = f.account_id
      WHERE f.status != 'deleted' AND f.retention_deadline IS NOT NULL AND f.retention_deadline <= datetime('now')
      ORDER BY f.retention_deadline`
  ).all();
}
