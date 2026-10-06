// /command/ops and the tournament checkout's Stripe Prices (ship gate, round
// 2: production's Price IDs are a setting, STRIPE_LIVE_PRICES). Service health
// names which key and Price map checkout runs on and what is missing; an
// admin's "Check now" asks Stripe for each configured Price and says whether
// it charges its card's price, once, in US dollars. Price IDs never leave the
// server. Through the HTTP API with a stubbed Stripe client; every value is
// invented.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-stripe-price-check-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-stripe-price-check-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests } = await import('./stripeConfig.js');

const LIVE = { individual_basic: 'price_LiveCheckA', individual_pro: 'price_LiveCheckB', tournament_basic: 'price_LiveCheckC', tournament_pro: 'price_LiveCheckD' };
const product = name => ({ id: `prod_${name.replace(/\W/g, '')}`, object: 'product', name });
const PRICE = { object: 'price', active: true, type: 'one_time', currency: 'usd' };
const atStripe = new Map([
  [LIVE.individual_basic, { ...PRICE, id: LIVE.individual_basic, unit_amount: 5000, product: product('Individual Game — Basic') }],
  [LIVE.individual_pro, { ...PRICE, id: LIVE.individual_pro, unit_amount: 7500, product: product('Individual Pro') }],
  [LIVE.tournament_basic, { ...PRICE, id: LIVE.tournament_basic, unit_amount: 12500, product: product('Tournament Basic') }],
  [LIVE.tournament_pro, { ...PRICE, id: LIVE.tournament_pro, unit_amount: 15000, product: product('Tournament Pro') }],
]);
const asked = [];
let refuseKey = false;
const stripe = {
  prices: {
    async retrieve(id, params) {
      asked.push({ id, params });
      if (refuseKey) throw Object.assign(new Error('Invalid API Key provided: sk_live_****'), { type: 'StripeAuthenticationError' });
      if (!atStripe.has(id)) throw Object.assign(new Error(`No such price: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
      return atStripe.get(id);
    },
  },
  checkout: { sessions: { async create() { const id = 'cs_live_check1'; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; } } },
};

let h, db, admin, analyst, fulfillment;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  admin = h.internal('admin');
  analyst = h.internal('analyst');
  fulfillment = h.internal('fulfillment');
});
beforeEach(() => {
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_PRICES', 'STRIPE_LIVE_PRICES']) delete process.env[k];
  setStripeClientForTests(stripe);
  asked.length = 0;
  refuseKey = false;
});
after(async () => {
  setStripeClientForTests(null);
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const check = (token = admin.token) => h.call('POST', '/api/command/stripe/prices/check', { token });
const summary = async (token = admin.token) => (await h.call('GET', '/api/command/ops', { token })).body.tournament_checkout;

test('service health names the key, the Price map and what is still to set, never a value', async () => {
  assert.deepEqual(await summary(), { mode: null, prices_variable: null, problems: ['set STRIPE_SECRET_KEY', 'set STRIPE_WEBHOOK_SECRET'] });
  process.env.STRIPE_SECRET_KEY = 'pk_live_check';
  assert.deepEqual((await summary()).problems, ['STRIPE_SECRET_KEY is not a secret key', 'set STRIPE_WEBHOOK_SECRET']);
  process.env.STRIPE_SECRET_KEY = 'sk_live_check';
  process.env.STRIPE_TEST_PRICES = JSON.stringify(LIVE);
  process.env.STRIPE_LIVE_PRICES = JSON.stringify({ ...LIVE, tournament_pro: undefined });
  const live = await summary(analyst.token);
  assert.deepEqual(live, { mode: 'live', prices_variable: 'STRIPE_LIVE_PRICES', problems: ['STRIPE_LIVE_PRICES has no price for tournament_pro', 'set STRIPE_WEBHOOK_SECRET'] });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_check';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify(LIVE);
  const ops = await h.call('GET', '/api/command/ops', { token: admin.token });
  assert.deepEqual(ops.body.tournament_checkout, { mode: 'live', prices_variable: 'STRIPE_LIVE_PRICES', problems: [] });
  const sent = JSON.stringify(ops.body);
  for (const secret of ['sk_live_check', 'whsec_check', ...Object.values(LIVE)]) assert.ok(!sent.includes(secret), `ops never shows ${secret}`);
});

test('an admin checks the four Prices against the cards: amount, one-time, dollars, and the name Checkout shows', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_check';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify(LIVE);
  const r = await check();
  assert.equal(r.status, 200);
  assert.equal(r.body.check.ok, true);
  assert.equal(r.body.check.mode, 'live');
  assert.equal(r.body.check.variable, 'STRIPE_LIVE_PRICES');
  assert.deepEqual(r.body.check.packages.map(p => [p.package_key, p.label, p.card_amount, p.amount, p.type, p.currency, p.active, p.product_name, p.problem]), [
    ['individual_basic', 'Individual Game — Basic', 5000, 5000, 'one_time', 'usd', true, 'Individual Game — Basic', ''],
    ['individual_pro', 'Individual Game — Pro', 7500, 7500, 'one_time', 'usd', true, 'Individual Pro', ''],
    ['tournament_basic', 'Single Tournament — Basic', 12500, 12500, 'one_time', 'usd', true, 'Tournament Basic', ''],
    ['tournament_pro', 'Single Tournament — Pro', 15000, 15000, 'one_time', 'usd', true, 'Tournament Pro', ''],
  ]);
  assert.deepEqual(asked.map(a => a.params), Array(4).fill({ expand: ['product'] }), 'the product comes along for its name');
  for (const id of Object.values(LIVE)) assert.ok(!JSON.stringify(r.body).includes(id), 'Price IDs stay on the server');

  // Checked once here, a parent's checkout does not ask Stripe again.
  asked.length = 0;
  const parent = await h.call('POST', '/api/create-checkout-session', { body: {
    guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com', phone: '', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
  } });
  assert.equal(parent.status, 200);
  assert.equal(asked.length, 0);
});

test('each problem is named against its package: swapped, missing, unknown to Stripe, recurring', async () => {
  atStripe.set('price_LiveMonthly', { ...PRICE, id: 'price_LiveMonthly', type: 'recurring', unit_amount: 7500, product: product('Individual Pro monthly') });
  process.env.STRIPE_SECRET_KEY = 'sk_live_check';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify({
    individual_basic: 'price_TestModeOnly', individual_pro: 'price_LiveMonthly',
    tournament_basic: LIVE.tournament_pro, tournament_pro: undefined,
  });
  const r = await check();
  assert.equal(r.status, 200);
  assert.equal(r.body.check.ok, false);
  assert.deepEqual(Object.fromEntries(r.body.check.packages.map(p => [p.package_key, p.problem])), {
    individual_basic: 'was not found in Stripe with this live key',
    individual_pro: 'is a recurring Price, not a one-time one',
    tournament_basic: 'charges $150.00, not the card’s $125.00',
    tournament_pro: 'has no price_ id in STRIPE_LIVE_PRICES',
  });
  assert.ok(!JSON.stringify(r.body).includes('price_TestModeOnly'), 'not even an ID Stripe does not know');
});

test('without a usable key, or with one Stripe refuses, the check says so', async () => {
  assert.deepEqual((await check()).body.check, { ok: false, mode: null, error: 'STRIPE_SECRET_KEY is not set' });
  process.env.STRIPE_SECRET_KEY = 'pk_live_check';
  assert.deepEqual((await check()).body.check, { ok: false, mode: null, error: 'STRIPE_SECRET_KEY is not a secret key' });
  process.env.STRIPE_SECRET_KEY = 'sk_live_check';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify(LIVE);
  refuseKey = true;
  const r = await check();
  assert.equal(r.body.check.ok, false);
  assert.ok(r.body.check.packages.every(p => p.problem === 'Stripe refused STRIPE_SECRET_KEY'));
  assert.ok(!JSON.stringify(r.body).includes('sk_live_check'));
});

test('only an admin runs the check; signed out it is refused', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_check';
  process.env.STRIPE_LIVE_PRICES = JSON.stringify(LIVE);
  assert.equal((await check(analyst.token)).status, 403);
  assert.equal((await check(fulfillment.token)).status, 403);
  assert.equal((await check(null)).status, 401);
  assert.equal((await h.call('GET', '/api/command/ops')).status, 401);
  assert.equal(asked.length, 0, 'Stripe is never asked for them');
});
