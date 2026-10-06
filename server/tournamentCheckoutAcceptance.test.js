// Tournament checkout — the handoff's release test list (handoff §7: each
// package, a canceled checkout, a successful checkout, a duplicate webhook
// delivery, a direct visit to the success URL without payment) plus a forged
// webhook, a tampered price, an unconfigured server and logs free of names,
// emails and phone numbers. Through the HTTP API, with a Stripe test double
// for the API (no network) and real webhook signatures. prd.md AC1-AC4,
// AC6, AC7, AC11, AC13, AC20, AC22, AC23. Every value is invented.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-acceptance-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-tournament-acceptance-${process.pid}-store`;
process.env.DM_RATE_LIMITS = '0';
delete process.env.DM_LOG_SILENT;   // the logs are part of the acceptance
delete process.env.DM_PUBLIC_BASE_URL;

const logged = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests, stripeWebhooks } = await import('./stripeConfig.js');

const SECRET = 'whsec_acceptance_secret';
const TEST_PRICES = { individual_basic: 'price_AccBasic', individual_pro: 'price_AccPro', tournament_basic: 'price_AccTBasic', tournament_pro: 'price_AccTPro' };
const LIVE_PRICES = { individual_basic: 'price_LiveAccBasic', individual_pro: 'price_LiveAccPro', tournament_basic: 'price_LiveAccTBasic', tournament_pro: 'price_LiveAccTPro' };
// What each Price charges, as the team set them up in Stripe.
const CHARGES = {
  price_AccBasic: 5000, price_AccPro: 7500, price_AccTBasic: 12500, price_AccTPro: 15000,
  [LIVE_PRICES.individual_basic]: 5000, [LIVE_PRICES.individual_pro]: 7500, [LIVE_PRICES.tournament_basic]: 12500, [LIVE_PRICES.tournament_pro]: 15000,
};
const LABELS = { individual_basic: 'Individual Game — Basic', individual_pro: 'Individual Game — Pro', tournament_basic: 'Single Tournament — Basic', tournament_pro: 'Single Tournament — Pro' };

// Stripe, as far as the checkout needs it: each Price as the team set it up
// (one-time, dollars); a session priced from the Price the server chose; a
// payment turns it paid; a retrieve reports it.
const sessions = new Map();
let seq = 0;
const stripe = {
  prices: {
    async retrieve(id) {
      if (!(id in CHARGES)) throw Object.assign(new Error('No such price'), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
      return { id, object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: CHARGES[id] };
    },
  },
  checkout: {
    sessions: {
      async create(params) {
        const id = `cs_test_acc${++seq}`;
        const amount = params.line_items.reduce((sum, li) => sum + CHARGES[li.price] * li.quantity, 0);
        sessions.set(id, { id, object: 'checkout.session', mode: params.mode, payment_status: 'unpaid', amount_total: amount, currency: 'usd', payment_intent: null, ...params });
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
      async retrieve(id) {
        if (!sessions.has(id)) throw Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
        return sessions.get(id);
      },
    },
  },
};
function pay(sessionId) {
  const s = sessions.get(sessionId);
  Object.assign(s, { payment_status: 'paid', payment_intent: `pi_test_acc${++seq}` });
  return { id: `evt_test_acc${++seq}`, object: 'event', type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { ...s } } };
}

let h, db, admin;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  admin = h.internal('fulfillment');
  setStripeClientForTests(stripe);
});
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_acceptance';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_TEST_PRICES = JSON.stringify(TEST_PRICES);
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

