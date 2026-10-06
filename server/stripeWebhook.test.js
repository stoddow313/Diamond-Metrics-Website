// POST /api/stripe/webhook through the HTTP API with real Stripe signatures
// (generateTestHeaderString, no network): only a signed checkout.session.
// completed for an order's own session marks it paid, exactly once, matched
// by order id and session — never by a name or an email (prd.md R2, R6).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-stripe-webhook-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-stripe-webhook-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const SECRET = 'whsec_test_webhook_secret_for_tests';
const { startIntakeApp } = await import('./intakeTestHarness.js');
const { stripeWebhooks } = await import('./stripeConfig.js');
const { createPendingOrder, attachSession, getOrder } = await import('./tournamentOrderStore.js');

let h, db;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
});
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});
after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

let n = 0;
function newOrder({ session = true, guardianName = 'Jordan Example', playerName = 'Sky Example', email = 'jordan@example.com', packageKey = 'tournament_pro' } = {}) {
  const o = createPendingOrder(db, { guardianName, playerName, email, phone: '', tournamentId: 'better-baseball-nephi-2026', packageKey, priceId: 'price_TestD' });
  const sessionId = `cs_test_hook${++n}`;
  if (session) attachSession(db, o.id, sessionId);
  return { ...getOrder(db, o.id), sessionId };
}

function completed(order, { eventId = `evt_hook${++n}`, sessionId = order.sessionId, clientReferenceId = order.order_id, paymentStatus = 'paid', amountTotal = 15000 } = {}) {
  return {
    id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: {
      id: sessionId, object: 'checkout.session', client_reference_id: clientReferenceId, payment_status: paymentStatus,
      payment_intent: `pi_test_${n}`, amount_total: amountTotal, currency: 'usd', mode: 'payment',
      metadata: { order_id: clientReferenceId, package_key: 'tournament_pro' },
    } },
  };
}

