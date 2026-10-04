// Fulfillment side of the customer intake (customer footage submission §8–§9):
// Will's queue, the full record, identity decisions, and the hand-off into
// Command — create or link the job, turn uploaded files into feeds (the same
// storage object, never a copy), and carry rights, uploader and deletion date
// along. Every action is audited on the immutable timeline.
import {
  QUEUE_STAGES, STAFF_SETTABLE_STATUSES, queueStage, INTAKE_PACKAGES, CAMERA_VIEWS, ROLES, RELATIONSHIPS,
  OWNERSHIP_RELATIONSHIPS, FILE_KINDS, safeJson, isoDate, submissionCaptureNotes, customerStatus,
} from './intakeLogic.js';
import { addEvent, getAccount, latestRights, verifiedAthletes, verifiedTeams, accountView, settingValue } from './intakeStore.js';
import {
  loadPlayerIndex, scorePlayerCandidates, isAmbiguous, teamCandidates, jobCandidates, tournamentGameCandidates,
  submissionDuplicates, contactDuplicates, fileDuplicates,
} from './intakeMatching.js';
import { emitIntakeNotification } from './notifications.js';
import { enqueueMediaJob } from './mediaWorker.js';
import { commandRoster, addJobGuest } from './commandRoster.js';
import { importRadarCsv } from './radarImport.js';
import { getObjectRange, localPathFor, storageMode } from './storage.js';
import { newSlug } from './db.js';
import { slugify } from './rosterLogic.js';
import fs from 'node:fs';

const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const STAGE_LABEL = Object.fromEntries(QUEUE_STAGES.map(s => [s.key, s.label]));
export const FULFILLMENT_ROLES = ['admin', 'fulfillment'];

export function loadSubmission(db, id) {
  const sub = db.prepare('SELECT * FROM intake_submissions WHERE id = ?').get(Number(id));
  if (!sub) fail('Submission not found', 404);
  return sub;
}

const jobOf = (db, sub) => (sub.job_id ? db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(sub.job_id) : null);
const staffEvent = (db, sub, actor, type, message, data = {}, visibility = 'internal') =>
  addEvent(db, { submissionId: sub.id, accountId: sub.account_id, actorKind: 'staff', actorId: actor.id, type, message, data, visibility });

// ── Queue ────────────────────────────────────────────────────────────────
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
  return m;
}

