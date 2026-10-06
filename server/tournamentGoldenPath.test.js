// golden-path.md, steps 1-7, through the HTTP API: a parent's details and
// package become a pending order and a Stripe session at the server's price,
// Stripe's signed webhook marks it paid, the success page's details land on
// that order, and Will's list shows it until he ticks Delivered. Stripe's API
// is stubbed (no network); the webhook carries a real signature. Every value
// is invented, as in golden-path.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-golden-path-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-golden-path-${process.pid}-store`;
process.env.DM_RATE_LIMITS = '0';
delete process.env.DM_LOG_SILENT;
delete process.env.DM_PUBLIC_BASE_URL;
process.env.STRIPE_SECRET_KEY = 'sk_test_golden_path';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_golden_path';
process.env.STRIPE_TEST_PRICES = JSON.stringify({ individual_basic: 'price_GpBasic', individual_pro: 'price_GpPro', tournament_basic: 'price_GpTBasic', tournament_pro: 'price_GpTPro' });

const logged = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests, stripeWebhooks } = await import('./stripeConfig.js');
const { listPaidOrders } = await import('./tournamentOrderStore.js');

// Stripe, as far as this run needs it: each Price as Will set it up (one-time,
// dollars), sessions priced from the Price the server chose, and a session
// that turns paid when the parent pays.
const PRICE_AMOUNTS = { price_GpBasic: 5000, price_GpPro: 7500, price_GpTBasic: 12500, price_GpTPro: 15000 };
const stripeSessions = new Map();
const stripe = {
  prices: {
    async retrieve(id) {
      return { id, object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: PRICE_AMOUNTS[id] ?? null };
    },
  },
  checkout: {
    sessions: {
      async create(params) {
        const id = `cs_test_golden${stripeSessions.size + 1}`;
        const amount = PRICE_AMOUNTS[params.line_items[0].price] * params.line_items[0].quantity;
        stripeSessions.set(id, { id, object: 'checkout.session', payment_status: 'unpaid', amount_total: amount, currency: 'usd', ...params });
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
      async retrieve(id) {
        if (!stripeSessions.has(id)) throw Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError' });
        return stripeSessions.get(id);
      },
    },
  },
};

let h, db;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  setStripeClientForTests(stripe);
});
after(async () => {
  setStripeClientForTests(null);
  await h.close();
  db.close();
  console.log = realLog;
  console.error = realError;
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const post = async (path, body, headers = {}) => {
  const res = await fetch(h.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('golden path steps 1-7: one paid order at the server’s price, with the player’s details, delivered by Will', async () => {
  // Steps 1-3: the details step and "Single Tournament — Pro"; the page sends exactly this.
  const checkout = await post('/api/create-checkout-session', {
    guardianName: 'Casey Golden', playerName: 'Riley Golden', email: 'casey.golden@example.com', phone: '801-555-0142',
    tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
  }, { Origin: 'http://localhost:5173' });
  assert.equal(checkout.status, 200);
  assert.match(checkout.body.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  const sessionId = checkout.body.url.split('/').pop();
  const session = stripeSessions.get(sessionId);

  // Step 4: Stripe's page — one line item, quantity 1, $150.00, the email filled in.
  assert.equal(session.line_items.length, 1);
  assert.equal(session.line_items[0].quantity, 1);
  assert.equal(session.amount_total, 15000);
  assert.equal(session.customer_email, 'casey.golden@example.com');
  assert.equal(session.client_reference_id, checkout.body.orderId);
  assert.equal(session.success_url, 'http://localhost:5173/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(listPaidOrders(db).length, 0, 'nothing is paid before Stripe says so');

  // The parent pays; Stripe signs and sends checkout.session.completed.
  Object.assign(session, { payment_status: 'paid', payment_intent: 'pi_test_golden' });
  const payload = JSON.stringify({ id: 'evt_test_golden', object: 'event', type: 'checkout.session.completed', data: { object: session } });
  const hook = await post('/api/stripe/webhook', payload, { 'Stripe-Signature': stripeWebhooks.generateTestHeaderString({ payload, secret: 'whsec_golden_path' }) });
  assert.equal(hook.status, 200);

  // Step 5: Stripe returns to /find-your-player/complete?session_id=…; the parent sends the details.
  const details = await post('/api/post-purchase-intake', {
    sessionId, teamClub: 'Golden Path Test 14U', jerseyNumber: '12', primaryPosition: 'Shortstop', batsThrows: 'R/R', gameContext: '', notes: '',
  });
  // Step 6: the page shows "Order received" / "Thank you." on { ok: true },
  // with the order number the reply carries.
  assert.equal(details.status, 200);
  assert.deepEqual(details.body, { ok: true, orderId: checkout.body.orderId });

  // The one order, as golden-path.md step 7 expects it.
  const paid = listPaidOrders(db);
  assert.equal(paid.length, 1);
  const o = paid[0];
  assert.equal(o.order_id, checkout.body.orderId);
  assert.match(o.order_id, /^TO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(o.package_label, 'Single Tournament — Pro');
  assert.equal(o.amount_total, 15000);
  assert.equal(o.currency, 'usd');
  assert.equal(o.tournament_label, 'Better Baseball — Nephi, Utah · October 9–10, 2026');
  assert.equal(o.player_name, 'Riley Golden');
  assert.deepEqual([o.guardian_name, o.email, o.phone], ['Casey Golden', 'casey.golden@example.com', '801-555-0142']);
  assert.deepEqual([o.team_club, o.jersey_number, o.primary_position, o.bats_throws, o.game_context, o.notes], ['Golden Path Test 14U', '12', 'Shortstop', 'R/R', '', '']);
  assert.ok(o.details_received_at);
  assert.equal(o.stripe_session_id, sessionId);
  assert.equal(o.stripe_payment_intent_id, 'pi_test_golden');
  assert.ok(o.paid_at);
  assert.equal(o.delivered_at, null);

  // Step 7 as Will sees it, through Command's API; then, once the analysis
  // has gone out, he ticks Delivered (ship gate, 2026-10-06). The order stays
  // listed, its payment untouched.
  const will = h.internal('fulfillment', 'Will Example');
  const listed = await h.call('GET', '/api/command/tournament-orders', { token: will.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.orders.map(r => r.order_id), [o.order_id]);
  const delivered = await h.call('PUT', `/api/command/tournament-orders/${o.order_id}/delivered`, { token: will.token, body: { delivered: true } });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.order.delivered_by, 'Will Example');
  const now = listPaidOrders(db);
  assert.equal(now.length, 1, 'still exactly one paid order');
  assert.ok(now[0].delivered_at);
  assert.deepEqual([now[0].paid_at, now[0].amount_total], [o.paid_at, o.amount_total]);

  // golden-path.md step 12: the API's log carries no parent or player data.
  assert.ok(logged.some(l => l.includes('stripe_webhook_paid')));
  for (const pii of ['Casey Golden', 'Riley Golden', 'casey.golden@example.com', '801-555-0142']) {
    assert.ok(!logged.some(l => l.includes(pii)), `the log leaks ${pii}`);
  }
});
