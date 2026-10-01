// Customer-side intake operations (customer footage submission §3–§6): the
// draft that survives sign-out and refresh, the rights record, resumable
// uploads on the same direct-to-storage path Command uses, submission, and
// the allowlisted view a customer is allowed to see.
import {
  ROLES, RELATIONSHIPS, CAMERA_VIEWS, FILE_KINDS, INTAKE_PACKAGES, PACKAGE_KEYS, GUIDE_VERSION,
  rightsTerms, policyHash, retentionDays, newPublicId, isoDate, safeJson, submitReadiness,
  customerStatus, CUSTOMER_FILE_STATUS, captureIssues, submissionCaptureNotes, plainReason, TRUST_LABELS,
} from './intakeLogic.js';
import { addEvent, latestRights, verifiedAthletes, verifiedTeams, settingValue } from './intakeStore.js';
import { emitIntakeNotification } from './notifications.js';
import {
  createUpload, presignPart, putLocalPart, completeUpload, abortUpload, listUploadedParts, deleteObject,
  storageMode, storageReady, missingStorageConfig,
} from './storage.js';
import { rollupForMetricCode } from './metricRelease.js';
import { METRICS } from './metricCatalog.js';
import { ENV, log } from './observability.js';

export const PART_SIZE = 50 * 1024 * 1024;   // same 50 MB parts as Command uploads
const TRIAGE_HOURS = () => Number(process.env.DM_INTAKE_TRIAGE_HOURS) > 0 ? Number(process.env.DM_INTAKE_TRIAGE_HOURS) : 24;

const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function findSubmission(db, publicId, accountId) {
  const sub = db.prepare('SELECT * FROM intake_submissions WHERE public_id = ? AND account_id = ?').get(String(publicId || ''), accountId);
  if (!sub) fail('Submission not found', 404);   // 404, not 403: never confirm another customer's submission exists
  return sub;
}

export function findOwnFile(db, fileId, accountId) {
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ? AND account_id = ?').get(Number(fileId), accountId);
  if (!file) fail('File not found', 404);
  return file;
}

const filesOf = (db, subId) => db.prepare('SELECT * FROM intake_files WHERE submission_id = ? ORDER BY id').all(subId);
// Supporting files staff sent into the job (radar queue, game-record source).
const importedFileIds = (db, subId) => new Set(db.prepare(
  "SELECT json_extract(data, '$.file_id') AS fid FROM intake_events WHERE submission_id = ? AND event_type = 'supporting_imported'"
).all(subId).map(r => Number(r.fid)));
const athletesOf = (db, subId) => db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ? ORDER BY id').all(subId);

// ── Drafts ───────────────────────────────────────────────────────────────
export function createDraft(db, account, params = {}) {
  const source = str(params.source_page, 120);
  const sourceParams = {};
  for (const [k, v] of Object.entries(params.source_params || {}).slice(0, 12)) sourceParams[str(k, 40)] = str(v, 200);
  const packageKey = PACKAGE_KEYS.includes(params.package_key) ? params.package_key : '';
  const form = {
    role: ROLES[account.role] ? account.role : '',
    athletes: [],
    game: {},
    service: { package_key: packageKey, order_reference: str(params.order_reference, 80), requested_metrics: '' },
    footage: {},
  };
  // A "Submit footage for my player" link carries the player. Only one of the
  // account's staff-verified athletes is pre-linked; a public profile's name
  // is pre-filled as a new candidate; anything else is ignored (minors).
  if (params.player_slug) {
    const p = db.prepare('SELECT id, first_name, last_name, is_public FROM players WHERE slug = ?').get(str(params.player_slug, 120));
    const mine = p && verifiedAthletes(db, account.id).find(a => a.player_id === p.id);
    if (mine) form.athletes.push({ player_id: p.id, first_name: p.first_name, last_name: p.last_name, relationship: mine.relationship === 'invite_claim' ? '' : mine.relationship });
    else if (p?.is_public) form.athletes.push({ first_name: p.first_name, last_name: p.last_name, relationship: '' });
  }
  const normalized = normalizeForm(db, account, form);
  let publicId;
  for (let i = 0; i < 8; i++) {
    publicId = newPublicId();
    if (!db.prepare('SELECT 1 FROM intake_submissions WHERE public_id = ?').get(publicId)) break;
  }
  const id = db.prepare(
    `INSERT INTO intake_submissions (public_id, account_id, kind, status, step, form, submitter_role, source_page, source_params, package_key, order_reference, synthetic)
     VALUES (?, ?, ?, 'draft', 'role', ?, ?, ?, ?, ?, ?, ?)`
  ).run(publicId, account.id, packageKey === 'hall_of_fame' ? 'inquiry' : 'footage', JSON.stringify(normalized), normalized.role,
    source, JSON.stringify(sourceParams), packageKey, normalized.service.order_reference, account.is_test ? 1 : 0).lastInsertRowid;
  syncDraftAthletes(db, id, account, normalized.athletes);
  addEvent(db, { submissionId: id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'draft_started', message: source ? `Started from ${source}` : 'Started', data: { source_page: source, source_params: sourceParams, package_key: packageKey } });
  return db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(id);
}