export function staffQueue(db, { stage = '', owner = '', q = '', includeTest = true } = {}) {
  const subs = db.prepare(
    `SELECT s.*, a.first_name AS c_first, a.last_name AS c_last, a.email AS c_email, a.role AS c_role,
            a.email_verified_at AS c_verified, ad.name AS owner_name,
            j.metric_release_status, j.game_record_status
       FROM intake_submissions s JOIN customer_accounts a ON a.id = s.account_id
       LEFT JOIN admins ad ON ad.id = s.owner_id
       LEFT JOIN cmd_jobs j ON j.id = s.job_id
      WHERE NOT (s.status = 'closed' AND s.close_reason = 'customer_discarded_draft')
      ORDER BY COALESCE(s.submitted_at, s.created_at) DESC`
  ).all();
  const athletes = groupBy(db.prepare('SELECT submission_id, first_name, last_name, resolution FROM intake_athletes').all(), 'submission_id');
  const files = groupBy(db.prepare("SELECT submission_id, kind, status FROM intake_files WHERE status != 'deleted'").all(), 'submission_id');
  const rights = new Map(db.prepare('SELECT * FROM intake_rights WHERE id IN (SELECT MAX(id) FROM intake_rights GROUP BY submission_id)').all().map(r => [r.submission_id, r]));
  const lastEvent = new Map(db.prepare(
    'SELECT submission_id, event_type, actor_kind, created_at FROM intake_events WHERE id IN (SELECT MAX(id) FROM intake_events WHERE submission_id IS NOT NULL GROUP BY submission_id)'
  ).all().map(e => [e.submission_id, e]));
  const openDeletion = new Set(db.prepare("SELECT target_id FROM intake_deletion_requests WHERE scope = 'submission' AND status = 'open'").all().map(r => r.target_id));
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const rows = subs.map(s => {
    const job = s.job_id ? { metric_release_status: s.metric_release_status, game_record_status: s.game_record_status } : null;
    const stg = queueStage(s, job);
    const a = athletes.get(s.id) || [];
    const f = files.get(s.id) || [];
    const r = rights.get(s.id);
    const last = lastEvent.get(s.id);
    const open = !['closed', 'draft', 'complete'].includes(stg);
    const flags = [];
    if (last?.actor_kind === 'customer' && last.event_type === 'customer_reply') flags.push('customer_replied');
    if (open && s.due_at && s.due_at < now) flags.push('overdue');
    if (s.escalated_at) flags.push('escalated');
    if (s.kind === 'footage' && open && s.payment_status === 'unconfirmed') flags.push('payment_unconfirmed');
    if (!s.c_verified) flags.push('email_unverified');
    if (openDeletion.has(s.id)) flags.push('deletion_requested');
    if (s.kind === 'inquiry') flags.push('hall_of_fame');
    return {
      id: s.id, public_id: s.public_id, stage: stg, stage_label: stg === 'draft' ? 'Draft' : STAGE_LABEL[stg], status: s.status, kind: s.kind,
      synthetic: !!s.synthetic,
      submitter: { name: `${s.c_first} ${s.c_last}`.trim() || s.c_email, email: s.c_email, role: ROLES[s.c_role]?.label || s.c_role, verified: !!s.c_verified },
      athletes: { names: a.map(x => `${x.first_name} ${x.last_name}`.trim()).filter(Boolean), unresolved: a.filter(x => ['pending', 'deferred'].includes(x.resolution)).length, total: a.length },
      team: s.team_label, game_date: s.game_date, opponent: s.opponent_label, event: s.event_label,
      package_label: INTAKE_PACKAGES[s.package_key]?.label || '—',
      files: {
        videos: f.filter(x => x.kind === 'video').length,
        checking: f.filter(x => ['uploading', 'paused', 'uploaded', 'processing'].includes(x.status)).length,
        action: f.filter(x => x.status === 'needs_customer_action').length,
        supporting: f.filter(x => x.kind !== 'video').length,
      },
      consent: !r ? 'missing' : r.action === 'revoke' ? 'revoked' : r.pending_legal ? 'accepted (draft terms)' : 'accepted',
      owner: s.owner_id ? { id: s.owner_id, name: s.owner_name } : null,
      last_activity_at: s.last_activity_at, next_action: s.next_action, due_at: s.due_at,
      payment_status: s.payment_status, job_id: s.job_id, flags,
    };
  });

  const counts = Object.fromEntries([...QUEUE_STAGES.map(s => [s.key, 0]), ['draft', 0], ['mine', 0], ['unassigned', 0]]);
  for (const r of rows) {
    if (!includeTest && r.synthetic) continue;
    counts[r.stage] = (counts[r.stage] || 0) + 1;
  }
  const needle = q.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (!includeTest && r.synthetic) return false;
    if (stage) { if (r.stage !== stage) return false; } else if (r.stage === 'draft') return false;
    if (owner === 'unassigned' && r.owner) return false;
    if (owner && owner !== 'unassigned' && String(r.owner?.id) !== String(owner)) return false;
    if (needle) {
      const hay = [r.public_id, r.submitter.name, r.submitter.email, r.team, r.opponent, r.event, ...r.athletes.names].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  return { rows: filtered, counts, stages: [...QUEUE_STAGES, { key: 'draft', label: 'Drafts (not submitted)' }] };
}

// ── The record ───────────────────────────────────────────────────────────
export function staffRecord(db, subId) {
  const sub = loadSubmission(db, subId);
  const account = getAccount(db, sub.account_id);
  const job = jobOf(db, sub);
  const files = db.prepare('SELECT * FROM intake_files WHERE submission_id = ? ORDER BY id').all(sub.id);
  const athletes = db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ? ORDER BY id').all(sub.id);

  const teamCands = sub.team_id
    ? [{ ...db.prepare('SELECT t.id AS team_id, t.name, t.age_group, o.name AS organization_name FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.id = ?').get(sub.team_id), score: 999, reasons: ['confirmed team'] }]
    : teamCandidates(db, { label: sub.team_label, level: sub.level, accountId: sub.account_id });
  const teamIds = teamCands.map(t => t.team_id);
  const index = loadPlayerIndex(db);
  const roster = job ? new Set(commandRoster(db, job).map(p => p.id)) : null;

  const internalNames = new Map(db.prepare('SELECT id, name FROM admins').all().map(a => [a.id, a.name]));
  const timeline = db.prepare('SELECT * FROM intake_events WHERE submission_id = ? OR (submission_id IS NULL AND account_id = ?) ORDER BY id').all(sub.id, sub.account_id)
    .map(e => ({
      id: e.id, at: e.created_at, type: e.event_type, visibility: e.visibility, message: e.message, data: safeJson(e.data),
      actor: e.actor_kind === 'staff' ? (internalNames.get(e.actor_id) || 'Staff') : e.actor_kind === 'customer' ? 'Customer' : 'System',
      actor_kind: e.actor_kind,
    }));

  return {
    submission: {
      ...sub, form: safeJson(sub.form), footage_context: safeJson(sub.footage_context), source_params: safeJson(sub.source_params),
      stage: queueStage(sub, job), stage_label: STAGE_LABEL[queueStage(sub, job)] || 'Draft',
      package: INTAKE_PACKAGES[sub.package_key] ? { key: sub.package_key, ...INTAKE_PACKAGES[sub.package_key] } : null,
      customer_status: customerStatus({ sub, job, files }),
      owner_name: sub.owner_id ? internalNames.get(sub.owner_id) || null : null,
    },
    account: {
      ...accountView(account), phone_normalized: account.phone_normalized, is_test: !!account.is_test, status: account.status,
      verified_via: account.verified_via, created_at: account.created_at, role_label: ROLES[account.role]?.label || account.role,
      linked_logins: { staff: !!account.staff_user_id, player: !!account.player_user_id },
    },
    contact_duplicates: contactDuplicates(db, account),
    prior_submissions: db.prepare(
      "SELECT id, public_id, status, game_date, team_label, package_key, submitted_at FROM intake_submissions WHERE account_id = ? AND id != ? AND status != 'draft' ORDER BY id DESC LIMIT 20"
    ).all(sub.account_id, sub.id),
    verified_athletes: verifiedAthletes(db, sub.account_id),
    verified_teams: verifiedTeams(db, sub.account_id),
    athletes: athletes.map(a => {
      const candidates = a.player_id ? [] : scorePlayerCandidates(db, index, a, { teamIds, gameDate: sub.game_date });
      const player = a.player_id ? db.prepare('SELECT id, first_name, last_name, slug, is_public, date_of_birth FROM players WHERE id = ?').get(a.player_id) : null;
      return {
        ...a, relationship_label: RELATIONSHIPS[a.relationship] || a.relationship || '—',
        ownership: OWNERSHIP_RELATIONSHIPS.includes(a.relationship), player,
        on_job_roster: roster && a.player_id ? roster.has(a.player_id) : null,
        candidates, ambiguous: isAmbiguous(candidates),
      };
    }),
    game: {
      team_candidates: teamCands,
      job_candidates: sub.job_id ? [] : jobCandidates(db, {
        teamIds, gameDate: sub.game_date, opponent: sub.opponent_label, event: sub.event_label, teamLabel: sub.team_label,
        opponentTeamIds: sub.opponent_label ? teamCandidates(db, { label: sub.opponent_label }).map(t => t.team_id) : [],
      }),
      tournament_games: tournamentGameCandidates(db, { teamIds, gameDate: sub.game_date }),
      submission_duplicates: submissionDuplicates(db, sub),
    },
    files: files.map(f => ({
      ...f, issues: safeJson(f.issues, []), duplicates: fileDuplicates(db, f),
      kind_label: FILE_KINDS[f.kind]?.label || f.kind, view_label: CAMERA_VIEWS[f.camera_view] || '',
      feed: f.feed_id ? db.prepare('SELECT id, job_id, status, error FROM cmd_video_feeds WHERE id = ?').get(f.feed_id) : null,
      overdue_retention: !!(f.retention_deadline && f.status !== 'deleted' && f.retention_deadline < new Date().toISOString().replace('T', ' ').slice(0, 19)),
    })),
    capture_notes: submissionCaptureNotes({ packageKey: sub.package_key, files }),
    rights: db.prepare('SELECT * FROM intake_rights WHERE submission_id = ? ORDER BY id').all(sub.id)
      .map(r => ({ ...r, permitted_uses: safeJson(r.permitted_uses), athlete_ids: safeJson(r.athlete_ids, []) })),
    job: job ? {
      id: job.id, game_date: job.game_date, metric_release_status: job.metric_release_status, game_record_status: job.game_record_status,
      team_name: db.prepare('SELECT name FROM teams WHERE id = ?').get(job.team_id)?.name,
      package_key: db.prepare('SELECT package_key FROM cmd_orders WHERE id = ?').get(job.order_id)?.package_key,
      synthetic: !!db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id)?.synthetic,
    } : null,
    timeline,
    notifications: db.prepare('SELECT * FROM intake_notifications WHERE submission_id = ? ORDER BY id').all(sub.id),
    deletion_requests: db.prepare(
      "SELECT * FROM intake_deletion_requests WHERE (scope = 'submission' AND target_id = ?) OR (scope = 'account' AND target_id = ?) OR account_id = ? ORDER BY id DESC"
    ).all(sub.id, sub.account_id, sub.account_id),
    owners: db.prepare('SELECT id, name, email, role FROM admins WHERE active = 1 ORDER BY name').all(),
    checks: readinessForJob(db, sub, files, athletes),
  };
}

