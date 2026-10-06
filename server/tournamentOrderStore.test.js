// Tournament orders — data access: pending orders, the one-time paid
// transition, details saved and replaced, the append-only history and the
// paid-only list staff read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-store-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const {
  createPendingOrder, attachSession, recordStripeEvent, markPaid, saveDetails, listPaidOrders,
  getOrder, getOrderByOrderId, getOrderBySessionId,
} = await import('./tournamentOrderStore.js');

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

const ORDER = {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com', phone: '555-0100',
  tournamentId: 'better-baseball-nephi-2026', packageKey: 'tournament_pro', priceId: 'price_TestD',
};
const events = pk => db.prepare('SELECT event_type, actor_kind, data FROM tournament_order_events WHERE order_id = ? ORDER BY id').all(pk);
const paidWith = (order, eventId) => ({ sessionId: order.stripe_session_id, paymentIntentId: 'pi_test_1', amountTotal: 15000, currency: 'usd', paymentStatus: 'paid', eventId });

test('a pending order holds the checkout fields and a random order id', () => {
  const o = createPendingOrder(db, ORDER);
  assert.equal(o.status, 'pending');
  assert.match(o.order_id, /^TO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(o.order_id, String(o.id));
  assert.equal(o.guardian_name, 'Jordan Example');
  assert.equal(o.package_key, 'tournament_pro');
  assert.equal(o.price_id, 'price_TestD');
  assert.equal(o.stripe_session_id, null);
  assert.equal(o.paid_at, null);
  assert.deepEqual(events(o.id).map(e => e.event_type), ['created']);
  assert.ok(!events(o.id)[0].data.includes('Jordan') && !events(o.id)[0].data.includes('@'), 'history carries ids only');
  assert.equal(getOrderByOrderId(db, o.order_id).id, o.id);
  assert.equal(getOrderByOrderId(db, ''), null);
  assert.equal(getOrderBySessionId(db, undefined), null);
});

test('a session id is attached once and never replaced', () => {
  const o = createPendingOrder(db, ORDER);
  assert.equal(attachSession(db, o.id, 'cs_test_first'), true);
  assert.equal(attachSession(db, o.id, 'cs_test_second'), false);
  assert.equal(getOrder(db, o.id).stripe_session_id, 'cs_test_first');
  assert.equal(getOrderBySessionId(db, 'cs_test_first').id, o.id);
  assert.equal(getOrderBySessionId(db, 'cs_test_second'), null);
});

test('pending becomes paid exactly once, for its own session only', () => {
  const o = createPendingOrder(db, ORDER);
  attachSession(db, o.id, 'cs_test_paid_once');
  const order = getOrder(db, o.id);
  assert.equal(markPaid(db, o.id, { ...paidWith(order, 'evt_1'), sessionId: 'cs_test_someone_else' }), false, 'another session cannot pay this order');
  assert.equal(getOrder(db, o.id).status, 'pending');
  assert.equal(markPaid(db, o.id, paidWith(order, 'evt_1')), true);
  const paid = getOrder(db, o.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.amount_total, 15000);
  assert.equal(paid.currency, 'usd');
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.stripe_payment_intent_id, 'pi_test_1');
  assert.equal(paid.paid_event_id, 'evt_1');
  assert.ok(paid.paid_at);
  assert.equal(markPaid(db, o.id, { ...paidWith(order, 'evt_2'), paymentIntentId: 'pi_test_other' }), false, 'a second event changes nothing');
  const again = getOrder(db, o.id);
  assert.equal(again.paid_event_id, 'evt_1');
  assert.equal(again.paid_at, paid.paid_at);
  assert.equal(again.stripe_payment_intent_id, 'pi_test_1');
  assert.deepEqual(events(o.id).map(e => e.event_type), ['created', 'checkout_started', 'paid']);
});