let parent = 0;
function details(overrides = {}) {
  parent++;
  return {
    guardianName: `Avery Example${parent}`, playerName: `Rowan Example${parent}`, email: `avery.example${parent}@example.com`,
    phone: `555-01${String(parent).padStart(2, '0')}`, tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro', ...overrides,
  };
}
async function post(path, body, headers = {}) {
  const res = await fetch(h.base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function startCheckout(body) {
  const r = await post('/api/create-checkout-session', body);
  return { ...r, sessionId: r.body.url ? r.body.url.split('/').pop() : null };
}
function deliver(event, signature) {
  const payload = JSON.stringify(event);
  return post('/api/stripe/webhook', payload, { 'Stripe-Signature': signature ?? stripeWebhooks.generateTestHeaderString({ payload, secret: SECRET }) });
}
const sendDetails = (sessionId, extra = {}) => post('/api/post-purchase-intake', { sessionId, teamClub: 'Example Hawks 14U', jerseyNumber: '9', primaryPosition: 'Center Field', ...extra });
const paidList = async () => (await h.call('GET', '/api/command/tournament-orders', { token: admin.token })).body.orders;
const orderBySession = id => db.prepare('SELECT * FROM tournament_orders WHERE stripe_session_id = ?').get(id);

test('§7 each package: one line item, quantity 1, the typed email, and exactly the package’s price', async () => {
  const expected = { individual_basic: 5000, individual_pro: 7500, tournament_basic: 12500, tournament_pro: 15000 };
  for (const [packageId, cents] of Object.entries(expected)) {
    const body = details({ packageId });
    const r = await startCheckout(body);
    assert.equal(r.status, 200, packageId);
    const s = sessions.get(r.sessionId);
    assert.equal(s.mode, 'payment');
    assert.deepEqual(s.line_items, [{ price: TEST_PRICES[packageId], quantity: 1 }]);
    assert.equal(s.customer_email, body.email);
    assert.equal(s.amount_total, cents, `${packageId} totals ${cents / 100}`);
    assert.equal((await deliver(pay(r.sessionId))).status, 200);
    const listed = (await paidList()).find(o => o.order_id === r.body.orderId);
    assert.equal(listed.amount_total, cents);
    assert.equal(listed.package_label, LABELS[packageId]);
  }
});

test('§7 a canceled checkout: the order stays pending and unlisted, and the parent can start again', async () => {
  const body = details();
  const first = await startCheckout(body);
  const s = sessions.get(first.sessionId);
  assert.equal(s.cancel_url, 'http://localhost:5173/find-your-player?checkout=cancelled');
  // The parent taps "←" on Stripe's page: Stripe sends no webhook.
  assert.equal(orderBySession(first.sessionId).status, 'pending');
  assert.ok(!(await paidList()).some(o => o.order_id === first.body.orderId), 'never listed');
  const again = await startCheckout(body);
  assert.equal(again.status, 200);
  assert.notEqual(again.sessionId, first.sessionId);
  assert.notEqual(again.body.orderId, first.body.orderId);
});

test('§7 a successful checkout: paid only by the signed webhook, with Stripe’s ids, amount and time', async () => {
  const r = await startCheckout(details());
  // Stripe sends the parent back to the success page before anything is paid here.
  assert.equal(orderBySession(r.sessionId).status, 'pending', 'the redirect is not payment confirmation');
  const event = pay(r.sessionId);
  assert.equal((await deliver(event)).status, 200);
  const listed = (await paidList()).find(o => o.order_id === r.body.orderId);
  assert.ok(listed, 'listed once paid');
  assert.equal(listed.stripe_session_id, r.sessionId);
  assert.match(listed.stripe_payment_intent_id, /^pi_test_/);
  assert.equal(listed.amount_total, 15000);
  assert.equal(listed.currency, 'usd');
  assert.ok(listed.paid_at);
  assert.equal(orderBySession(r.sessionId).payment_status, 'paid');
  const done = await sendDetails(r.sessionId, { batsThrows: 'L/R' });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { ok: true, orderId: r.body.orderId });
  const withDetails = (await paidList()).find(o => o.order_id === r.body.orderId);
  assert.deepEqual([withDetails.team_club, withDetails.jersey_number, withDetails.primary_position, withDetails.bats_throws], ['Example Hawks 14U', '9', 'Center Field', 'L/R']);
});

test('§7 a duplicate webhook delivery: one order, its first paid time, one "paid" entry', async () => {
  const r = await startCheckout(details());
  const event = pay(r.sessionId);
  for (let i = 0; i < 3; i++) assert.equal((await deliver(event)).status, 200);
  const firstPaid = orderBySession(r.sessionId).paid_at;
  const second = { ...pay(r.sessionId), id: `evt_test_acc_again${seq}` };
  assert.equal((await deliver(second)).status, 200, 'a second event for the same session');
  const rows = (await paidList()).filter(o => o.stripe_session_id === r.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paid_at, firstPaid);
  const order = orderBySession(r.sessionId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournament_order_events WHERE order_id = ? AND event_type = 'paid'").get(order.id).n, 1);
});

test('§7 a direct visit to the success URL without payment: refused, nothing stored, never listed', async () => {
  const unpaid = await startCheckout(details({ packageId: 'individual_basic' }));
  for (const sessionId of [unpaid.sessionId, 'cs_test_golden_path_made_up']) {
    const r = await sendDetails(sessionId);
    assert.ok(r.status >= 400 && r.status < 500, sessionId);
    assert.deepEqual(r.body, { error: 'We could not confirm a payment for this order. If you were charged, email info@diamondmetrics.ai.' });
  }
  const order = orderBySession(unpaid.sessionId);
  assert.equal(order.status, 'pending');
  assert.equal(order.details_received_at, null);
  assert.ok(!(await paidList()).some(o => o.order_id === unpaid.body.orderId));
});

test('a forged webhook is refused and changes nothing', async () => {
  const unpaid = await startCheckout(details({ packageId: 'individual_basic' }));
  const s = sessions.get(unpaid.sessionId);
  const forged = { id: 'evt_golden_path_forged', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { ...s, payment_status: 'paid', amount_total: 5000 } } };
  assert.equal((await post('/api/stripe/webhook', JSON.stringify(forged))).status, 400, 'no signature');
  assert.equal((await deliver(forged, 't=1791000000,v1=0000000000000000000000000000000000000000000000000000000000000000')).status, 400, 'a made-up signature');
  assert.equal(orderBySession(unpaid.sessionId).status, 'pending');
  assert.ok(!(await paidList()).some(o => o.order_id === unpaid.body.orderId));
});

test('a tampered price: the browser cannot set what is charged', async () => {
  const r = await startCheckout(details({ packageId: 'tournament_pro', amount: 100, price: 1, priceId: TEST_PRICES.individual_basic }));
  assert.equal(r.status, 200);
  assert.equal(sessions.get(r.sessionId).amount_total, 15000);
  const unknown = await post('/api/create-checkout-session', details({ packageId: 'tournament_platinum' }));
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, { error: 'Choose a package.' });
});