export function readinessForJob(db, sub, files = null, athletes = null) {
  const fs_ = files || db.prepare('SELECT * FROM intake_files WHERE submission_id = ?').all(sub.id);
  const as = athletes || db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ?').all(sub.id);
  const rights = latestRights(db, sub.id);
  const blockers = [];
  const warnings = [];
  if (sub.kind === 'inquiry') blockers.push('Hall of Fame requests are planned with the customer, not created as a job from here.');
  if (['draft', 'closed', 'declined'].includes(sub.status)) blockers.push(`The submission is ${sub.status}.`);
  if (sub.job_id) blockers.push('Already linked to a Command job.');
  if (as.some(a => ['pending', 'deferred'].includes(a.resolution))) blockers.push('Resolve every athlete first (link, create, or use a guest placeholder).');
  if (!fs_.some(f => f.kind === 'video' && ['uploaded', 'processing', 'ready'].includes(f.status))) blockers.push('No usable game video is attached.');
  if (!rights || rights.action !== 'grant') blockers.push('The footage terms are missing or were revoked.');
  // Warnings carry a code so the record page can show a short chip.
  const warn = (code, text) => warnings.push({ code, text });
  if (fs_.some(f => f.status === 'needs_customer_action')) warn('unreadable_file', 'A file could not be read — it will not be attached.');
  if (sub.payment_status === 'unconfirmed') warn('payment_unconfirmed', 'Payment is not confirmed.');
  if (!getAccount(db, sub.account_id)?.email_verified_at) warn('email_unverified', 'The submitter’s email is not verified.');
  if (rights?.pending_legal) warn('draft_terms', 'Accepted under draft terms that legal has not approved yet.');
  return { ready: blockers.length === 0, blockers, warnings };
}

