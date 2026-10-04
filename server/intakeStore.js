// Shared data access for the customer intake: the timeline, account linking,
// and the staff-verified relationships a customer is allowed to see.
import { normalizeEmail, safeJson } from './intakeLogic.js';

// Append to the immutable timeline (intake_events has no UPDATE/DELETE).
export function addEvent(db, { submissionId = null, accountId = null, actorKind, actorId = null, type, message = '', data = {}, visibility = 'internal' }) {
  db.prepare(
    `INSERT INTO intake_events (submission_id, account_id, actor_kind, actor_id, event_type, visibility, message, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(submissionId, accountId, actorKind, actorId, type, visibility, String(message || '').slice(0, 2000), JSON.stringify(data || {}));
  if (submissionId) db.prepare("UPDATE intake_submissions SET last_activity_at = datetime('now') WHERE id = ?").run(submissionId);
}

export const getAccount = (db, id) => db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(id) || null;

// A coach or player who already has a staff/player login submits under one
// contact record, found or created by email. password_hash stays NULL on a
// provisioned record — the person keeps signing in with their existing login.
export function provisionAccount(db, { email, first_name = '', last_name = '', role = 'parent', staff_user_id = null, player_user_id = null, player_id = null }) {
  const normalized = normalizeEmail(email);
  let account = db.prepare('SELECT * FROM customer_accounts WHERE email = ?').get(normalized);
  if (!account) {
    const id = db.prepare(
      `INSERT INTO customer_accounts (email, first_name, last_name, role, staff_user_id, player_user_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(normalized, first_name, last_name, role, staff_user_id, player_user_id).lastInsertRowid;
    addEvent(db, { accountId: id, actorKind: 'system', type: 'account_linked_login', message: staff_user_id ? 'Contact created from a coach/director login' : 'Contact created from a player portal login' });
    account = getAccount(db, id);
  } else {
    if (staff_user_id && !account.staff_user_id) db.prepare('UPDATE customer_accounts SET staff_user_id = ? WHERE id = ?').run(staff_user_id, account.id);
    if (player_user_id && !account.player_user_id) db.prepare('UPDATE customer_accounts SET player_user_id = ? WHERE id = ?').run(player_user_id, account.id);
    account = getAccount(db, account.id);
  }
  // An admin issued that player invite for that player, so the link is
  // already verified — it becomes one of "my athletes".
  if (player_id) {
    db.prepare(
      `INSERT OR IGNORE INTO customer_athletes (account_id, player_id, relationship, verified_by) VALUES (?, ?, 'invite_claim', NULL)`
    ).run(account.id, player_id);
  }
  return account;
}

export function verifiedAthletes(db, accountId) {
  return db.prepare(
    `SELECT ca.player_id, ca.relationship, ca.verified_at, p.first_name, p.last_name, p.date_of_birth, p.slug, p.is_public
       FROM customer_athletes ca JOIN players p ON p.id = ca.player_id
      WHERE ca.account_id = ? ORDER BY p.first_name, p.last_name`
  ).all(accountId).map(a => ({
    player_id: a.player_id, relationship: a.relationship, first_name: a.first_name, last_name: a.last_name,
    birth_year: a.date_of_birth ? Number(String(a.date_of_birth).slice(0, 4)) : null,
    slug: a.is_public ? a.slug : null,
  }));
}

export function verifiedTeams(db, accountId) {
  return db.prepare(
    `SELECT l.team_id, l.relationship, t.name, t.age_group, o.name AS organization_name
       FROM customer_team_links l JOIN teams t ON t.id = l.team_id JOIN organizations o ON o.id = t.organization_id
      WHERE l.account_id = ? ORDER BY t.name`
  ).all(accountId);
}

export function latestRights(db, submissionId) {
  return db.prepare('SELECT * FROM intake_rights WHERE submission_id = ? ORDER BY id DESC LIMIT 1').get(submissionId) || null;
}

export function accountView(account) {
  return {
    id: account.id,
    email: account.email,
    email_verified: !!account.email_verified_at,
    first_name: account.first_name,
    last_name: account.last_name,
    phone: account.phone,
    role: account.role,
    preferred_contact: account.preferred_contact,
    organization: account.organization,
    has_password: !!account.password_hash,
  };
}

export function settingValue(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value, actorId = null) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, String(value ?? ''), actorId);
}

export const parseForm = sub => safeJson(sub.form);
