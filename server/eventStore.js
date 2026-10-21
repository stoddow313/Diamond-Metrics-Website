// Event registration — data access only: no HTTP, no Stripe. The rules live
// in eventLogic.js; the route modules decide when each write happens (the
// paid transition runs inside the Stripe webhook's transaction).
import { randomBytes } from 'node:crypto';
import { newRegistrationId, parseDays } from './eventLogic.js';
import { slugify } from './rosterLogic.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// ── Events ─────────────────────────────────────────────────────────────────
export const getEvent = (db, id) => db.prepare('SELECT * FROM signup_events WHERE id = ?').get(id) || null;

// The current slug, or an older one that still answers (a printed QR code keeps working).
export function resolveEventSlug(db, slug) {
  return db.prepare('SELECT * FROM signup_events WHERE slug = ?').get(slug)
    || db.prepare('SELECT e.* FROM signup_event_aliases a JOIN signup_events e ON e.id = a.event_id WHERE a.slug = ?').get(slug)
    || null;
}

const slugTaken = (db, slug) => !!(db.prepare('SELECT 1 FROM signup_events WHERE slug = ?').get(slug)
  || db.prepare('SELECT 1 FROM signup_event_aliases WHERE slug = ?').get(slug));

export function freeEventSlug(db, name) {
  const base = slugify(name) || 'event';
  let slug = base;
  while (slugTaken(db, slug)) slug = `${base}-${randomBytes(2).toString('hex')}`;
  return slug;
}

// A new slug keeps the old one as an alias, so every link already printed still opens the page.
export function changeEventSlug(db, event, slug) {
  if (slug === event.slug) return;
  if (db.prepare('SELECT 1 FROM signup_events WHERE slug = ? AND id != ?').get(slug, event.id)) fail(409, 'Another event uses that link.');
  const alias = db.prepare('SELECT event_id FROM signup_event_aliases WHERE slug = ?').get(slug);
  if (alias && alias.event_id !== event.id) fail(409, 'Another event’s old link still uses that address. Pick a different one.');
  if (alias) db.prepare('DELETE FROM signup_event_aliases WHERE slug = ?').run(slug);
  db.prepare('INSERT OR IGNORE INTO signup_event_aliases (slug, event_id) VALUES (?, ?)').run(event.slug, event.id);
  db.prepare('UPDATE signup_events SET slug = ? WHERE id = ?').run(slug, event.id);
}

export const eventAliases = (db, eventId) =>
  db.prepare('SELECT slug, created_at FROM signup_event_aliases WHERE event_id = ? ORDER BY created_at DESC').all(eventId);

const EVENT_COLUMNS = ['name', 'event_type', 'location', 'description', 'what_to_bring', 'days', 'allow_either', 'price_cents', 'status', 'listed', 'opens_on', 'closes_on', 'tournament_id', 'consent_text', 'consent_version'];

export function createEvent(db, fields, actorId) {
  const slug = fields.slug || freeEventSlug(db, fields.name);
  if (slugTaken(db, slug)) fail(409, 'Another event uses that link.');
  const cols = EVENT_COLUMNS.filter(c => fields[c] !== undefined);
  const id = db.prepare(
    `INSERT INTO signup_events (slug, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`
  ).run(slug, ...cols.map(c => fields[c]), actorId ?? null).lastInsertRowid;
  return getEvent(db, id);
}

