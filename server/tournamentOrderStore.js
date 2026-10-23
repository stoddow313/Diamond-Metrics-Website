// Tournament orders — data access only: no HTTP, no Stripe. The rules live in
// tournamentOrderLogic.js; the route modules decide when each write happens
// (the paid transition runs inside the webhook's transaction).
import { DETAIL_FIELDS, newOrderId, packageLabel, tournamentLabel } from './tournamentOrderLogic.js';

// Append to the order's history (tournament_order_events has no UPDATE or
// DELETE). Callers pass ids only — never names, emails or phone numbers;
// actorId is the internal account behind a staff action.
export function addOrderEvent(db, orderPk, type, actorKind, data = {}, actorId = null) {
  db.prepare(
    'INSERT INTO tournament_order_events (order_id, event_type, actor_kind, actor_id, data) VALUES (?, ?, ?, ?, ?)'
  ).run(orderPk, type, actorKind, actorId, JSON.stringify(data));
}

export const getOrder = (db, orderPk) => db.prepare('SELECT * FROM tournament_orders WHERE id = ?').get(orderPk) || null;
export const getOrderByOrderId = (db, orderId) =>
  (orderId ? db.prepare('SELECT * FROM tournament_orders WHERE order_id = ?').get(String(orderId)) || null : null);
export const getOrderBySessionId = (db, sessionId) =>
  (sessionId ? db.prepare('SELECT * FROM tournament_orders WHERE stripe_session_id = ?').get(String(sessionId)) || null : null);