test('the session carries ids only and returns to the configured site', async () => {
  const body = details();
  const r = await startCheckout(body);
  const s = sessions.get(r.sessionId);
  assert.match(r.body.orderId, /^TO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/, 'not a small sequential number');
  assert.equal(s.client_reference_id, r.body.orderId);
  assert.deepEqual(s.metadata, { order_id: r.body.orderId, package_key: 'tournament_pro' });
  const sent = JSON.stringify(s);
  for (const pii of [body.guardianName, body.playerName, body.phone, 'Better Baseball']) assert.ok(!sent.includes(pii), `Stripe never receives ${pii}`);
  assert.equal(s.success_url, 'http://localhost:5173/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(s.cancel_url, 'http://localhost:5173/find-your-player?checkout=cancelled');
});

test('prices follow the key: test prices with a test key, a missing one refused, live prices only with a live key', async () => {
  process.env.STRIPE_TEST_PRICES = JSON.stringify({ ...TEST_PRICES, tournament_basic: undefined });
  const before = seq;
  const missing = await post('/api/create-checkout-session', details({ packageId: 'tournament_basic' }));
  assert.ok(missing.status >= 500);
  assert.deepEqual(missing.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(seq, before, 'no session');
  process.env.STRIPE_SECRET_KEY = 'sk_live_acceptance';
  const liveWithTestPrices = await post('/api/create-checkout-session', details({ packageId: 'tournament_pro' }));
  assert.ok(liveWithTestPrices.status >= 500, 'a live key beside STRIPE_TEST_PRICES refuses');
  delete process.env.STRIPE_TEST_PRICES;
  const noLivePrices = await post('/api/create-checkout-session', details({ packageId: 'tournament_pro' }));
  assert.ok(noLivePrices.status >= 500, 'a live key without its STRIPE_LIVE_PRICE_* settings refuses: no Price in code');
  assert.equal(seq, before, 'no session');
  const live = Object.entries(LIVE_PRICES).map(([key, id]) => [`STRIPE_LIVE_PRICE_${key.toUpperCase()}`, id]);
  for (const [name, id] of live) process.env[name] = id;
  try {
    for (const [packageId, priceId] of Object.entries(LIVE_PRICES)) {
      const r = await startCheckout(details({ packageId }));
      assert.deepEqual(sessions.get(r.sessionId).line_items, [{ price: priceId, quantity: 1 }]);
    }
  } finally {
    for (const [name] of live) delete process.env[name];
  }
});

test('a Price that would charge another amount than the card is refused, and nothing is saved', async () => {
  process.env.STRIPE_TEST_PRICES = JSON.stringify({ ...TEST_PRICES, individual_basic: TEST_PRICES.tournament_pro });
  const orders = db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n;
  const before = seq;
  const r = await post('/api/create-checkout-session', details({ packageId: 'individual_basic' }));
  assert.ok(r.status >= 500);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(seq, before, 'never a $150 session for a $50 card');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n, orders);
});

test('an unconfigured server refuses checkout, stores nothing, and the webhook changes nothing', async () => {
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_PRICES']) delete process.env[key];
  const before = db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n;
  const r = await post('/api/create-checkout-session', details());
  assert.ok(r.status >= 500);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n, before);
  const anyOrder = db.prepare("SELECT * FROM tournament_orders WHERE status = 'pending' AND stripe_session_id IS NOT NULL LIMIT 1").get();
  const event = { id: 'evt_test_unconfigured', type: 'checkout.session.completed', data: { object: { id: anyOrder.stripe_session_id, client_reference_id: anyOrder.order_id, payment_status: 'paid' } } };
  assert.equal((await deliver(event)).status, 400);
  assert.equal(orderBySession(anyOrder.stripe_session_id).status, 'pending');
});

test('logs carry ids, never a name, an email or a phone number', () => {
  assert.ok(logged.some(l => l.includes('tournament_checkout_started')));
  assert.ok(logged.some(l => l.includes('stripe_webhook_paid')));
  for (let i = 1; i <= parent; i++) {
    for (const pii of [`Avery Example${i}`, `Rowan Example${i}`, `avery.example${i}@example.com`, `555-01${String(i).padStart(2, '0')}`]) {
      const leak = logged.find(l => l.includes(pii));
      assert.equal(leak, undefined, `a log line carries ${pii}`);
    }
  }
});
