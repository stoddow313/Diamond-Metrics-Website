// POST /api/create-checkout-session through the HTTP API, with a stubbed
// Stripe client: the server's price for each package whatever the browser
// sends, the session's shape (ids only), return addresses, refusals that save
// nothing, and logs that never carry a name, email or phone (prd.md R1, R7).
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
const LIVE_PRICES = {
  individual_basic: 'price_1UNGeTQkGlcnNPo07CCI0CCK', individual_pro: 'price_1UNGepQkGlcnNPo05FmG7Olz',
  tournament_basic: 'price_1UNGfFQkGlcnNPo0PCeTqYNO', tournament_pro: 'price_1UNGfZQkGlcnNPo0i8SqGcm7',
};
const BODY = {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan.example@example.com',
  phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
};

let h, db;
const sessions = [];
let made = 0;
let failNext = null;
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
};

before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  setStripeClientForTests(stripeStub);
});

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_TEST_PRICES = JSON.stringify(TEST_PRICES);
  sessions.length = 0;
  failNext = null;
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
  assert.deepEqual(params.payment_intent_data, { metadata: { order_id: r.body.orderId, package_key: 'tournament_pro' } });
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

test('a live key charges only the handoff’s live prices', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_stubbed';
  for (const packageId of Object.keys(LIVE_PRICES)) {
    const r = await checkout({ ...BODY, packageId });
    assert.equal(r.status, 200);
    assert.deepEqual(sessions.at(-1).line_items, [{ price: LIVE_PRICES[packageId], quantity: 1 }], 'the test map is ignored');
  }
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