export function updateEvent(db, event, fields) {
  return db.transaction(() => {
    if (fields.slug) changeEventSlug(db, event, fields.slug);
    const cols = EVENT_COLUMNS.filter(c => fields[c] !== undefined);
    if (cols.length) {
      db.prepare(`UPDATE signup_events SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...cols.map(c => fields[c]), event.id);
    }
    return getEvent(db, event.id);
  })();
}

// Paid registrations per chosen day — what a day's limit counts.
export function paidByDay(db, eventId) {
  return Object.fromEntries(db.prepare(
    "SELECT preferred_day AS day, COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND status = 'paid' GROUP BY preferred_day"
  ).all(eventId).map(r => [r.day, r.n]));
}

// What the desk counts and lists: paid registrations, walk-ups, and unpaid
// ones that reached Stripe (a parent who left checkout may still turn up). A
// registration whose checkout never started is left out.
const ON_DESK = `(r.status = 'paid' OR r.walk_up = 1 OR EXISTS (SELECT 1 FROM event_registration_sessions s WHERE s.registration_id = r.id))`;

export function eventCounts(db, eventId) {
  return db.prepare(
    `SELECT COUNT(*) AS registered,
            COALESCE(SUM(r.status = 'paid'), 0) AS paid,
            COALESCE(SUM(r.status = 'paid' AND r.checked_in_at IS NOT NULL), 0) AS checked_in,
            COALESCE(SUM(r.walk_up = 1), 0) AS walk_ups
       FROM event_registrations r WHERE r.event_id = ? AND ${ON_DESK}`
  ).get(eventId);
}

// Events with their counts, newest first; archived ones only when asked.
export function listEvents(db, { includeArchived = false, ids = null } = {}) {
  const where = [includeArchived ? '1 = 1' : "status != 'archived'"];
  const params = [];
  if (ids) { where.push(`id IN (${ids.map(() => '?').join(',') || 'NULL'})`); params.push(...ids); }
  return db.prepare(`SELECT * FROM signup_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`).all(...params)
    .map(e => ({ ...e, days: parseDays(e.days), counts: eventCounts(db, e.id) }));
}

// ── Registrations ──────────────────────────────────────────────────────────
export function addHistory(db, regPk, type, actorKind, data = {}, actorId = null) {
  db.prepare('INSERT INTO event_registration_history (registration_id, event_type, actor_kind, actor_id, data) VALUES (?, ?, ?, ?, ?)')
    .run(regPk, type, actorKind, actorId, JSON.stringify(data));
}

export const getRegistration = (db, pk) => db.prepare('SELECT * FROM event_registrations WHERE id = ?').get(pk) || null;
export const getRegistrationById = (db, registrationId) =>
  (registrationId ? db.prepare('SELECT * FROM event_registrations WHERE registration_id = ?').get(String(registrationId)) || null : null);
export function getRegistrationBySession(db, sessionId) {
  if (!sessionId) return null;
  return db.prepare('SELECT r.* FROM event_registration_sessions s JOIN event_registrations r ON r.id = s.registration_id WHERE s.session_id = ?').get(String(sessionId)) || null;
}

// Saved before Stripe hears about it (the parent's form, or the booth's walk-up form).
export function createRegistration(db, event, v, { actorKind = 'parent', actorId = null, walkUp = false } = {}) {
  return db.transaction(() => {
    let rid;
    for (let i = 0; i < 8; i++) {
      rid = newRegistrationId();
      if (!getRegistrationById(db, rid)) break;
    }
    const pk = db.prepare(
      `INSERT INTO event_registrations (registration_id, event_id, guardian_name, email, phone, player_name, player_age, player_team,
         preferred_day, consent_version, consent_at, source, walk_up, created_by_kind, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`
    ).run(rid, event.id, v.guardianName, v.email, v.phone || '', v.playerName, v.playerAge, v.playerTeam, v.preferredDay,
      event.consent_version, v.source || (walkUp ? 'booth' : ''), walkUp ? 1 : 0, actorKind, actorId).lastInsertRowid;
    addHistory(db, pk, walkUp ? 'walk_up_created' : 'created', actorKind, { registration_id: rid, event_id: event.id, day: v.preferredDay, consent_version: event.consent_version }, actorId);
    return getRegistration(db, pk);
  })();
}

export function recordSession(db, regPk, sessionId, actorKind = 'parent', actorId = null) {
  db.prepare('INSERT OR IGNORE INTO event_registration_sessions (session_id, registration_id) VALUES (?, ?)').run(sessionId, regPk);
  addHistory(db, regPk, 'checkout_started', actorKind, { session_id: sessionId }, actorId);
}

// checkout.session.completed for an ER- id, inside one transaction: the
// event id is recorded first (a redelivery stops there); the session must be
// one we started for this registration; pending → paid happens once.
export function recordRegistrationCheckout(db, event) {
  const session = event.data?.object || {};
  return db.transaction(() => {
    const reg = getRegistrationById(db, session.client_reference_id);
    if (!reg) return { outcome: 'foreign' };
    const ours = db.prepare('SELECT 1 FROM event_registration_sessions WHERE session_id = ? AND registration_id = ?').get(session.id, reg.id);
    if (!ours) return { outcome: 'session_mismatch', registration: reg };
    const fresh = db.prepare('INSERT OR IGNORE INTO stripe_events (event_id, type, registration_id) VALUES (?, ?, ?)').run(event.id, event.type, reg.id).changes === 1;
    if (!fresh) return { outcome: 'duplicate', registration: reg };
    let outcome = 'not_paid';
    if (session.payment_status === 'paid') {
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
      const changed = db.prepare(
        `UPDATE event_registrations SET status = 'paid', payment_method = 'stripe', amount_total = ?, currency = ?, stripe_session_id = ?,
                stripe_payment_intent_id = ?, paid_event_id = ?, paid_at = datetime('now'), paid_by_kind = 'stripe', updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'`
      ).run(session.amount_total ?? null, session.currency ?? null, session.id, pi, event.id, reg.id).changes === 1;
      outcome = changed ? 'paid' : (reg.payment_method && reg.payment_method !== 'stripe' ? 'paid_twice' : 'already_paid');
      addHistory(db, reg.id, changed ? 'paid' : 'payment_after_paid', 'stripe', { event_id: event.id, session_id: session.id, payment_intent_id: pi, amount_total: session.amount_total ?? null });
    }
    db.prepare('UPDATE stripe_events SET outcome = ? WHERE event_id = ?').run(outcome, event.id);
    return { outcome, registration: getRegistration(db, reg.id) };
  })();
}

// Paid at the booth (cash, Venmo…), or comped: staff only, with a note.
export function markPaidAtBooth(db, reg, { method, note = '', amountCents, actor }) {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE event_registrations SET status = 'paid', payment_method = ?, amount_total = ?, currency = 'usd', paid_at = datetime('now'), paid_note = ?,
              paid_by_kind = ?, paid_by_id = ?, paid_by_name = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`
    ).run(method, method === 'comp' ? 0 : amountCents, String(note || '').slice(0, 500), actor.kind, actor.id, actor.name || '', reg.id).changes === 1;
    if (!changed) fail(409, 'This registration is already paid.');
    addHistory(db, reg.id, 'paid_at_booth', actor.kind, { method }, actor.id);
    return getRegistration(db, reg.id);
  })();
}

// One tap at the booth; tapping again undoes it. Only a change writes history.
export function setCheckedIn(db, reg, checkedIn, actor) {
  return db.transaction(() => {
    const changed = (checkedIn
      ? db.prepare(
        `UPDATE event_registrations SET checked_in_at = datetime('now'), checked_in_by_kind = ?, checked_in_by_id = ?, checked_in_by_name = ?, updated_at = datetime('now')
          WHERE id = ? AND checked_in_at IS NULL`
      ).run(actor.kind, actor.id, actor.name || '', reg.id)
      : db.prepare(
        `UPDATE event_registrations SET checked_in_at = NULL, checked_in_by_kind = NULL, checked_in_by_id = NULL, checked_in_by_name = NULL, updated_at = datetime('now')
          WHERE id = ? AND checked_in_at IS NOT NULL`
      ).run(reg.id)).changes === 1;
    if (changed) addHistory(db, reg.id, checkedIn ? 'checked_in' : 'check_in_undone', actor.kind, {}, actor.id);
    return getRegistration(db, reg.id);
  })();
}

// The desk's list: every registration for the event (paid and unpaid), player A–Z.
export function listRegistrations(db, eventId) {
  return db.prepare(
    `SELECT r.id, r.registration_id, r.status, r.guardian_name, r.email, r.phone, r.player_name, r.player_age, r.player_team, r.preferred_day, r.source, r.walk_up,
            r.payment_method, r.amount_total, r.paid_at, r.paid_note, r.paid_by_name, r.checked_in_at, r.checked_in_by_name, r.created_at
       FROM event_registrations r WHERE r.event_id = ? AND ${ON_DESK} ORDER BY r.player_name COLLATE NOCASE, r.id`
  ).all(eventId);
}

// ── Booth access (staff accounts granted one event) ────────────────────────
export const staffEventIds = (db, email) => db.prepare('SELECT event_id FROM event_users WHERE email = ?').all(email).map(r => r.event_id);
export const staffCanWorkEvent = (db, email, eventId) => !!db.prepare('SELECT 1 FROM event_users WHERE event_id = ? AND email = ?').get(eventId, email);