test('a Stripe event id is recorded once', () => {
  assert.equal(recordStripeEvent(db, { eventId: 'evt_once', type: 'checkout.session.completed', outcome: 'paid' }), true);
  assert.equal(recordStripeEvent(db, { eventId: 'evt_once', type: 'checkout.session.completed', outcome: 'paid' }), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stripe_events WHERE event_id = 'evt_once'").get().n, 1);
});

test('details are saved, then replaced by a later send', () => {
  const o = createPendingOrder(db, ORDER);
  const first = { teamClub: 'Example Hawks 14U', jerseyNumber: '12', primaryPosition: 'Shortstop', batsThrows: 'R/R', gameContext: '', notes: '' };
  assert.equal(saveDetails(db, o.id, first), 'received');
  let row = getOrder(db, o.id);
  assert.equal(row.team_club, 'Example Hawks 14U');
  assert.equal(row.jersey_number, '12');
  assert.equal(row.bats_throws, 'R/R');
  assert.ok(row.details_received_at);
  assert.equal(saveDetails(db, o.id, { ...first, jerseyNumber: '21', notes: 'Wears a blue sleeve' }), 'replaced');
  row = getOrder(db, o.id);
  assert.equal(row.jersey_number, '21');
  assert.equal(row.notes, 'Wears a blue sleeve');
  assert.equal(row.status, 'pending', 'saving details never marks an order paid');
  assert.deepEqual(events(o.id).map(e => e.event_type), ['created', 'details_received', 'details_replaced']);
});

test('the order history is append-only', () => {
  const o = createPendingOrder(db, ORDER);
  assert.throws(() => db.prepare("UPDATE tournament_order_events SET event_type = 'paid' WHERE order_id = ?").run(o.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM tournament_order_events WHERE order_id = ?').run(o.id), /append-only/);
});

test('staff see paid orders only, newest paid first, with labels', () => {
  const older = createPendingOrder(db, { ...ORDER, packageKey: 'individual_basic', playerName: 'Older Paid' });
  attachSession(db, older.id, 'cs_test_list_older');
  markPaid(db, older.id, { ...paidWith(getOrder(db, older.id), 'evt_list_1'), amountTotal: 5000 });
  db.prepare("UPDATE tournament_orders SET paid_at = datetime('now', '-1 hour') WHERE id = ?").run(older.id);
  const newer = createPendingOrder(db, ORDER);
  attachSession(db, newer.id, 'cs_test_list_newer');
  markPaid(db, newer.id, paidWith(getOrder(db, newer.id), 'evt_list_2'));
  saveDetails(db, newer.id, { teamClub: 'Example Hawks 14U', jerseyNumber: '12', primaryPosition: 'Shortstop' });
  createPendingOrder(db, { ...ORDER, playerName: 'Never Paid' });

  const list = listPaidOrders(db);
  assert.ok(list.every(o => o.player_name !== 'Never Paid'), 'pending orders never appear');
  const mine = list.filter(o => [older.order_id, newer.order_id].includes(o.order_id));
  assert.deepEqual(mine.map(o => o.order_id), [newer.order_id, older.order_id]);
  assert.deepEqual(Object.keys(mine[0]).sort(), [
    'amount_total', 'bats_throws', 'currency', 'details_received_at', 'email', 'game_context', 'guardian_name',
    'jersey_number', 'notes', 'order_id', 'package_key', 'package_label', 'paid_at', 'phone', 'player_name',
    'primary_position', 'stripe_payment_intent_id', 'stripe_session_id', 'team_club', 'tournament_id', 'tournament_label',
  ]);
  assert.equal(mine[0].package_label, 'Single Tournament — Pro');
  assert.equal(mine[0].tournament_label, 'Better Baseball — Nephi, Utah · October 9–10, 2026');
  assert.equal(mine[0].team_club, 'Example Hawks 14U');
  assert.equal(mine[1].package_label, 'Individual Game — Basic');
  assert.equal(mine[1].details_received_at, null, 'no details yet: "Details missing"');
});