// ── Task fields, status, ownership ───────────────────────────────────────
export function updateSubmission(db, sub, body = {}, actor) {
  const sets = [];
  const vals = [];
  const changes = [];
  const set = (col, val, label) => { sets.push(`${col} = ?`); vals.push(val); changes.push(label); };
  if ('owner_id' in body) {
    const id = body.owner_id ? Number(body.owner_id) : null;
    if (id && !db.prepare('SELECT 1 FROM admins WHERE id = ? AND active = 1').get(id)) fail('owner_id must be an active internal account');
    set('owner_id', id, `owner → ${id ? db.prepare('SELECT name FROM admins WHERE id = ?').get(id).name : 'unassigned'}`);
  }
  if ('next_action' in body) set('next_action', str(body.next_action, 300), 'next action');
  if ('due_at' in body) {
    const due = body.due_at ? String(body.due_at).replace('T', ' ').slice(0, 19) : null;
    if (due && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(due)) fail('due_at must be a date or date-time');
    set('due_at', due, 'due date');
  }
  if ('blocked_reason' in body) set('blocked_reason', str(body.blocked_reason, 300), 'blocked reason');
  if ('payment_status' in body) {
    if (!['unconfirmed', 'confirmed', 'not_required', 'waived'].includes(body.payment_status)) fail('payment_status must be unconfirmed, confirmed, not_required or waived');
    set('payment_status', body.payment_status, `payment → ${body.payment_status}`);
  }
  if ('status' in body && body.status !== sub.status) {
    const allowed = sub.job_id ? ['linked', 'needs_customer_action'] : STAFF_SETTABLE_STATUSES;
    if (['draft', 'closed', 'declined'].includes(sub.status)) fail(`A ${sub.status} submission cannot change status here — reopen it first.`, 409);
    if (!allowed.includes(body.status)) fail(`Status must be one of ${allowed.join(', ')}`);
    set('status', body.status, `status ${sub.status} → ${body.status}`);
    if (sub.status === 'needs_customer_action') set('customer_message', '', 'customer request cleared');
  }
  if ('synthetic' in body) {
    const next = body.synthetic ? 1 : 0;
    if (sub.job_id) fail('This submission is linked to a Command job — change the test flag on the job instead.', 409);
    set('synthetic', next, next ? 'marked as test' : 'unmarked as test');
  }
  if ('escalated' in body && !body.escalated && sub.escalated_at) {
    if (actor.role !== 'admin') fail('Only an admin can clear an escalation', 403);
    set('escalated_at', null, 'escalation cleared');
  }
  if ('team_id' in body) {
    const id = body.team_id ? Number(body.team_id) : null;
    if (id && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)) fail('team_id must be an existing team');
    if (sub.job_id) fail('The team comes from the linked job.', 409);
    set('team_id', id, `team → ${id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id).name : 'not confirmed'}`);
  }
  if (!sets.length) fail('No supported fields to update');
  db.prepare(`UPDATE intake_submissions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, sub.id);
  staffEvent(db, sub, actor, 'task_updated', changes.join('; '), Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v])));
  return loadSubmission(db, sub.id);
}

export function addNote(db, sub, actor, message) {
  const text = str(message, 4000);
  if (!text) fail('Write a note first.');
  staffEvent(db, sub, actor, 'note', text);
}

// A customer-visible message. With request_action it becomes the open
// "action required" request the customer sees at the top of their page.
export function messageCustomer(db, sub, actor, { message, request_action = false }) {
  const text = str(message, 2000);
  if (!text) fail('Write the message first.');
  if (['draft', 'closed', 'declined'].includes(sub.status)) fail('This submission is not open.', 409);
  db.transaction(() => {
    staffEvent(db, sub, actor, request_action ? 'information_requested' : 'message', text, {}, 'customer');
    if (request_action) {
      db.prepare(
        "UPDATE intake_submissions SET status = 'needs_customer_action', customer_message = ?, next_action = 'Waiting on the customer', updated_at = datetime('now') WHERE id = ?"
      ).run(text, sub.id);
    }
  })();
  if (request_action) emitIntakeNotification(db, { submissionId: sub.id, eventKey: 'action_required', payload: { message: text } });
  return loadSubmission(db, sub.id);
}

export function escalate(db, sub, actor, note) {
  const text = str(note, 1000);
  if (!text) fail('Say what the admin needs to decide.');
  db.prepare("UPDATE intake_submissions SET escalated_at = datetime('now'), next_action = 'Escalated to an admin', updated_at = datetime('now') WHERE id = ?").run(sub.id);
  staffEvent(db, sub, actor, 'escalated', text);
  return loadSubmission(db, sub.id);
}

// ── Identity (§8 "Identity resolution") ──────────────────────────────────
export function resolveAthlete(db, sub, athleteId, body = {}, actor) {
  const athlete = db.prepare('SELECT * FROM intake_athletes WHERE id = ? AND submission_id = ?').get(Number(athleteId), sub.id);
  if (!athlete) fail('Athlete not found on this submission', 404);
  if (['draft', 'closed', 'declined'].includes(sub.status)) fail(`The submission is ${sub.status}.`, 409);
  const action = body.action;
  const note = str(body.note, 1000);
  const account = getAccount(db, sub.account_id);
  const job = jobOf(db, sub);
  const index = loadPlayerIndex(db);
  const teamIds = sub.team_id ? [sub.team_id] : job ? [job.team_id] : teamCandidates(db, { label: sub.team_label, accountId: sub.account_id }).map(t => t.team_id);
  const candidates = scorePlayerCandidates(db, index, athlete, { teamIds, gameDate: sub.game_date });
  const snapshot = candidates.map(c => ({ player_id: c.player_id, name: c.name, confidence: c.confidence, score: c.score, reasons: c.reasons }));
  const ownership = OWNERSHIP_RELATIONSHIPS.includes(athlete.relationship) && ROLES[account.role]?.group === 'family';

  const run = db.transaction(() => {
    let playerId = null;
    let resolution;
    let message;
    if (action === 'link') {
      playerId = Number(body.player_id);
      const p = db.prepare('SELECT id, first_name, last_name FROM players WHERE id = ?').get(playerId);
      if (!p) fail('player_id must be an existing player');
      resolution = 'linked_existing';
      message = `${athlete.first_name} ${athlete.last_name} → existing player ${p.first_name} ${p.last_name} (#${p.id})`;
    } else if (action === 'new_player') {
      // A new record when a reasonable match exists needs a written reason —
      // that is how duplicate athletes get created.
      if (candidates.some(c => c.confidence !== 'low') && !note) fail('There are possible matches — explain why none of them is this athlete before creating a new player.', 409);
      if (!athlete.first_name || !athlete.last_name) fail('A new player needs a first and last name.');
      // Never public until verified (§5): the profile stays private.
      playerId = db.prepare('INSERT INTO players (first_name, last_name, slug, is_public, grad_year) VALUES (?, ?, ?, 0, ?)')
        .run(athlete.first_name, athlete.last_name, newSlug(athlete.first_name, athlete.last_name), null).lastInsertRowid;
      resolution = 'new_player';
      message = `${athlete.first_name} ${athlete.last_name} → new private player record (#${playerId})`;
    } else if (action === 'guest') {
      resolution = 'guest';
      message = `${athlete.first_name} ${athlete.last_name} → guest placeholder on the job`;
      if (job) {
        playerId = addJobGuest(db, job.id, { first_name: athlete.first_name, last_name: athlete.last_name, jersey: athlete.jersey, label: `from ${sub.public_id}` }, actor.id).id;
      }
    } else if (action === 'defer') {
      if (!note) fail('Say what is needed before this athlete can be resolved.');
      resolution = 'deferred';
      message = `${athlete.first_name} ${athlete.last_name} deferred`;
    } else if (action === 'reset') {
      if (job) fail('The submission is already linked to a job — reassign the athlete in Command instead.', 409);
      db.prepare("DELETE FROM customer_athletes WHERE account_id = ? AND player_id = ? AND source_submission_id = ?").run(account.id, athlete.player_id ?? -1, sub.id);
      resolution = 'pending';
      message = `${athlete.first_name} ${athlete.last_name} decision reset`;
    } else {
      fail('action must be link, new_player, guest, defer or reset');
    }
    db.prepare(
      "UPDATE intake_athletes SET player_id = ?, resolution = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?"
    ).run(action === 'defer' ? athlete.player_id : playerId, resolution, action === 'reset' ? null : actor.id, note, athlete.id);
    // A parent's, guardian's or adult athlete's link becomes "my athletes";
    // a coach's never becomes ownership (§2).
    if (playerId && ownership && action !== 'guest') {
      db.prepare(
        'INSERT OR IGNORE INTO customer_athletes (account_id, player_id, relationship, verified_by, source_submission_id) VALUES (?, ?, ?, ?, ?)'
      ).run(account.id, playerId, athlete.relationship, actor.id, sub.id);
    }
    if (playerId && job && action !== 'guest') addParticipant(db, job, playerId, athlete.jersey, sub, actor);
    staffEvent(db, sub, actor, `identity_${resolution}`, message, { athlete_id: athlete.id, player_id: playerId, candidates: snapshot, note });
    // Identity resolved → ready for the job (unless something else is open).
    const open = db.prepare("SELECT COUNT(*) n FROM intake_athletes WHERE submission_id = ? AND resolution IN ('pending', 'deferred')").get(sub.id).n;
    if (open === 0 && sub.status === 'needs_identity_review') {
      db.prepare("UPDATE intake_submissions SET status = 'ready_for_job', next_action = 'Create or link the Command job', updated_at = datetime('now') WHERE id = ?").run(sub.id);
      staffEvent(db, sub, actor, 'status_changed', 'Identity resolved — ready to create the Command job', { from: sub.status, to: 'ready_for_job' });
    } else if (open > 0 && ['new', 'ready_for_job'].includes(sub.status)) {
      db.prepare("UPDATE intake_submissions SET status = 'needs_identity_review', updated_at = datetime('now') WHERE id = ?").run(sub.id);
    }
  });
  run();
  return loadSubmission(db, sub.id);
}