// Saved before Stripe hears about the checkout (handoff §5), with the Price the
// server chose. The order id is random and retried on the rare collision.
export function createPendingOrder(db, { guardianName, playerName, teamName = '', email, phone = '', tournamentId, packageKey, priceId, kind = 'player' }) {
  return db.transaction(() => {
    let orderId;
    for (let i = 0; i < 8; i++) {
      orderId = newOrderId();
      if (!db.prepare('SELECT 1 FROM tournament_orders WHERE order_id = ?').get(orderId)) break;
    }
    const id = db.prepare(
      `INSERT INTO tournament_orders (order_id, order_kind, guardian_name, player_name, team_name, email, phone, tournament_id, package_key, price_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(orderId, kind, guardianName, playerName || '', teamName || '', email, phone, tournamentId, packageKey, priceId).lastInsertRowid;
    addOrderEvent(db, id, 'created', 'parent', { order_id: orderId, order_kind: kind, package_key: packageKey, price_id: priceId });
    return getOrder(db, id);
  })();
}

// The Checkout Session made for this order. Set once: a stored session id is
// never replaced, so an event for some other session cannot claim the order.
export function attachSession(db, orderPk, sessionId) {
  const changed = db.prepare(
    "UPDATE tournament_orders SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ? AND stripe_session_id IS NULL"
  ).run(sessionId, orderPk).changes === 1;
  if (changed) addOrderEvent(db, orderPk, 'checkout_started', 'stripe', { session_id: sessionId });
  return changed;
}

// true the first time an event id is seen, false for every redelivery.
export function recordStripeEvent(db, { eventId, type, orderPk = null, outcome = '' }) {
  return db.prepare(
    'INSERT OR IGNORE INTO stripe_events (event_id, type, order_id, outcome) VALUES (?, ?, ?, ?)'
  ).run(eventId, type, orderPk, outcome).changes === 1;
}

// pending → paid, once. paid_at is the arrival of the first paid event; a
// second event for the same session finds the order already paid and changes
// nothing. Returns whether this call made the transition.
export function markPaid(db, orderPk, { sessionId, paymentIntentId = null, amountTotal = null, currency = null, paymentStatus, eventId }) {
  const changed = db.prepare(
    `UPDATE tournament_orders
        SET status = 'paid', stripe_payment_intent_id = ?, amount_total = ?, currency = ?, payment_status = ?,
            paid_event_id = ?, paid_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND stripe_session_id = ?`
  ).run(paymentIntentId, amountTotal, currency, paymentStatus, eventId, orderPk, sessionId).changes === 1;
  if (changed) {
    addOrderEvent(db, orderPk, 'paid', 'stripe', {
      event_id: eventId, session_id: sessionId, payment_intent_id: paymentIntentId, amount_total: amountTotal, currency,
    });
  }
  return changed;
}

// The identification step (a player's, or a team order's TEAM_DETAIL_FIELDS).
// A later send from the same link replaces the earlier details; the history
// says which one it was.
export function saveDetails(db, orderPk, details, fields = DETAIL_FIELDS) {
  return db.transaction(() => {
    const replacing = Boolean(getOrder(db, orderPk)?.details_received_at);
    const columns = fields.map(f => `${f.column} = ?`).join(', ');
    db.prepare(
      `UPDATE tournament_orders SET ${columns}, details_received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(...fields.map(f => details[f.key] ?? ''), orderPk);
    addOrderEvent(db, orderPk, replacing ? 'details_replaced' : 'details_received', 'parent');
    return replacing ? 'replaced' : 'received';
  })();
}

// Will's one action on the list: a paid order is delivered once its analysis
// has gone to the parent, and the mark can be taken back. Only a change writes
// history, so marking twice leaves one "delivered" row. Returns whether this
// call changed the order.
export function setDelivered(db, orderPk, delivered, actorId) {
  return db.transaction(() => {
    const changed = (delivered
      ? db.prepare(
        `UPDATE tournament_orders SET delivered_at = datetime('now'), delivered_by = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'paid' AND delivered_at IS NULL`
      ).run(actorId, orderPk)
      : db.prepare(
        `UPDATE tournament_orders SET delivered_at = NULL, delivered_by = NULL, updated_at = datetime('now')
          WHERE id = ? AND status = 'paid' AND delivered_at IS NOT NULL`
      ).run(orderPk)).changes === 1;
    if (changed) addOrderEvent(db, orderPk, delivered ? 'delivered' : 'delivery_undone', 'staff', {}, actorId);
    return changed;
  })();
}

// A team order joins its team's tournament entry: the order then covers that
// entry's event roster (who gets the included analytics). Unlinking returns
// it to "roster match needed". Only a change writes history.
export function setTeamMatch(db, orderPk, entryId, actorId) {
  return db.transaction(() => {
    const entry = entryId == null ? null : db.prepare('SELECT id, team_id FROM tournament_entries WHERE id = ?').get(entryId);
    if (entryId != null && !entry) return { error: 'That tournament team was not found.' };
    const changed = (entry
      ? db.prepare(
        `UPDATE tournament_orders SET entry_id = ?, team_id = ?, team_matched_at = datetime('now'), team_matched_by = ?, updated_at = datetime('now')
          WHERE id = ? AND order_kind = 'team' AND status = 'paid' AND (entry_id IS NULL OR entry_id != ?)`
      ).run(entry.id, entry.team_id, actorId, orderPk, entry.id)
      : db.prepare(
        `UPDATE tournament_orders SET entry_id = NULL, team_id = NULL, team_matched_at = NULL, team_matched_by = NULL, updated_at = datetime('now')
          WHERE id = ? AND order_kind = 'team' AND entry_id IS NOT NULL`
      ).run(orderPk)).changes === 1;
    if (changed) addOrderEvent(db, orderPk, entry ? 'team_matched' : 'team_unmatched', 'staff', entry ? { entry_id: entry.id, team_id: entry.team_id } : {}, actorId);
    return { changed };
  })();
}

// The tournament teams a team order can be matched to: every entry of a
// tournament not archived, with its roster size, newest tournament first.
export function teamEntriesForMatching(db) {
  return db.prepare(
    `SELECT te.id AS entry_id, t.name AS team_name, d.name AS division, tr.name AS tournament_name, tr.start_date,
            (SELECT COUNT(*) FROM event_rosters er WHERE er.entry_id = te.id) AS roster_count
       FROM tournament_entries te
       JOIN teams t ON t.id = te.team_id
       JOIN divisions d ON d.id = te.division_id
       JOIN tournaments tr ON tr.id = te.tournament_id
      WHERE tr.archived = 0 AND te.status != 'archived'
      ORDER BY tr.start_date DESC, t.name COLLATE NOCASE, d.name`
  ).all();
}

// What the Command list shows for a paid order (prd.md R4), plus the
// delivered mark and who set it, and for a team order the tournament team it
// is matched to.
const PAID_ORDER_VIEW = `
  SELECT o.order_id, o.order_kind, o.paid_at, o.package_key, o.amount_total, o.currency, o.tournament_id,
         o.guardian_name, o.email, o.phone, o.player_name, o.team_name,
         o.team_club, o.jersey_number, o.primary_position, o.bats_throws, o.game_context, o.notes, o.details_received_at,
         o.team_division, o.head_coach,
         o.stripe_session_id, o.stripe_payment_intent_id,
         o.delivered_at, a.name AS delivered_by,
         o.entry_id, o.team_matched_at, m.name AS team_matched_by,
         mt.name AS matched_team, md.name AS matched_division, mtr.name AS matched_tournament
    FROM tournament_orders o
    LEFT JOIN admins a ON a.id = o.delivered_by
    LEFT JOIN admins m ON m.id = o.team_matched_by
    LEFT JOIN tournament_entries me ON me.id = o.entry_id
    LEFT JOIN teams mt ON mt.id = me.team_id
    LEFT JOIN divisions md ON md.id = me.division_id
    LEFT JOIN tournaments mtr ON mtr.id = me.tournament_id
   WHERE o.status = 'paid'`;
const rosterOf = (db, entryId) => db.prepare(
  `SELECT p.id AS player_id, p.first_name, p.last_name, er.jersey, er.is_guest FROM event_rosters er JOIN players p ON p.id = er.player_id
    WHERE er.entry_id = ? ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`
).all(entryId);
const labelled = (db, o) => ({
  ...o, package_label: packageLabel(o.package_key), tournament_label: tournamentLabel(o.tournament_id),
  ...(o.order_kind === 'team' ? { roster: o.entry_id ? rosterOf(db, o.entry_id) : [] } : {}),
});

// Paid orders only, newest paid first, with what staff need to fulfil each
// one (prd.md R4). Pending and abandoned checkouts never appear.
export function listPaidOrders(db) {
  return db.prepare(`${PAID_ORDER_VIEW} ORDER BY o.paid_at DESC, o.id DESC`).all().map(o => labelled(db, o));
}

// One row of that list, or null when the order is unknown or not paid.
export function getPaidOrderView(db, orderId) {
  const o = db.prepare(`${PAID_ORDER_VIEW} AND o.order_id = ?`).get(String(orderId));
  return o ? labelled(db, o) : null;
}