async function deliver(event, { secret = SECRET, signature, pretty = false } = {}) {
  const payload = pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (signature !== null) headers['Stripe-Signature'] = signature || stripeWebhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${h.base}/api/stripe/webhook`, { method: 'POST', headers, body: payload });
  return { status: res.status, body: await res.json() };
}
const paidEvents = pk => db.prepare("SELECT COUNT(*) n FROM tournament_order_events WHERE order_id = ? AND event_type = 'paid'").get(pk).n;

test('an unsigned, forged or wrongly signed delivery is refused and changes nothing', async () => {
  const o = newOrder();
  const event = completed(o);
  assert.equal((await deliver(event, { signature: null })).status, 400);
  assert.equal((await deliver(event, { signature: 't=1791000000,v1=0000000000000000000000000000000000000000000000000000000000000000' })).status, 400);
  assert.equal((await deliver(event, { secret: 'whsec_someone_elses' })).status, 400);
  const stale = stripeWebhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await deliver(event, { signature: stale })).status, 400, 'an old signature is outside the tolerance');
  assert.equal(getOrder(db, o.id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stripe_events WHERE event_id = ?').get(event.id).n, 0);
});

test('a signed paid event marks its order paid with Stripe’s ids, amount and time', async () => {
  const o = newOrder();
  const r = await deliver(completed(o, { eventId: 'evt_paid_once' }), { pretty: true });
  assert.equal(r.status, 200, 'the signature is checked over the raw bytes, whitespace and all');
  assert.deepEqual(r.body, { received: true });
  const paid = getOrder(db, o.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.stripe_session_id, o.sessionId);
  assert.match(paid.stripe_payment_intent_id, /^pi_test_/);
  assert.equal(paid.amount_total, 15000);
  assert.equal(paid.currency, 'usd');
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.paid_event_id, 'evt_paid_once');
  assert.ok(paid.paid_at);
  assert.equal(paidEvents(o.id), 1);
});

test('the same event twice, or two events for one session, leave one paid order', async () => {
  const o = newOrder();
  const first = completed(o, { eventId: 'evt_dup_1' });
  assert.equal((await deliver(first)).status, 200);
  const paidAt = getOrder(db, o.id).paid_at;
  db.prepare("UPDATE tournament_orders SET paid_at = '2026-10-09 16:18:00' WHERE id = ?").run(o.id);
  assert.equal((await deliver(first)).status, 200, 'a redelivery is acknowledged');
  assert.equal((await deliver(first)).status, 200);
  assert.equal((await deliver(completed(o, { eventId: 'evt_dup_2' }))).status, 200, 'a second event for the session too');
  const after_ = getOrder(db, o.id);
  assert.ok(paidAt);
  assert.equal(after_.paid_at, '2026-10-09 16:18:00', 'the first paid time is kept');
  assert.equal(after_.paid_event_id, 'evt_dup_1');
  assert.equal(paidEvents(o.id), 1, 'one "paid" history row');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournament_orders WHERE stripe_session_id = ?").get(o.sessionId).n, 1);
  assert.deepEqual(db.prepare("SELECT event_id, outcome FROM stripe_events WHERE order_id = ? ORDER BY event_id").all(o.id), [
    { event_id: 'evt_dup_1', outcome: 'paid' }, { event_id: 'evt_dup_2', outcome: 'already_paid' },
  ]);
});

test('two deliveries arriving together still make one transition', async () => {
  const o = newOrder();
  const results = await Promise.all([deliver(completed(o, { eventId: 'evt_race_a' })), deliver(completed(o, { eventId: 'evt_race_b' })), deliver(completed(o, { eventId: 'evt_race_a' }))]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
  assert.equal(getOrder(db, o.id).status, 'paid');
  assert.equal(paidEvents(o.id), 1);
});

test('a session this server did not make is acknowledged and ignored', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM tournament_orders WHERE status = 'paid'").get().n;
  const trigger = completed({ order_id: null, sessionId: 'cs_test_from_stripe_trigger' }, { clientReferenceId: null });
  assert.equal((await deliver(trigger)).status, 200, 'stripe trigger checkout.session.completed');
  const paymentLink = completed({ order_id: 'TO-ZZZZ-ZZZZ', sessionId: 'cs_test_payment_link' });
  assert.equal((await deliver(paymentLink)).status, 200, 'an unknown order id');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournament_orders WHERE status = 'paid'").get().n, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournament_orders WHERE stripe_session_id IN ('cs_test_from_stripe_trigger', 'cs_test_payment_link')").get().n, 0);
});

test('an event for some other session cannot pay an order', async () => {
  const o = newOrder();
  const r = await deliver(completed(o, { sessionId: 'cs_test_not_this_orders' }));
  assert.equal(r.status, 200);
  assert.equal(getOrder(db, o.id).status, 'pending');
  assert.equal(getOrder(db, o.id).stripe_session_id, o.sessionId);
});

test('if the session id was never saved, the paid event supplies it', async () => {
  const o = newOrder({ session: false });
  assert.equal(o.stripe_session_id, null);
  assert.equal((await deliver(completed(o, { sessionId: 'cs_test_saved_late' }))).status, 200);
  const paid = getOrder(db, o.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.stripe_session_id, 'cs_test_saved_late');
});

test('a completed session that is not paid yet leaves the order pending', async () => {
  const o = newOrder();
  assert.equal((await deliver(completed(o, { paymentStatus: 'unpaid' }))).status, 200);
  assert.equal(getOrder(db, o.id).status, 'pending');
  assert.equal(paidEvents(o.id), 0);
});

test('other event types are acknowledged and ignored', async () => {
  const o = newOrder();
  const event = { ...completed(o), type: 'checkout.session.expired' };
  assert.equal((await deliver(event)).status, 200);
  assert.equal(getOrder(db, o.id).status, 'pending');
});

test('orders are matched by order id and session, never by name or email', async () => {
  const twin1 = newOrder({ guardianName: 'Casey Twin', playerName: 'Riley Twin', email: 'twin@example.com', packageKey: 'individual_basic' });
  const twin2 = newOrder({ guardianName: 'Casey Twin', playerName: 'Riley Twin', email: 'twin@example.com', packageKey: 'individual_basic' });
  assert.equal((await deliver(completed(twin2, { amountTotal: 5000 }))).status, 200);
  assert.equal(getOrder(db, twin1.id).status, 'pending', 'the unpaid twin stays pending');
  assert.equal(getOrder(db, twin2.id).status, 'paid');
});

test('a database failure answers 500 so Stripe retries, and the retry lands', async () => {
  const o = newOrder();
  const event = completed(o, { eventId: 'evt_db_down' });
  db.exec('ALTER TABLE stripe_events RENAME TO stripe_events_offline');
  try {
    assert.equal((await deliver(event)).status, 500);
  } finally {
    db.exec('ALTER TABLE stripe_events_offline RENAME TO stripe_events');
  }
  assert.equal(getOrder(db, o.id).status, 'pending', 'nothing half-written');
  assert.equal((await deliver(event)).status, 200);
  assert.equal(getOrder(db, o.id).status, 'paid');
});

test('without a signing secret or a key the webhook refuses and changes nothing', async () => {
  const o = newOrder();
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal((await deliver(completed(o))).status, 400);
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await deliver(completed(o))).status, 400);
  assert.equal(getOrder(db, o.id).status, 'pending');
});