function addParticipant(db, job, playerId, jersey, sub, actor) {
  const onRoster = commandRoster(db, job).some(p => p.id === playerId);
  if (onRoster) return false;
  db.prepare(
    'INSERT OR IGNORE INTO cmd_job_participants (job_id, player_id, jersey, source, submission_id, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(job.id, playerId, jersey || '', 'intake', sub.id, actor.id);
  return true;
}

// ── Hand-off into Command (§9) ───────────────────────────────────────────
const PROFILE_FOR_VIEW = { behind_home: 'behind_home_1080p60', side_first_base: 'first_base_line_4k120', side_third_base: 'first_base_line_4k120' };

// Attach a submission to a job: its video becomes Command feeds (same storage
// object), named athletes join the job's roster, guests become placeholders,
// a coach is linked to the team, and the submitter hears about the job.
function attachToJob(db, sub, job, actor) {
  const rights = latestRights(db, sub.id);
  const account = getAccount(db, sub.account_id);
  const ctx = safeJson(sub.footage_context);
  const attached = [];
  const files = db.prepare("SELECT * FROM intake_files WHERE submission_id = ? AND kind = 'video' AND status IN ('uploaded', 'processing', 'ready') AND feed_id IS NULL").all(sub.id);
  for (const f of files) {
    // Reuse only a live, complete feed of the same bytes — never one deleted
    // under a deletion request or one whose own upload never finished.
    const existing = db.prepare(
      "SELECT id FROM cmd_video_feeds WHERE job_id = ? AND content_hash = ? AND size_bytes = ? AND status NOT IN ('deleted', 'uploading', 'failed')"
    ).get(job.id, f.content_hash, f.size_bytes);
    let feedId = existing?.id;
    if (!feedId) {
      feedId = db.prepare(
        `INSERT INTO cmd_video_feeds (job_id, label, capture_profile_key, storage_key, original_name, size_bytes, content_hash, status,
                                      duration_s, codec, width, height, rotation, nominal_fps, effective_fps, vfr, recording_notes, created_by,
                                      submission_id, intake_file_id, rights_id, retention_deadline, uploader_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(job.id, `${CAMERA_VIEWS[f.camera_view] || 'Feed'} · ${sub.public_id}`, PROFILE_FOR_VIEW[f.camera_view] || '', f.storage_key, f.original_name,
        f.size_bytes, f.content_hash, f.duration_s, f.codec, f.width, f.height, f.rotation, f.nominal_fps, f.effective_fps, f.vfr,
        str(ctx.key_plays ? `Customer notes: ${ctx.key_plays}` : '', 1000), actor.id, sub.id, f.id, f.rights_id ?? rights?.id ?? null, f.retention_deadline, f.account_id).lastInsertRowid;
      // Same pipeline as an analyst upload: probe → CFR proxy → ready.
      enqueueMediaJob(db, feedId, 'probe');
      db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'feed_registered', ?)")
        .run(job.id, actor.id, `${f.original_name} — from customer submission ${sub.public_id}`);
    }
    db.prepare("UPDATE intake_files SET feed_id = ?, updated_at = datetime('now') WHERE id = ?").run(feedId, f.id);
    attached.push({ file_id: f.id, feed_id: feedId, reused: !!existing });
  }
  for (const a of db.prepare('SELECT * FROM intake_athletes WHERE submission_id = ?').all(sub.id)) {
    if (a.resolution === 'guest' && !a.player_id) {
      const guest = addJobGuest(db, job.id, { first_name: a.first_name, last_name: a.last_name, jersey: a.jersey, label: `from ${sub.public_id}` }, actor.id);
      db.prepare('UPDATE intake_athletes SET player_id = ? WHERE id = ?').run(guest.id, a.id);
    } else if (a.player_id && ['linked_existing', 'new_player'].includes(a.resolution)) {
      addParticipant(db, job, a.player_id, a.jersey, sub, actor);
    }
  }
  if (ROLES[account.role]?.group !== 'family') {
    db.prepare(
      'INSERT OR IGNORE INTO customer_team_links (account_id, team_id, relationship, verified_by, source_submission_id) VALUES (?, ?, ?, ?, ?)'
    ).run(account.id, job.team_id, account.role === 'director' ? 'director' : account.role === 'team_rep' ? 'team_rep' : 'coach', actor.id, sub.id);
  }
  // The submitter is told about the job through the order contact when the
  // order has none yet; any other linked submitter is reached through
  // jobRecipients(), which honours each one's contact permission.
  const order = db.prepare('SELECT o.id, o.contact_email FROM cmd_orders o WHERE o.id = ?').get(job.order_id);
  if (order && !order.contact_email && rights?.contact_permission && account.email_verified_at && !account.is_test) {
    db.prepare('UPDATE cmd_orders SET contact_email = ? WHERE id = ?').run(account.email, order.id);
  }
  return attached;
}

function teamFor(db, body, actor) {
  if (body.team_id) {
    const t = db.prepare('SELECT id FROM teams WHERE id = ?').get(Number(body.team_id));
    if (!t) fail('team_id must be an existing team');
    return t.id;
  }
  const nt = body.new_team || {};
  const name = str(nt.name, 100);
  if (!name) fail('Pick the team, or give the new team a name.');
  let orgId = nt.organization_id ? Number(nt.organization_id) : null;
  if (orgId && !db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(orgId)) fail('organization_id must be an existing organization');
  if (!orgId) {
    const orgName = str(nt.organization_name, 100) || name;
    orgId = db.prepare('SELECT id FROM organizations WHERE LOWER(name) = LOWER(?)').get(orgName)?.id
      ?? db.prepare('INSERT INTO organizations (name) VALUES (?)').run(orgName).lastInsertRowid;
  }
  let slug = slugify(name) || 'team';
  for (let i = 2; db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug); i++) slug = `${slugify(name)}-${i}`;
  const id = db.prepare('INSERT INTO teams (organization_id, name, slug, age_group, level) VALUES (?, ?, ?, ?, ?)')
    .run(orgId, name, slug, str(nt.age_group, 30), str(nt.level, 30)).lastInsertRowid;
  db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('teams', ?, ?, 'created', ?)").run(id, actor.id, `${name} — created from intake`);
  return id;
}

export function createJobFromSubmission(db, sub, body = {}, actor, { createJob }) {
  const check = readinessForJob(db, sub);
  if (!check.ready) fail(check.blockers.join(' '), 409);
  const rights = latestRights(db, sub.id);
  const account = getAccount(db, sub.account_id);
  const pkg = INTAKE_PACKAGES[sub.package_key];
  const permitted = safeJson(rights.permitted_uses);
  const gameDate = isoDate(body.game_date) || isoDate(sub.game_date);
  if (!gameDate) fail('game_date is required');
  const notes = [
    `From customer submission ${sub.public_id} (${pkg?.label || sub.package_key || 'no package'}).`,
    pkg?.fulfillment_note || '',
    sub.requested_metrics ? `Requested: ${sub.requested_metrics}` : '',
    sub.order_reference ? `Order reference: ${sub.order_reference}` : '',
    `Payment: ${sub.payment_status}.`,
    str(body.notes, 1000),
  ].filter(Boolean).join(' ');

  const run = db.transaction(() => {
    const teamId = teamFor(db, body, actor);
    const jobId = createJob({
      team_id: teamId,
      game_date: gameDate,
      opponent_label: str(body.opponent_label ?? sub.opponent_label, 100),
      event_label: str(body.event_label ?? sub.event_label, 120),
      tournament_game_id: body.tournament_game_id ? Number(body.tournament_game_id) : null,
      package_key: body.package_key || pkg?.command_package || 'rookie',
      regulation_innings: body.regulation_innings,
      assigned_to: body.assigned_to || null,
      due_date: body.due_date || null,
      notes,
      contact_email: rights.contact_permission && account.email_verified_at && !account.is_test ? account.email : '',
      media_consent: permitted.analysis ? 1 : 0,
      sharing_scope: permitted.results ? 'customer' : 'internal',
      synthetic: sub.synthetic,
    }, actor.id);
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
    db.prepare(
      "UPDATE intake_submissions SET job_id = ?, team_id = ?, tournament_game_id = ?, status = 'linked', next_action = 'Track the job in Command', updated_at = datetime('now') WHERE id = ?"
    ).run(jobId, teamId, job.tournament_game_id, sub.id);
    const attached = attachToJob(db, { ...sub, team_id: teamId }, job, actor);
    db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'created_from_intake', ?)")
      .run(jobId, actor.id, `submission ${sub.public_id}: ${attached.length} feed${attached.length === 1 ? '' : 's'} attached`);
    staffEvent(db, sub, actor, 'job_created', `Command job #${jobId} created; ${attached.length} video${attached.length === 1 ? '' : 's'} attached`, { job_id: jobId, attached });
    staffEvent(db, sub, actor, 'analysis_queued', 'Your game is queued for analysis.', { job_id: jobId }, 'customer');
    return jobId;
  });
  return run();
}

export function linkSubmissionToJob(db, sub, jobId, actor) {
  const check = readinessForJob(db, sub);
  if (!check.ready) fail(check.blockers.join(' '), 409);
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(Number(jobId));
  if (!job) fail('Job not found', 404);
  // Test isolation (§9): a test submission never joins a real job, or the reverse.
  const synthetic = db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id).synthetic;
  if (!!synthetic !== !!sub.synthetic) fail(sub.synthetic ? 'This is a test submission — it cannot join a real customer job.' : 'That job is a test job — a real submission cannot join it.', 409);
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE intake_submissions SET job_id = ?, team_id = ?, tournament_game_id = ?, status = 'linked', next_action = 'Track the job in Command', updated_at = datetime('now') WHERE id = ?"
    ).run(job.id, job.team_id, job.tournament_game_id, sub.id);
    const attached = attachToJob(db, { ...sub, team_id: job.team_id }, job, actor);
    db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'linked_intake', ?)")
      .run(job.id, actor.id, `submission ${sub.public_id}: ${attached.length} feed${attached.length === 1 ? '' : 's'} attached`);
    staffEvent(db, sub, actor, 'job_linked', `Linked to existing Command job #${job.id}; ${attached.length} video${attached.length === 1 ? '' : 's'} attached`, { job_id: job.id, attached });
    staffEvent(db, sub, actor, 'analysis_queued', 'Your game is queued for analysis.', { job_id: job.id }, 'customer');
  });
  run();
  return loadSubmission(db, sub.id);
}

