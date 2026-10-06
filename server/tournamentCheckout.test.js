// POST /api/create-checkout-session through the HTTP API, with a stubbed
// Stripe client: the server's price for each package whatever the browser
// sends, a configured Price that would charge another amount refused, the
// session's shape (ids only), return addresses, refusals that save nothing,
// and logs that never carry a name, email or phone (prd.md R1, R7).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-checkout-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-tournament-checkout-${process.pid}-store`;
process.env.DM_RATE_LIMITS = '0';
delete process.env.DM_LOG_SILENT;   // the log lines themselves are under test
delete process.env.DM_PUBLIC_BASE_URL;

// Every log line the API writes during this file, kept off the console.
const logged = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests } = await import('./stripeConfig.js');
const { returnBase } = await import('./tournamentCheckoutRoutes.js');

const TEST_PRICES = { individual_basic: 'price_TestBasic1', individual_pro: 'price_TestPro2', tournament_basic: 'price_TestTBasic3', tournament_pro: 'price_TestTPro4' };
const LIVE_PRICES = { individual_basic: 'price_LiveBasic1', individual_pro: 'price_LivePro2', tournament_basic: 'price_LiveTBasic3', tournament_pro: 'price_LiveTPro4' };
// What each Price charges at Stripe: one-time, in dollars, the card's amount.
const CARD = { individual_basic: 5000, individual_pro: 7500, tournament_basic: 12500, tournament_pro: 15000 };
const atStripe = new Map(Object.entries(CARD).flatMap(([key, amount]) => [TEST_PRICES[key], LIVE_PRICES[key]]
  .map(id => [id, { id, object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: amount }])));
const BODY = {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan.example@example.com',
  phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
};