// Normalize the draft form. Unknown keys are dropped; references to players
// or teams are kept only when they are the account's staff-verified links.
export function normalizeForm(db, account, raw = {}) {
  const mine = new Map(verifiedAthletes(db, account.id).map(a => [a.player_id, a]));
  const myTeams = new Set(verifiedTeams(db, account.id).map(t => t.team_id));
  const thisYear = new Date().getUTCFullYear();
  const athletes = (Array.isArray(raw.athletes) ? raw.athletes : []).slice(0, 40).map(a => {
    const pid = Number(a?.player_id);
    const linked = Number.isInteger(pid) && mine.has(pid) ? mine.get(pid) : null;
    const by = Number(a?.birth_year);
    return {
      player_id: linked ? pid : null,
      first_name: linked ? linked.first_name : str(a?.first_name, 60),
      last_name: linked ? linked.last_name : str(a?.last_name, 60),
      birth_year: Number.isInteger(by) && by >= 1960 && by <= thisYear ? by : null,
      age_band: str(a?.age_band, 20),
      team_label: str(a?.team_label, 100),
      jersey: str(a?.jersey, 6).replace(/^#/, ''),
      relationship: RELATIONSHIPS[a?.relationship] ? a.relationship : '',
    };
  });
  const g = raw.game || {};
  const teamId = Number(g.team_id);
  const s = raw.service || {};
  const f = raw.footage || {};
  return {
    role: ROLES[raw.role] ? raw.role : '',
    athletes,
    game: {
      date: isoDate(g.date) || '',
      event_label: str(g.event_label, 120),
      no_event: !!g.no_event,
      team_label: str(g.team_label, 100),
      team_id: Number.isInteger(teamId) && myTeams.has(teamId) ? teamId : null,
      opponent_label: str(g.opponent_label, 100),
      location: str(g.location, 120),
      level: str(g.level, 40),
    },
    service: {
      package_key: PACKAGE_KEYS.includes(s.package_key) ? s.package_key : '',
      order_reference: str(s.order_reference, 80),
      requested_metrics: str(s.requested_metrics, 1000),
    },
    footage: {
      coverage: ['full', 'clips'].includes(f.coverage) ? f.coverage : '',
      orientation: ['landscape', 'portrait'].includes(f.orientation) ? f.orientation : '',
      known_resolution: str(f.known_resolution, 30),
      known_fps: str(f.known_fps, 20),
      key_plays: str(f.key_plays, 2000),
      side_angle: !!f.side_angle,
    },
  };
}

// Draft athletes are replaced wholesale on save — no staff decision exists
// on a draft yet, so nothing is lost.
function syncDraftAthletes(db, subId, account, athletes) {
  db.prepare('DELETE FROM intake_athletes WHERE submission_id = ?').run(subId);
  const ins = db.prepare(
    `INSERT INTO intake_athletes (submission_id, player_id, first_name, last_name, birth_year, age_band, team_label, jersey, relationship, resolution, resolution_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of athletes) {
    ins.run(subId, a.player_id, a.first_name, a.last_name, a.birth_year, a.age_band, a.team_label, a.jersey, a.relationship,
      a.player_id ? 'linked_existing' : 'pending', a.player_id ? 'staff-verified link on the account' : '');
  }
}

const STEPS = ['account', 'role', 'athletes', 'game', 'service', 'footage', 'terms', 'upload', 'review'];

export function saveDraft(db, sub, account, body = {}) {
  if (sub.status !== 'draft') fail('This submission was already sent. Use a message to tell us about any change.', 409);
  const form = normalizeForm(db, account, body.form || safeJson(sub.form));
  const step = STEPS.includes(body.step) ? body.step : sub.step;
  const packageKey = form.service.package_key;
  db.transaction(() => {
    db.prepare(
      `UPDATE intake_submissions SET step = ?, form = ?, submitter_role = ?, kind = ?, package_key = ?, order_reference = ?, requested_metrics = ?,
              game_date = ?, event_label = ?, team_label = ?, opponent_label = ?, location = ?, level = ?, footage_context = ?, team_id = ?,
              updated_at = datetime('now'), last_activity_at = datetime('now')
        WHERE id = ?`
    ).run(step, JSON.stringify(form), form.role, packageKey === 'hall_of_fame' ? 'inquiry' : 'footage', packageKey,
      form.service.order_reference, form.service.requested_metrics, form.game.date || null, form.game.event_label,
      form.game.team_label, form.game.opponent_label, form.game.location, form.game.level,
      JSON.stringify({ ...form.footage, no_event: form.game.no_event }), form.game.team_id, sub.id);
    syncDraftAthletes(db, sub.id, account, form.athletes);
  })();
  return db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(sub.id);
}

// ── Rights and consent ───────────────────────────────────────────────────
export function acceptRights(db, sub, account, body = {}, meta = {}) {
  if (sub.status !== 'draft') fail('The terms for this submission were already accepted.', 409);
  const role = sub.submitter_role;
  const terms = rightsTerms({ role, retention: retentionDays() });
  const uses = body.uses || {};
  // The attestation is the uploader's own statement of authority — it has to
  // be affirmed, not just displayed.
  if (body.attest !== true) fail('Please confirm that you are authorized to submit this footage.');
  for (const u of terms.uses) if (u.required && uses[u.key] !== true) fail(`Please accept: “${u.text}”`);
  if (body.retention_ack !== true) fail('Please acknowledge how long footage is kept.');
  if (body.guide_ack !== true) fail('Please confirm you have read the filming guide.');
  const athletes = athletesOf(db, sub.id).map(a => ({ id: a.id, first_name: a.first_name, last_name: a.last_name, birth_year: a.birth_year, relationship: a.relationship }));
  const prev = latestRights(db, sub.id);
  const permitted = Object.fromEntries(terms.uses.map(u => [u.key, uses[u.key] === true]));
  const days = retentionDays();
  const id = db.prepare(
    `INSERT INTO intake_rights (submission_id, account_id, action, supersedes_id, policy_key, policy_version, policy_hash, pending_legal,
                                relationship, attestation, permitted_uses, contact_permission, retention_ack, retention_days, retention_deadline,
                                restrictions, athlete_ids, guide_version, guide_ack, actor_kind, actor_id, ip, user_agent)
     VALUES (?, ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now', '+${days} days'), ?, ?, ?, 1, 'customer', ?, ?, ?)`
  ).run(sub.id, account.id, prev?.id ?? null, terms.key, terms.version, policyHash(terms), terms.pending_legal ? 1 : 0,
    role, terms.attestation, JSON.stringify(permitted), body.contact_permission === false ? 0 : 1, days,
    str(body.restrictions, 1000), JSON.stringify(athletes), GUIDE_VERSION,
    account.id, str(meta.ip, 80), str(meta.userAgent, 300)).lastInsertRowid;
  addEvent(db, {
    submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'rights_accepted', visibility: 'customer',
    message: `Footage terms accepted (version ${terms.version})`,
    data: { rights_id: id, version: terms.version, hash: policyHash(terms), pending_legal: terms.pending_legal, permitted_uses: permitted, contact_permission: body.contact_permission !== false },
  });
  return db.prepare('SELECT * FROM intake_rights WHERE id = ?').get(id);
}

// ── Files (direct resumable upload, §6) ──────────────────────────────────
const extOf = name => (String(name || '').match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
const ADDING_FILES = ['draft', 'needs_customer_action'];

function storageGuard() {
  if (!storageReady) fail(`Uploads are unavailable right now (storage is misconfigured: ${missingStorageConfig.join(', ')}). Please try again later.`, 503);
  if (storageMode !== 'r2' && ENV === 'production') fail('Uploads are unavailable right now. Please try again later.', 503);
}

export async function registerFile(db, sub, account, body = {}) {
  if (!ADDING_FILES.includes(sub.status)) fail('Files can only be added to a draft, or when we have asked you for more.', 409);
  if (sub.kind === 'inquiry') fail('Hall of Fame requests do not need an upload — we will plan the capture with you.', 409);
  const kind = FILE_KINDS[body.kind] ? body.kind : null;
  if (!kind) fail('Unknown file type');
  const name = str(body.original_name, 255);
  const size = Number(body.size_bytes);
  if (!name) fail('original_name is required');
  const spec = FILE_KINDS[kind];
  if (!spec.extensions.includes(extOf(name)) && !(kind === 'video' && String(body.mime_type || '').startsWith('video/'))) {
    fail(`“${name}” is not a supported ${spec.label.toLowerCase()} file. Supported: ${spec.extensions.join(' ')}`);
  }
  if (!(size > 0)) fail(`“${name}” is empty (0 bytes) — if it lives in iCloud or OneDrive, download it fully first.`);
  if (size > spec.maxBytes) fail(`“${name}” is larger than the ${(spec.maxBytes / 1024 ** 3 >= 1 ? `${spec.maxBytes / 1024 ** 3} GB` : `${spec.maxBytes / 1024 ** 2} MB`)} limit for this file type.`);
  const view = kind === 'video' ? body.camera_view : '';
  if (kind === 'video' && !CAMERA_VIEWS[view]) fail('Tell us which angle this video was filmed from.');
  const rights = latestRights(db, sub.id);
  if (!rights || rights.action !== 'grant') fail('Read the filming guide and accept the footage terms before uploading.', 409, { code: 'rights_required' });
  storageGuard();

  const hash = str(body.content_hash, 140);
  if (hash) {
    // Resume an interrupted transfer of this exact file in this submission.
    const same = db.prepare("SELECT * FROM intake_files WHERE submission_id = ? AND content_hash = ? AND size_bytes = ? AND status NOT IN ('deleted', 'archived')").get(sub.id, hash, size);
    if (same && ['uploading', 'paused'].includes(same.status)) {
      // R2 lists the parts it holds for the multipart session; the local
      // backend lists its numbered part files. Either way completed parts are
      // skipped, never re-sent.
      let uploaded;
      try { uploaded = await listUploadedParts(same.storage_key, same.upload_id); } catch { uploaded = null; }
      if (uploaded !== null) {
        db.prepare("UPDATE intake_files SET status = 'uploading', updated_at = datetime('now') WHERE id = ?").run(same.id);
        log('info', 'intake_upload_resumed', { file_id: same.id, submission: sub.public_id, parts_done: uploaded.length });
        return { file: db.prepare('SELECT * FROM intake_files WHERE id = ?').get(same.id), upload: { mode: storageMode, uploadId: same.upload_id, part_size: PART_SIZE, uploaded_parts: uploaded }, resumed: true };
      }
    }
    if (same) return { file: same, upload: null, duplicate: true, message: `“${same.original_name}” is already attached to this submission.` };
    // The same file on another of this customer's submissions: show it,
    // never attach a second copy. Another customer's copy is staff-visible only.
    const elsewhere = db.prepare(
      `SELECT f.*, s.public_id FROM intake_files f JOIN intake_submissions s ON s.id = f.submission_id
        WHERE f.account_id = ? AND f.content_hash = ? AND f.size_bytes = ? AND f.submission_id != ? AND f.status NOT IN ('deleted', 'archived')`
    ).get(account.id, hash, size, sub.id);
    if (elsewhere) return { file: null, upload: null, duplicate: true, elsewhere: elsewhere.public_id, message: `This file is already attached to your submission ${elsewhere.public_id}.` };
  }

  const id = db.prepare(
    `INSERT INTO intake_files (submission_id, account_id, kind, camera_view, label, original_name, size_bytes, mime_type, content_hash, status, rights_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)`
  ).run(sub.id, account.id, kind, view, str(body.label, 80) || (kind === 'video' ? CAMERA_VIEWS[view] : FILE_KINDS[kind].label),
    name, size, str(body.mime_type, 100), hash, rights.id).lastInsertRowid;
  // originals/ inherits the bucket's retention lifecycle as a backstop; the
  // explicit deletion date on the row is the policy (§6 Retention).
  const key = kind === 'video' ? `originals/intake/${id}/source${extOf(name) || '.mp4'}` : `intake/supporting/${id}/source${extOf(name)}`;
  db.prepare('UPDATE intake_files SET storage_key = ? WHERE id = ?').run(key, id);
  try {
    const session = await createUpload(key);
    db.prepare('UPDATE intake_files SET upload_id = ? WHERE id = ?').run(session.uploadId || null, id);
    addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'file_registered', message: `${FILE_KINDS[kind].label}: ${name}`, data: { file_id: id, size_bytes: size, camera_view: view } });
    log('info', 'intake_upload_started', { file_id: id, submission: sub.public_id, size, kind });
    return { file: db.prepare('SELECT * FROM intake_files WHERE id = ?').get(id), upload: { mode: session.mode, uploadId: session.uploadId || null, part_size: PART_SIZE } };
  } catch (err) {
    db.prepare("UPDATE intake_files SET status = 'deleted', deleted_at = datetime('now'), diagnostics = ? WHERE id = ?").run(`upload session failed: ${err.message}`.slice(0, 500), id);
    fail(`We could not start the upload: ${err.message}`, 502);
  }
}

const UPLOADING = ['uploading', 'paused'];

export async function presignFilePart(db, file, { uploadId, partNumber }) {
  if (!UPLOADING.includes(file.status)) fail('This file is not uploading.', 409);
  if (!uploadId || uploadId !== file.upload_id || !(Number(partNumber) >= 1)) fail('uploadId and partNumber are required and must match this upload', 400);
  db.prepare("UPDATE intake_files SET status = 'uploading', updated_at = datetime('now') WHERE id = ?").run(file.id);
  return presignPart(file.storage_key, uploadId, Number(partNumber));
}

export function appendFilePart(db, file, partNumber, chunk) {
  if (!UPLOADING.includes(file.status)) fail('This file is not uploading.', 409);
  if (storageMode !== 'local') fail('Direct part upload is local-dev only; use presigned parts');
  if (!(Number(partNumber) >= 1)) fail('partNumber must be 1 or more');
  putLocalPart(file.storage_key, Number(partNumber), chunk);
  db.prepare("UPDATE intake_files SET status = 'uploading', updated_at = datetime('now') WHERE id = ?").run(file.id);
}

export async function completeFile(db, file, { uploadId, parts = [] } = {}) {
  if (!UPLOADING.includes(file.status)) {
    if (['uploaded', 'processing', 'ready'].includes(file.status)) return file;   // idempotent: a retried complete
    fail('This file is not uploading.', 409);
  }
  await completeUpload(file.storage_key, uploadId || file.upload_id, parts);
  const rights = file.rights_id ? db.prepare('SELECT retention_days FROM intake_rights WHERE id = ?').get(file.rights_id) : null;
  const days = rights?.retention_days || retentionDays();
  db.prepare(
    `UPDATE intake_files SET status = ?, upload_id = NULL, uploaded_at = datetime('now'), retention_deadline = datetime('now', '+${days} days'), updated_at = datetime('now') WHERE id = ?`
  ).run(file.kind === 'video' ? 'uploaded' : 'ready', file.id);
  // A file sent in answer to a request is the customer acting — say so in
  // the queue's next action.
  db.prepare(
    "UPDATE intake_submissions SET next_action = 'Customer added a file — review it', updated_at = datetime('now') WHERE id = ? AND status = 'needs_customer_action'"
  ).run(file.submission_id);
  addEvent(db, { submissionId: file.submission_id, accountId: file.account_id, actorKind: 'customer', actorId: file.account_id, type: 'file_uploaded', visibility: 'customer', message: `Uploaded ${file.original_name}`, data: { file_id: file.id, parts: parts.length } });
  log('info', 'intake_upload_completed', { file_id: file.id, size: file.size_bytes, parts: parts.length });
  return db.prepare('SELECT * FROM intake_files WHERE id = ?').get(file.id);
}

export function pauseFile(db, file) {
  if (file.status === 'uploading') db.prepare("UPDATE intake_files SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(file.id);
  return db.prepare('SELECT * FROM intake_files WHERE id = ?').get(file.id);
}

// Removing a file from a draft (or one we asked to replace) deletes the stored
// object; the row stays as 'deleted' so the timeline still resolves.
export async function removeFile(db, sub, file, account) {
  if (!ADDING_FILES.includes(sub.status)) fail('Files on a submitted request can only be removed through a deletion request.', 409);
  if (file.feed_id || importedFileIds(db, sub.id).has(file.id)) fail('This file is already part of the analysis.', 409);
  if (UPLOADING.includes(file.status) && file.upload_id) await abortUpload(file.storage_key, file.upload_id).catch(() => {});
  else if (file.storage_key) await deleteObject(file.storage_key).catch(() => {});
  db.prepare("UPDATE intake_files SET status = 'deleted', upload_id = NULL, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(file.id);
  addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'file_removed', visibility: 'customer', message: `Removed ${file.original_name}`, data: { file_id: file.id } });
}

// ── Submit ───────────────────────────────────────────────────────────────
export function readiness(db, sub, account) {
  const missing = submitReadiness({ sub, account, athletes: athletesOf(db, sub.id), files: filesOf(db, sub.id), rights: latestRights(db, sub.id) });
  if (filesOf(db, sub.id).some(f => f.status === 'needs_customer_action')) missing.push({ code: 'file_action', text: 'Replace or remove the file we could not read.' });
  return missing;
}

function defaultOwner(db) {
  const id = Number(settingValue(db, 'intake_default_owner_id'));
  return Number.isInteger(id) && db.prepare('SELECT 1 FROM admins WHERE id = ? AND active = 1').get(id) ? id : null;
}

export function submitSubmission(db, sub, account) {
  if (sub.status !== 'draft') fail('This submission was already sent.', 409);
  const missing = readiness(db, sub, account);
  if (missing.length) fail(`Before you submit: ${missing.map(m => m.text).join(' ')}`, 400, { missing });
  const athletes = athletesOf(db, sub.id);
  const unresolved = athletes.some(a => a.resolution === 'pending');
  const status = sub.kind === 'inquiry' ? 'new' : unresolved ? 'needs_identity_review' : 'new';
  const nextAction = sub.kind === 'inquiry' ? 'Contact the customer to plan a Hall of Fame capture'
    : unresolved ? 'Resolve athlete identity' : 'Review the new submission';
  const owner = defaultOwner(db);
  db.transaction(() => {
    db.prepare(
      `UPDATE intake_submissions SET status = ?, owner_id = ?, next_action = ?, due_at = datetime('now', '+${TRIAGE_HOURS()} hours'),
              synthetic = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(status, owner, nextAction, sub.synthetic || account.is_test ? 1 : 0, sub.id);
    addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'submitted', visibility: 'customer', message: `Submission ${sub.public_id} received`, data: { status, package_key: sub.package_key, athletes: athletes.length } });
    addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'system', type: 'task_created', message: `${nextAction}${owner ? '' : ' — unassigned'}`, data: { owner_id: owner, status } });
  })();
  emitIntakeNotification(db, { submissionId: sub.id, eventKey: 'submission_received' });
  return db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(sub.id);
}

export async function discardDraft(db, sub, account) {
  if (sub.status !== 'draft') fail('Only a draft can be discarded.', 409);
  // Nothing was ever sent to us, so the uploads go with the draft.
  for (const f of filesOf(db, sub.id).filter(x => x.status !== 'deleted')) {
    if (UPLOADING.includes(f.status) && f.upload_id) await abortUpload(f.storage_key, f.upload_id).catch(() => {});
    else if (f.storage_key) await deleteObject(f.storage_key).catch(() => {});
    db.prepare("UPDATE intake_files SET status = 'deleted', upload_id = NULL, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(f.id);
  }
  db.prepare("UPDATE intake_submissions SET status = 'closed', close_reason = 'customer_discarded_draft', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(sub.id);
  addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'draft_discarded', visibility: 'customer', message: 'Draft discarded' });
}

export function customerReply(db, sub, account, message) {
  const text = str(message, 2000);
  if (!text) fail('Write a message first.');
  if (['draft', 'closed', 'declined'].includes(sub.status)) fail('This submission is not open for messages.', 409);
  addEvent(db, { submissionId: sub.id, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'customer_reply', visibility: 'customer', message: text });
  db.prepare("UPDATE intake_submissions SET next_action = 'Customer replied — review the reply', updated_at = datetime('now') WHERE id = ?").run(sub.id);
}

export function requestDeletion(db, account, { submission = null, scope = 'submission', note = '' }) {
  if (!['submission', 'account'].includes(scope)) fail('scope must be submission or account');
  const targetId = scope === 'account' ? account.id : submission?.id;
  if (!targetId) fail('Which submission?');
  const open = db.prepare("SELECT * FROM intake_deletion_requests WHERE scope = ? AND target_id = ? AND status = 'open'").get(scope, targetId);
  if (open) return open;
  const id = db.prepare(
    `INSERT INTO intake_deletion_requests (scope, target_id, account_id, requested_by_kind, requested_by_id, reason, note)
     VALUES (?, ?, ?, 'customer', ?, 'customer_request', ?)`
  ).run(scope, targetId, account.id, account.id, str(note, 1000)).lastInsertRowid;
  addEvent(db, { submissionId: scope === 'submission' ? targetId : null, accountId: account.id, actorKind: 'customer', actorId: account.id, type: 'deletion_requested', visibility: 'customer', message: scope === 'account' ? 'Asked us to delete the account and its footage' : 'Asked us to delete this submission’s footage', data: { request_id: id, note: str(note, 1000) } });
  return db.prepare('SELECT * FROM intake_deletion_requests WHERE id = ?').get(id);
}

// ── What the customer sees (§10: no internal notes, match confidence,
// diagnostics, or other customers' identity) ────────────────────────────
function fileSummary(f) {
  const quarter = Math.abs(Number(f.rotation) || 0) % 180 === 90;
  const short = f.width && f.height ? Math.min(quarter ? f.height : f.width, quarter ? f.width : f.height) : null;
  const fps = f.effective_fps || f.nominal_fps;
  const dur = !f.duration_s ? '' : f.duration_s < 60 ? `${Math.round(f.duration_s)}s`
    : `${Math.floor(f.duration_s / 3600) ? `${Math.floor(f.duration_s / 3600)}h ` : ''}${Math.floor((f.duration_s % 3600) / 60)}m`;
  return [short ? `${short}p` : '', fps ? `${Math.round(fps)} fps` : '', dur].filter(Boolean).join(' · ');
}

export function customerFileView(f, imported = new Set()) {
  return {
    id: f.id, kind: f.kind, camera_view: f.camera_view, label: f.label, original_name: f.original_name, size_bytes: f.size_bytes,
    status: f.status, status_label: CUSTOMER_FILE_STATUS[f.status] || f.status,
    summary: f.kind === 'video' && ['ready', 'needs_customer_action'].includes(f.status) ? fileSummary(f) : '',
    issues: safeJson(f.issues, []).map(i => ({ severity: i.severity, text: i.text })),
    uploaded_at: f.uploaded_at, retention_deadline: f.retention_deadline,
    // Part of the analysis already: removing it is a deletion request now.
    locked: !!f.feed_id || imported.has(f.id),
  };
}

export function customerResults(db, sub, job) {
  if (!job) return null;
  const athletes = athletesOf(db, sub.id).filter(a => a.player_id);
  if (!athletes.length) return { athletes: [] };
  const ordered = db.prepare(
    `SELECT req.metric_code, reg.label, reg.method, reg.publishes_to FROM cmd_metric_requirements req
       JOIN cmd_metric_registry reg ON reg.metric_code = req.metric_code
      WHERE req.order_id = ? AND req.enabled = 1 ORDER BY req.priority, req.metric_code`
  ).all(job.order_id).map(m => ({ ...m, publishes_to: JSON.parse(m.publishes_to || '[]') })).filter(m => m.publishes_to.length);
  const catalog = new Map(METRICS.map(m => [m.key, m]));
  const released = db.prepare("SELECT 1 FROM cmd_metric_results WHERE job_id = ? AND status = 'published' LIMIT 1").get(job.id) || job.metric_release_status === 'released';
  if (!released) return null;
  return {
    athletes: athletes.map(a => {
      const rows = db.prepare(
        "SELECT metric_code, value, status, unavailable_reason FROM cmd_metric_results WHERE job_id = ? AND player_id = ? AND superseded_by IS NULL AND status IN ('published', 'unavailable')"
      ).all(job.id, a.player_id);
      const metrics = ordered.map(m => {
        const mine = rows.filter(r => r.metric_code === m.metric_code);
        const rollup = rollupForMetricCode(m.metric_code, mine.filter(r => r.status === 'published').map(r => ({ ...r, status: 'approved' })));
        if (rollup?.released) {
          return {
            metric: m.label, available: true, source: TRUST_LABELS[m.method] || m.method,
            values: rollup.entries.map(e => ({ label: catalog.get(e.metric_key)?.label || e.metric_key, value: e.value, unit: catalog.get(e.metric_key)?.unit || '' })),
          };
        }
        const reasons = [...new Set(mine.filter(r => r.status === 'unavailable').map(r => r.unavailable_reason))];
        // No result at all: say only that — never guess a cause (radar may
        // well have been provided).
        return { metric: m.label, available: false, reasons: (reasons.length ? reasons : ['not_measured']).map(plainReason) };
      });
      return { name: `${a.first_name} ${a.last_name}`.trim(), metrics };
    }),
  };
}

export function customerSubmissionView(db, sub, account) {
  const files = filesOf(db, sub.id);
  const job = sub.job_id ? db.prepare('SELECT id, order_id, metric_release_status, game_record_status FROM cmd_jobs WHERE id = ?').get(sub.job_id) : null;
  const rights = latestRights(db, sub.id);
  const pkg = INTAKE_PACKAGES[sub.package_key];
  const form = safeJson(sub.form);
  const live = files.filter(f => f.status !== 'deleted');
  const imported = importedFileIds(db, sub.id);
  return {
    public_id: sub.public_id,
    kind: sub.kind,
    test: !!sub.synthetic,
    status: customerStatus({ sub, job, files }),
    step: sub.step,
    form: sub.status === 'draft' ? form : undefined,
    readiness: sub.status === 'draft' ? readiness(db, sub, account) : [],
    package: pkg ? { key: sub.package_key, label: pkg.label, note: pkg.customer_note || '' } : null,
    game: { date: sub.game_date, event: sub.event_label, team: sub.team_label, opponent: sub.opponent_label, location: sub.location, level: sub.level },
    athletes: athletesOf(db, sub.id).map(a => ({ first_name: a.first_name, last_name: a.last_name, birth_year: a.birth_year, age_band: a.age_band, relationship: a.relationship })),
    files: live.map(f => customerFileView(f, imported)),
    capture_notes: submissionCaptureNotes({ packageKey: sub.package_key, files: live }),
    rights: rights ? {
      accepted_at: rights.created_at, version: rights.policy_version, pending_legal: !!rights.pending_legal, action: rights.action, role: rights.relationship,
      permitted_uses: safeJson(rights.permitted_uses), contact_permission: !!rights.contact_permission, retention_days: rights.retention_days,
    } : null,
    message: ['needs_customer_action'].includes(sub.status) ? sub.customer_message : '',
    timeline: db.prepare(
      "SELECT id, actor_kind, event_type, message, created_at FROM intake_events WHERE submission_id = ? AND visibility = 'customer' ORDER BY id"
    ).all(sub.id).map(e => ({ id: e.id, from: e.actor_kind === 'customer' ? 'You' : 'Diamond Metrics', type: e.event_type, message: e.message, at: e.created_at })),
    results: customerResults(db, sub, job),
    deletion: db.prepare("SELECT status, created_at FROM intake_deletion_requests WHERE scope = 'submission' AND target_id = ? ORDER BY id DESC LIMIT 1").get(sub.id) || null,
    // What the customer can do right now; the routes enforce the same rules.
    can: {
      add_files: ADDING_FILES.includes(sub.status) && sub.kind !== 'inquiry',
      reply: !['draft', 'closed', 'declined'].includes(sub.status),
      request_deletion: sub.status !== 'draft',
    },
    submitted_at: sub.submitted_at,
    created_at: sub.created_at,
  };
}

export function customerSubmissionList(db, account) {
  return db.prepare(
    "SELECT * FROM intake_submissions WHERE account_id = ? AND NOT (status = 'closed' AND close_reason = 'customer_discarded_draft') ORDER BY COALESCE(submitted_at, created_at) DESC"
  ).all(account.id).map(sub => {
    const files = filesOf(db, sub.id);
    const job = sub.job_id ? db.prepare('SELECT metric_release_status, game_record_status FROM cmd_jobs WHERE id = ?').get(sub.job_id) : null;
    const athletes = athletesOf(db, sub.id);
    return {
      public_id: sub.public_id, kind: sub.kind, test: !!sub.synthetic,
      status: customerStatus({ sub, job, files }),
      package_label: INTAKE_PACKAGES[sub.package_key]?.label || '',
      game_date: sub.game_date, team: sub.team_label, opponent: sub.opponent_label,
      athletes: athletes.map(a => `${a.first_name} ${a.last_name}`.trim()).filter(Boolean),
      files: files.filter(f => f.status !== 'deleted').length,
      updated_at: sub.last_activity_at, submitted_at: sub.submitted_at,
    };
  });
}

// Customer-facing capture findings are recomputed whenever the submission's
// package or a file's angle changes, so the words always match the order.
export function refreshCaptureIssues(db, file) {
  if (file.kind !== 'video' || !['ready', 'needs_customer_action'].includes(file.status)) return file;
  const sub = db.prepare('SELECT package_key, footage_context FROM intake_submissions WHERE id = ?').get(file.submission_id);
  const ctx = safeJson(sub?.footage_context);
  const issues = captureIssues(file, { packageKey: sub?.package_key || 'rookie', fullGame: ctx.coverage === 'full' ? true : ctx.coverage === 'clips' ? false : null });
  db.prepare('UPDATE intake_files SET issues = ? WHERE id = ?').run(JSON.stringify(issues), file.id);
  return { ...file, issues: JSON.stringify(issues) };
}

