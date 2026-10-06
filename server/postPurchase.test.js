// POST /api/post-purchase-intake through the HTTP API, with a stubbed Stripe
// client: details are kept only for a verified payment, an unknown or unpaid
// link gets one refusal and stores nothing, a later send replaces the first,
// and the endpoint never marks an order paid (prd.md R3, AC12-AC15).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-post-purchase-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-post-purchase-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const SECRET = 'whsec_test_post_purchase';
const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests, stripeWebhooks } = await import('./stripeConfig.js');
const { createPendingOrder, attachSession, markPaid, getOrder } = await import('./tournamentOrderStore.js');

const NOT_CONFIRMED = 'We could not confirm a payment for this order. If you were charged, email info@diamondmetrics.ai.';
const DETAILS = { teamClub: 'Example Hawks 14U', jerseyNumber: '12', primaryPosition: 'Shortstop', batsThrows: 'R/R', gameContext: '', notes: '' };

// What Stripe would say about each session; a session missing here is unknown to Stripe.
const atStripe = new Map();
const retrieved = [];
let outage = false;
const stripeStub = {
  checkout: {
    sessions: {
      async retrieve(id) {
        retrieved.push(id);
        if (outage) throw Object.assign(new Error('connect ECONNREFUSED'), { type: 'StripeConnectionError' });
        if (!atStripe.has(id)) throw Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
        return atStripe.get(id);
      },
    },
  },
};

let h, db;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  setStripeClientForTests(stripeStub);
});
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  retrieved.length = 0;
  outage = false;
});
after(async () => {
  setStripeClientForTests(null);
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

let n = 0;
function order({ paid = false } = {}) {
  const o = createPendingOrder(db, {
    guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com', phone: '555-0100',
    tournamentId: 'better-baseball-nephi-2026', packageKey: 'tournament_pro', priceId: 'price_TestD',
  });
  const sessionId = `cs_test_pp${++n}`;
  attachSession(db, o.id, sessionId);
  if (paid) markPaid(db, o.id, { sessionId, paymentIntentId: `pi_test_${n}`, amountTotal: 15000, currency: 'usd', paymentStatus: 'paid', eventId: `evt_pp${n}` });
  return { ...getOrder(db, o.id), sessionId };
}
const send = body => h.call('POST', '/api/post-purchase-intake', { body });
const history = pk => db.prepare('SELECT event_type FROM tournament_order_events WHERE order_id = ? ORDER BY id').all(pk).map(e => e.event_type);
const noPii = reply => assert.ok(!/Jordan|Sky Example|jordan@example\.com|555-0100|Example Hawks|Shortstop/.test(JSON.stringify(reply.body)), 'the reply echoes nothing');

test('a webhook-paid order takes the details; sending again replaces them', async () => {
  const o = order({ paid: true });
  const first = await send({ sessionId: o.sessionId, ...DETAILS });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, orderId: o.order_id }, 'the order number, for "Order received", and nothing else');
  noPii(first);
  let row = getOrder(db, o.id);
  assert.equal(row.team_club, 'Example Hawks 14U');
  assert.equal(row.jersey_number, '12');
  assert.equal(row.primary_position, 'Shortstop');
  assert.equal(row.bats_throws, 'R/R');
  assert.ok(row.details_received_at);
  assert.equal(retrieved.length, 0, 'a webhook-paid order needs no question to Stripe');

  const again = await send({ sessionId: o.sessionId, ...DETAILS, jerseyNumber: '21', gameContext: 'Sat 9:00 vs Example Peak' });
  assert.equal(again.status, 200);
  row = getOrder(db, o.id);
  assert.equal(row.jersey_number, '21');
  assert.equal(row.game_context, 'Sat 9:00 vs Example Peak');
  assert.deepEqual(history(o.id), ['created', 'checkout_started', 'paid', 'details_received', 'details_replaced']);
});