// Files the customer adds after the job exists (a replacement for one we could
// not read, or a second angle we asked for) join the same job on request.
// attachToJob only touches files without a feed, so this is idempotent.
export function attachNewFiles(db, sub, actor) {
  if (!sub.job_id) fail('Create or link the Command job first.', 409);
  const rights = latestRights(db, sub.id);
  if (!rights || rights.action !== 'grant') fail('The footage terms are missing or were revoked.', 409);
  const job = jobOf(db, sub);
  const attached = db.transaction(() => attachToJob(db, sub, job, actor))();
  if (!attached.length) fail('There is no new usable video to attach.', 409);
  db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'linked_intake', ?)")
    .run(job.id, actor.id, `submission ${sub.public_id}: ${attached.length} more feed${attached.length === 1 ? '' : 's'} attached`);
  staffEvent(db, sub, actor, 'files_attached', `${attached.length} more video${attached.length === 1 ? '' : 's'} attached to Command job #${job.id}`, { job_id: job.id, attached });
  return attached;
}

// Supporting data into the linked job (§5 "imports may be processed later").
async function readObjectText(key, maxBytes) {
  if (storageMode === 'local') {
    const p = localPathFor(key);
    const size = fs.statSync(p).size;
    if (size > maxBytes) fail('The file is too large to import as text.');
    return fs.readFileSync(p, 'utf8');
  }
  const { body, contentLength } = await getObjectRange(key);
  if (contentLength > maxBytes) { body.destroy?.(); fail('The file is too large to import as text.'); }
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export async function sendSupportingToJob(db, sub, fileId, actor) {
  const file = db.prepare('SELECT * FROM intake_files WHERE id = ? AND submission_id = ?').get(Number(fileId), sub.id);
  if (!file) fail('File not found', 404);
  if (!sub.job_id) fail('Create or link the Command job first.', 409);
  if (file.status !== 'ready') fail('The file is not ready.', 409);
  if (file.kind === 'radar_csv') {
    const r = importRadarCsv(db, sub.job_id, { filename: file.original_name, content: await readObjectText(file.storage_key, 10 * 1024 ** 2) }, actor.id);
    staffEvent(db, sub, actor, 'supporting_imported', `${file.original_name} → radar queue of job #${sub.job_id}${r.duplicate ? ' (already imported)' : ` (${r.readable} readable rows)`}`, { file_id: file.id, ...r });
    return { kind: 'radar', ...r };
  }
  if (file.kind === 'scorecard' && file.original_name.toLowerCase().endsWith('.csv')) {
    const raw = await readObjectText(file.storage_key, 25 * 1024 ** 2);
    const id = db.prepare(
      "INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, note, created_by) VALUES (?, 'gamechanger_export', ?, ?, ?, ?)"
    ).run(sub.job_id, file.original_name, raw, `from customer submission ${sub.public_id}`, actor.id).lastInsertRowid;
    db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'game_record_source_attached', ?)")
      .run(sub.job_id, actor.id, `gamechanger_export — ${file.original_name} (from ${sub.public_id})`);
    staffEvent(db, sub, actor, 'supporting_imported', `${file.original_name} → game-record source of job #${sub.job_id}`, { file_id: file.id, source_id: id });
    return { kind: 'game_record_source', source_id: id };
  }
  fail('Only a Pocket Radar CSV or a CSV scorecard can be sent to the job automatically — download the file instead.', 409);
}