let h, db;
const sessions = [];
const looked = [];
let made = 0;
let failNext = null;
let pricesDown = null;
const stripeStub = {
  checkout: {
    sessions: {
      async create(params) {
        if (failNext) { const err = failNext; failNext = null; throw err; }
        sessions.push(params);
        const id = `cs_test_stub${++made}`;
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
    },
  },
  prices: {
    async retrieve(id) {
      looked.push(id);
      if (pricesDown) throw pricesDown;
      if (!atStripe.has(id)) throw Object.assign(new Error(`No such price: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
      return atStripe.get(id);
    },
  },
};

before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
});

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_TEST_PRICES = JSON.stringify(TEST_PRICES);
  delete process.env.STRIPE_LIVE_PRICES;
  setStripeClientForTests(stripeStub);   // each test checks Prices afresh
  sessions.length = 0;
  looked.length = 0;
  failNext = null;
  pricesDown = null;
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

async function checkout(body, headers = {}) {
  const res = await fetch(`${h.base}/api/create-checkout-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const orderCount = () => db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n;
const order = orderId => db.prepare('SELECT * FROM tournament_orders WHERE order_id = ?').get(orderId);

test('each package opens one session at the server’s price, with the typed email', async () => {
  for (const packageId of Object.keys(TEST_PRICES)) {
    const r = await checkout({ ...BODY, packageId });
    assert.equal(r.status, 200, packageId);
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const params = sessions.at(-1);
    assert.equal(params.mode, 'payment');
    assert.deepEqual(params.line_items, [{ price: TEST_PRICES[packageId], quantity: 1 }]);
    assert.equal(params.customer_email, 'jordan.example@example.com');
    const saved = order(r.body.orderId);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.package_key, packageId);
    assert.equal(saved.price_id, TEST_PRICES[packageId]);
    assert.equal(saved.stripe_session_id, `cs_test_stub${made}`);
  }
});

test('an amount or Price ID from the browser changes nothing that is charged', async () => {
  const r = await checkout({ ...BODY, packageId: 'tournament_pro', amount: 100, price: 1, priceId: TEST_PRICES.individual_basic });
  assert.equal(r.status, 200);
  assert.deepEqual(sessions.at(-1).line_items, [{ price: TEST_PRICES.tournament_pro, quantity: 1 }]);
  assert.equal(order(r.body.orderId).price_id, TEST_PRICES.tournament_pro);
});

test('the session carries ids only, and the order id is random', async () => {
  const r = await checkout(BODY);
  const params = sessions.at(-1);
  assert.match(r.body.orderId, /^TO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(params.client_reference_id, r.body.orderId);
  assert.deepEqual(params.metadata, { order_id: r.body.orderId, package_key: 'tournament_pro' });
  assert.deepEqual(params.payment_intent_data, {
    metadata: { order_id: r.body.orderId, package_key: 'tournament_pro' },
    receipt_email: 'jordan.example@example.com',
  }, 'Stripe emails the receipt to the address it already has, whatever the account’s email settings');
  const sent = JSON.stringify(params);
  for (const pii of ['Jordan Example', 'Sky Example', '555-0100', 'Better Baseball', 'better-baseball-nephi-2026']) {
    assert.ok(!sent.includes(pii), `Stripe never receives ${pii}`);
  }
  assert.equal(params.allow_promotion_codes, undefined, 'no promotion codes');
  assert.equal(params.automatic_tax, undefined, 'no automatic tax');
  assert.equal(params.success_url, 'http://localhost:5173/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'http://localhost:5173/find-your-player?checkout=cancelled');
});

test('outside production, Stripe returns the parent to the page they started on', async () => {
  await checkout(BODY, { Origin: 'http://wess-mac-studio.local:5931' });
  assert.equal(sessions.at(-1).success_url, 'http://wess-mac-studio.local:5931/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(sessions.at(-1).cancel_url, 'http://wess-mac-studio.local:5931/find-your-player?checkout=cancelled');
  await checkout(BODY, { Origin: 'null' });
  assert.equal(sessions.at(-1).cancel_url, 'http://localhost:5173/find-your-player?checkout=cancelled', 'an opaque origin falls back');
  assert.equal(returnBase('javascript:alert(1)', { configured: false, production: false }), 'http://localhost:5173');
  assert.equal(returnBase('http://evil.example/path', { configured: false, production: false }), 'http://localhost:5173');
  assert.equal(returnBase('http://wess-mac-studio.local:5931', { configured: false, production: true }), 'http://localhost:5173', 'production never reads Origin');
  assert.equal(returnBase('http://wess-mac-studio.local:5931', { configured: true, production: false }), 'http://localhost:5173', 'a configured address wins');
});

test('a configured public address is where Stripe sends the parent', async () => {
  process.env.DM_PUBLIC_BASE_URL = 'https://diamondmetrics.ai/';
  try {
    await checkout(BODY, { Origin: 'http://wess-mac-studio.local:5931' });
  } finally {
    delete process.env.DM_PUBLIC_BASE_URL;
  }
  assert.equal(sessions.at(-1).success_url, 'https://diamondmetrics.ai/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(sessions.at(-1).cancel_url, 'https://diamondmetrics.ai/find-your-player?checkout=cancelled');
});

test('bad input is refused with the field’s message and saves nothing', async () => {
  const before = orderCount();
  const cases = [
    [{ packageId: 'tournament_platinum' }, 'Choose a package.'],
    [{ tournamentId: 'not-an-event' }, 'Choose the tournament attended.'],
    [{ guardianName: '' }, 'Enter the parent or guardian name.'],
    [{ playerName: ' ' }, 'Enter the player name.'],
    [{ email: '' }, 'Enter an email address.'],
    [{ email: 'casey.golden@' }, 'Enter a valid email address.'],
    [{ playerName: 'x'.repeat(201) }, 'Shorten the player name to 200 characters or fewer.'],
  ];
  for (const [patch, error] of cases) {
    const r = await checkout({ ...BODY, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.deepEqual(r.body, { error });
  }
  assert.equal(orderCount(), before, 'no order');
  assert.equal(sessions.length, 0, 'no Stripe session');
});

test('a test key without a price for the package refuses before anything is saved', async () => {
  process.env.STRIPE_TEST_PRICES = JSON.stringify({ ...TEST_PRICES, tournament_pro: undefined });
  const before = orderCount();
  const r = await checkout(BODY);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(orderCount(), before);
  assert.equal(sessions.length, 0);
  assert.equal((await checkout({ ...BODY, packageId: 'individual_pro' })).status, 200, 'the other packages still work');
});

test('a live key charges only STRIPE_LIVE_PRICES', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_stubbed';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify(LIVE_PRICES);
  for (const packageId of Object.keys(LIVE_PRICES)) {
    const r = await checkout({ ...BODY, packageId });
    assert.equal(r.status, 200);
    assert.deepEqual(sessions.at(-1).line_items, [{ price: LIVE_PRICES[packageId], quantity: 1 }], 'the test map is ignored');
    assert.equal(order(r.body.orderId).price_id, LIVE_PRICES[packageId]);
  }
});

test('a live key without STRIPE_LIVE_PRICES refuses before anything is saved', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_stubbed';
  const before = orderCount();
  const r = await checkout(BODY);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(orderCount(), before, 'no order');
  assert.equal(sessions.length, 0, 'no session, and no Price kept in code to fall back on');
  assert.ok(logged.some(l => l.includes('stripe_live_price_missing') && l.includes('STRIPE_LIVE_PRICES is not set')));
});

test('a configured Price that would charge another amount is refused before anything is saved', async () => {
  assert.equal((await checkout({ ...BODY, packageId: 'tournament_basic' })).status, 200, 'Basic’s $125 Price sells Basic');
  // Pro's slot now holds Basic's $125 Price: a swap made while pasting the IDs.
  // Right for Basic is not right for Pro, however recently it was checked.
  process.env.STRIPE_TEST_PRICES = JSON.stringify({ ...TEST_PRICES, tournament_pro: TEST_PRICES.tournament_basic });
  const before = orderCount();
  const r = await checkout(BODY);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(orderCount(), before, 'no order');
  assert.equal(sessions.length, 1, 'never a $125 session for a $150 card');
  const line = logged.findLast(l => l.includes('stripe_price_mismatch'));
  assert.ok(line.includes('tournament_pro') && line.includes('STRIPE_TEST_PRICES') && line.includes('charges $125.00, not the card’s $150.00'), line);
  assert.ok(!line.includes(TEST_PRICES.tournament_basic), 'the log never names the Price');
  assert.equal((await checkout({ ...BODY, packageId: 'tournament_basic' })).status, 200, 'the same Price still sells its own package');
});

test('a Price Stripe does not know, or one that is not one-time USD, is refused the same way', async () => {
  const cases = [
    ['price_TestMissing', null, 'was not found in Stripe'],
    ['price_TestMonthly', { type: 'recurring' }, 'is a recurring Price, not a one-time one'],
    ['price_TestCad', { currency: 'cad' }, 'is in CAD, not USD'],
    ['price_TestArchived', { active: false }, 'is archived in Stripe'],
  ];
  for (const [id, patch, problem] of cases) {
    if (patch) atStripe.set(id, { ...atStripe.get(TEST_PRICES.individual_pro), id, ...patch });
    process.env.STRIPE_TEST_PRICES = JSON.stringify({ ...TEST_PRICES, individual_pro: id });
    const r = await checkout({ ...BODY, packageId: 'individual_pro' });
    assert.equal(r.status, 503, id);
    assert.equal(sessions.length, 0, id);
    assert.ok(logged.findLast(l => l.includes('stripe_price_mismatch')).includes(problem), problem);
  }
});

test('Stripe asked once per Price; out of reach, the checkout is refused and nothing saved', async () => {
  await checkout(BODY);
  await checkout(BODY);
  assert.deepEqual(looked, [TEST_PRICES.tournament_pro], 'a Price that charges the card’s amount is looked at once');
  setStripeClientForTests(stripeStub);
  pricesDown = Object.assign(new Error('connect ECONNREFUSED'), { type: 'StripeConnectionError' });
  const before = orderCount();
  const r = await checkout(BODY);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(orderCount(), before);
  assert.equal(sessions.length, 2);
  assert.ok(logged.some(l => l.includes('tournament_checkout_failed') && l.includes('StripeConnectionError')));
});

test('when Stripe fails, the order stays pending and a retry starts a fresh checkout', async () => {
  failNext = Object.assign(new Error('Invalid API Key provided: sk_test_****'), { type: 'StripeAuthenticationError', code: undefined });
  const before = orderCount();
  const r = await checkout(BODY);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'We could not start secure checkout. Please try again.' });
  assert.equal(orderCount(), before + 1, 'the pending order was saved first');
  const orphan = db.prepare('SELECT * FROM tournament_orders ORDER BY id DESC LIMIT 1').get();
  assert.equal(orphan.status, 'pending');
  assert.equal(orphan.stripe_session_id, null);
  const retry = await checkout(BODY);
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.orderId, orphan.order_id);
});

test('an email Stripe will not accept is refused as an email problem', async () => {
  failNext = Object.assign(new Error('Invalid email address: x'), { type: 'StripeInvalidRequestError', code: 'email_invalid', param: 'customer_email' });
  const r = await checkout({ ...BODY, email: 'odd@example.c' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Enter a valid email address.' });
});

test('checkout log lines carry ids, never names, emails or phone numbers', () => {
  const lines = logged.filter(l => l.includes('tournament_checkout'));
  assert.ok(lines.some(l => l.includes('tournament_checkout_started')));
  assert.ok(lines.some(l => l.includes('tournament_checkout_failed')));
  for (const line of logged) {
    for (const pii of ['Jordan Example', 'Sky Example', 'jordan.example@example.com', '555-0100', 'odd@example.c']) {
      assert.ok(!line.includes(pii), `log line leaks ${pii}: ${line}`);
    }
  }
});