test('an unknown or made-up link is refused, stores nothing, and Stripe is never asked', async () => {
  for (const sessionId of ['cs_test_golden_path_made_up', '', undefined, 42, { $ne: null }]) {
    const r = await send({ sessionId, ...DETAILS });
    assert.equal(r.status, 402, JSON.stringify(sessionId));
    assert.deepEqual(r.body, { error: NOT_CONFIRMED });
  }
  assert.equal(retrieved.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournament_orders WHERE team_club = 'Example Hawks 14U' AND status = 'pending'").get().n, 0);
});

test('an unpaid checkout’s link is refused the same way, and stays unpaid', async () => {
  const o = order();
  atStripe.set(o.sessionId, { id: o.sessionId, payment_status: 'unpaid', client_reference_id: o.order_id });
  const r = await send({ sessionId: o.sessionId, ...DETAILS });
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, { error: NOT_CONFIRMED });
  const row = getOrder(db, o.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.team_club, '');
  assert.equal(row.details_received_at, null);
  assert.deepEqual(history(o.id), ['created', 'checkout_started']);
});

test('faster than the webhook: Stripe’s own word saves the details, and only the webhook marks paid', async () => {
  const o = order();
  atStripe.set(o.sessionId, { id: o.sessionId, payment_status: 'paid', client_reference_id: o.order_id });
  const r = await send({ sessionId: o.sessionId, ...DETAILS });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, orderId: o.order_id });
  assert.deepEqual(retrieved, [o.sessionId]);
  let row = getOrder(db, o.id);
  assert.equal(row.team_club, 'Example Hawks 14U');
  assert.equal(row.status, 'pending', 'the details step never marks an order paid');

  const event = {
    id: 'evt_pp_late', object: 'event', type: 'checkout.session.completed',
    data: { object: { id: o.sessionId, object: 'checkout.session', client_reference_id: o.order_id, payment_status: 'paid', payment_intent: 'pi_test_late', amount_total: 15000, currency: 'usd' } },
  };
  const payload = JSON.stringify(event);
  const res = await fetch(`${h.base}/api/stripe/webhook`, {
    method: 'POST', body: payload,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeWebhooks.generateTestHeaderString({ payload, secret: SECRET }) },
  });
  assert.equal(res.status, 200);
  row = getOrder(db, o.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.team_club, 'Example Hawks 14U', 'the details survive the paid transition');
});

test('Stripe reporting another order’s session as paid does not count', async () => {
  const o = order();
  atStripe.set(o.sessionId, { id: o.sessionId, payment_status: 'paid', client_reference_id: 'TO-SOME-ONEE' });
  const r = await send({ sessionId: o.sessionId, ...DETAILS });
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, { error: NOT_CONFIRMED }, 'a refusal never carries an order number');
  assert.equal(getOrder(db, o.id).details_received_at, null);
});

test('a session Stripe does not know is a refusal; Stripe out of reach is a retry', async () => {
  const unknownAtStripe = order();
  const refused = await send({ sessionId: unknownAtStripe.sessionId, ...DETAILS });
  assert.equal(refused.status, 402);
  assert.deepEqual(refused.body, { error: NOT_CONFIRMED });

  const o = order();
  atStripe.set(o.sessionId, { id: o.sessionId, payment_status: 'paid', client_reference_id: o.order_id });
  outage = true;
  const down = await send({ sessionId: o.sessionId, ...DETAILS });
  assert.equal(down.status, 503);
  assert.deepEqual(down.body, { error: 'We could not save your details. Please try again.' });
  assert.equal(getOrder(db, o.id).details_received_at, null);
  outage = false;
  assert.equal((await send({ sessionId: o.sessionId, ...DETAILS })).status, 200, 'trying again works');
});

test('missing or overlong fields are refused by name and store nothing', async () => {
  const o = order({ paid: true });
  const cases = [
    [{ teamClub: '' }, 'Enter the team or club.'],
    [{ jerseyNumber: '  ' }, 'Enter the jersey number.'],
    [{ primaryPosition: undefined }, 'Enter the primary position.'],
    [{ teamClub: 'x'.repeat(201) }, 'Shorten the team or club to 200 characters or fewer.'],
    [{ notes: 'x'.repeat(1001) }, 'Shorten the note to 1,000 characters or fewer.'],
  ];
  for (const [patch, error] of cases) {
    const r = await send({ sessionId: o.sessionId, ...DETAILS, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 60));
    assert.deepEqual(r.body, { error });
    noPii(r);
  }
  assert.equal(getOrder(db, o.id).details_received_at, null);
});