// ── Close / reopen / manual verification ─────────────────────────────────
export function closeSubmission(db, sub, { outcome = 'closed', reason = '', customer_message = '' } = {}, actor) {
  if (!['closed', 'declined'].includes(outcome)) fail("outcome must be 'closed' or 'declined'");
  if (['draft', 'closed', 'declined'].includes(sub.status)) fail(`The submission is ${sub.status}.`, 409);
  const why = str(reason, 500);
  const toCustomer = str(customer_message, 1000);
  if (!why) fail('Record why (internal).');
  if (outcome === 'declined' && !toCustomer) fail('Tell the customer why we are declining.');
  db.transaction(() => {
    db.prepare(
      "UPDATE intake_submissions SET status = ?, close_reason = ?, customer_message = ?, closed_at = datetime('now'), next_action = '', updated_at = datetime('now') WHERE id = ?"
    ).run(outcome, why, toCustomer, sub.id);
    staffEvent(db, sub, actor, outcome, why);
    if (toCustomer) staffEvent(db, sub, actor, 'message', toCustomer, {}, 'customer');
  })();
  emitIntakeNotification(db, { submissionId: sub.id, eventKey: 'submission_closed', payload: { message: toCustomer } });
  return loadSubmission(db, sub.id);
}

export function reopenSubmission(db, sub, actor, note = '') {
  if (!['closed', 'declined'].includes(sub.status) || sub.close_reason === 'customer_discarded_draft') fail('Only a closed or declined submission can be reopened.', 409);
  const status = sub.job_id ? 'linked' : 'new';
  db.prepare("UPDATE intake_submissions SET status = ?, closed_at = NULL, customer_message = '', next_action = 'Reopened — review', updated_at = datetime('now') WHERE id = ?").run(status, sub.id);
  staffEvent(db, sub, actor, 'reopened', str(note, 500) || 'Reopened');
  return loadSubmission(db, sub.id);
}

export function settingsForIntake(db) {
  return { default_owner_id: Number(settingValue(db, 'intake_default_owner_id')) || null };
}
