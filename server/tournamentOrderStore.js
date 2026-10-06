// Tournament orders — data access only: no HTTP, no Stripe. The rules live in
// tournamentOrderLogic.js; the route modules decide when each write happens
// (the paid transition runs inside the webhook's transaction).
import { DETAIL_FIELDS, newOrderId, packageLabel, tournamentLabel } from './tournamentOrderLogic.js';

// Append to the order's history (tournament_order_events has no UPDATE or
// DELETE). Callers pass ids only — never names, emails or phone numbers.
export function addOrderEvent(db, orderPk, type, actorKind, data = {}) {
  db.prepare(
    'INSERT INTO tournament_order_events (order_id, event_type, actor_kind, data) VALUES (?, ?, ?, ?)'
  ).run(orderPk, type, actorKind, JSON.stringify(data));
}

export const getOrder = (db, orderPk) => db.prepare('SELECT * FROM tournament_orders WHERE id = ?').get(orderPk) || null;
export const getOrderByOrderId = (db, orderId) =>
  (orderId ? db.prepare('SELECT * FROM tournament_orders WHERE order_id = ?').get(String(orderId)) || null : null);
export const getOrderBySessionId = (db, sessionId) =>
  (sessionId ? db.prepare('SELECT * FROM tournament_orders WHERE stripe_session_id = ?').get(String(sessionId)) || null : null);

// Saved before Stripe hears about the checkout (handoff §5), with the Price the
// server chose. The order id is random and retried on the rare collision.
export function createPendingOrder(db, { guardianName, playerName, email, phone = '', tournamentId, packageKey, priceId }) {
  return db.transaction(() => {
    let orderId;
    for (let i = 0; i < 8; i++) {
      orderId = newOrderId();
      if (!db.prepare('SELECT 1 FROM tournament_orders WHERE order_id = ?').get(orderId)) break;
    }
    const id = db.prepare(
      `INSERT INTO tournament_orders (order_id, guardian_name, player_name, email, phone, tournament_id, package_key, price_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(orderId, guardianName, playerName, email, phone, tournamentId, packageKey, priceId).lastInsertRowid;
    addOrderEvent(db, id, 'created', 'parent', { order_id: orderId, package_key: packageKey, price_id: priceId });
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

// The identification step. A later send from the same link replaces the
// earlier details; the history says which one it was.
export function saveDetails(db, orderPk, details) {
  return db.transaction(() => {
    const replacing = Boolean(getOrder(db, orderPk)?.details_received_at);
    const columns = DETAIL_FIELDS.map(f => `${f.column} = ?`).join(', ');
    db.prepare(
      `UPDATE tournament_orders SET ${columns}, details_received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(...DETAIL_FIELDS.map(f => details[f.key] ?? ''), orderPk);
    addOrderEvent(db, orderPk, replacing ? 'details_replaced' : 'details_received', 'parent');
    return replacing ? 'replaced' : 'received';
  })();
}

// Paid orders only, newest paid first, with what staff need to fulfil each
// one (prd.md R4). Pending and abandoned checkouts never appear.
export function listPaidOrders(db) {
  return db.prepare(
    `SELECT order_id, paid_at, package_key, amount_total, currency, tournament_id,
            guardian_name, email, phone, player_name,
            team_club, jersey_number, primary_position, bats_throws, game_context, notes, details_received_at,
            stripe_session_id, stripe_payment_intent_id
       FROM tournament_orders
      WHERE status = 'paid'
      ORDER BY paid_at DESC, id DESC`
  ).all().map(o => ({ ...o, package_label: packageLabel(o.package_key), tournament_label: tournamentLabel(o.tournament_id) }));
}
