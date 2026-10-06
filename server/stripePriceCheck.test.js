// The tournament checkout's Stripe settings as an operator sees them (ship
// gate, round 2: production's Price IDs are four Render settings, never code).
// /command/ops names the key, where its Prices come from and what is still to
// set or fix; an admin's "Check now" asks Stripe for each configured Price and
// says whether it charges its card's price, once, in US dollars; at boot the
// same check is said in the log and to the operator alert hook. Price IDs and
// keys never leave the server. Through the HTTP API with a stubbed Stripe
// client; every value is invented.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-stripe-price-check-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-stripe-price-check-${process.pid}-store`;
delete process.env.DM_LOG_SILENT;   // the startup lines are under test
delete process.env.DM_ALERT_WEBHOOK_URL;

const logged = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests, checkStripeAtStartup, readStripeConfig } = await import('./stripeConfig.js');

const LIVE = { individual_basic: 'price_LiveCheckA', individual_pro: 'price_LiveCheckB', tournament_basic: 'price_LiveCheckC', tournament_pro: 'price_LiveCheckD' };
const LIVE_ENV = Object.fromEntries(Object.entries(LIVE).map(([key, id]) => [`STRIPE_LIVE_PRICE_${key.toUpperCase()}`, id]));
const product = name => ({ id: `prod_${name.replace(/\W/g, '')}`, object: 'product', name });
const PRICE = { object: 'price', active: true, type: 'one_time', currency: 'usd' };
const atStripe = new Map([
  [LIVE.individual_basic, { ...PRICE, id: LIVE.individual_basic, unit_amount: 5000, product: product('Individual Game — Basic') }],
  [LIVE.individual_pro, { ...PRICE, id: LIVE.individual_pro, unit_amount: 7500, product: product('Individual Pro') }],
  [LIVE.tournament_basic, { ...PRICE, id: LIVE.tournament_basic, unit_amount: 12500, product: product('Tournament Basic') }],
  [LIVE.tournament_pro, { ...PRICE, id: LIVE.tournament_pro, unit_amount: 15000, product: product('Tournament Pro') }],
  ['price_LiveMonthly', { ...PRICE, id: 'price_LiveMonthly', type: 'recurring', unit_amount: 7500, product: product('Individual Pro monthly') }],
]);
const asked = [];
let refuseKey = false;
const stripe = {
  prices: {
    async retrieve(id, params) {
      asked.push({ id, params });
      if (refuseKey) throw Object.assign(new Error('Invalid API Key provided: sk_live_****'), { type: 'StripeAuthenticationError' });
      if (id === 'price_FromTestMode') {
        throw Object.assign(new Error(`No such price: '${id}'; a similar object exists in test mode, but a live mode key was used to make this request.`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
      }
      if (!atStripe.has(id)) throw Object.assign(new Error(`No such price: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
      return atStripe.get(id);
    },
  },
  checkout: { sessions: { async create() { const id = 'cs_live_check1'; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; } } },
};
const STRIPE_VARIABLES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_PRICES', ...Object.keys(LIVE_ENV)];
const goLive = (extra = {}) => Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_live_check', STRIPE_WEBHOOK_SECRET: 'whsec_check', ...LIVE_ENV, ...extra });

let h, db, admin, analyst, fulfillment;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  admin = h.internal('admin');
  analyst = h.internal('analyst');
  fulfillment = h.internal('fulfillment');
});
beforeEach(() => {
  for (const k of STRIPE_VARIABLES) delete process.env[k];
  setStripeClientForTests(stripe);
  asked.length = 0;
  logged.length = 0;
  refuseKey = false;
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

const check = (token = admin.token) => h.call('POST', '/api/command/stripe/prices/check', { token });
const summary = async (token = admin.token) => (await h.call('GET', '/api/command/ops', { token })).body.tournament_checkout;
const logLines = event => logged.filter(l => l.includes(`"event":"${event}"`)).map(l => JSON.parse(l));

test('service health names the key, where its Prices come from and what is still to set, never a value', async () => {
  assert.deepEqual(await summary(), { mode: null, prices_from: null, problems: ['set STRIPE_SECRET_KEY', 'set STRIPE_WEBHOOK_SECRET'] });
  process.env.STRIPE_SECRET_KEY = 'pk_live_check';
  assert.deepEqual((await summary()).problems, ['STRIPE_SECRET_KEY is not a secret key', 'set STRIPE_WEBHOOK_SECRET']);
  goLive({ STRIPE_WEBHOOK_SECRET: '', STRIPE_LIVE_PRICE_TOURNAMENT_PRO: '' });
  assert.deepEqual(await summary(analyst.token), { mode: 'live', prices_from: 'STRIPE_LIVE_PRICE_*', problems: ['STRIPE_LIVE_PRICE_TOURNAMENT_PRO is not set', 'set STRIPE_WEBHOOK_SECRET'] });
  goLive();
  const ops = await h.call('GET', '/api/command/ops', { token: admin.token });
  assert.deepEqual(ops.body.tournament_checkout, { mode: 'live', prices_from: 'STRIPE_LIVE_PRICE_*', problems: [] });
  const sent = JSON.stringify(ops.body);
  for (const secret of ['sk_live_check', 'whsec_check', ...Object.values(LIVE)]) assert.ok(!sent.includes(secret), `ops never shows ${secret}`);
});

test('service health names a key beside the other mode’s Prices', async () => {
  goLive({ STRIPE_TEST_PRICES: JSON.stringify(LIVE) });
  assert.deepEqual((await summary()).problems, ['STRIPE_SECRET_KEY is a live key, but STRIPE_TEST_PRICES is set: a live key never charges test Prices. '
    + 'Remove STRIPE_TEST_PRICES; live Prices come from the four STRIPE_LIVE_PRICE_* settings.']);
  assert.deepEqual((await check()).body.check.error, readStripeConfig().mismatch, 'the check says the same, and asks Stripe nothing');
  assert.equal(asked.length, 0);
});

test('an admin checks the four Prices against the cards: amount, one-time, dollars, and the name Checkout shows', async () => {
  goLive();
  const r = await check();
  assert.equal(r.status, 200);
  assert.equal(r.body.check.ok, true);
  assert.equal(r.body.check.mode, 'live');
  assert.equal(r.body.check.prices_from, 'STRIPE_LIVE_PRICE_*');
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

test('each problem is named against its package: swapped, a product ID, the other mode, recurring', async () => {
  goLive({
    STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: 'price_FromTestMode', STRIPE_LIVE_PRICE_INDIVIDUAL_PRO: 'price_LiveMonthly',
    STRIPE_LIVE_PRICE_TOURNAMENT_BASIC: LIVE.tournament_pro, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'prod_TournamentPro',
  });
  const r = await check();
  assert.equal(r.status, 200);
  assert.equal(r.body.check.ok, false);
  assert.deepEqual(Object.fromEntries(r.body.check.packages.map(p => [p.package_key, p.problem])), {
    individual_basic: 'is a test-mode Price, but STRIPE_SECRET_KEY is a live key',
    individual_pro: 'is a recurring Price, not a one-time one',
    tournament_basic: 'charges $150.00, not the card’s $125.00',
    tournament_pro: 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO holds a product ID (prod_…), not the product\'s Price ID (price_…)',
  });
  for (const value of ['price_FromTestMode', 'prod_TournamentPro']) assert.ok(!JSON.stringify(r.body).includes(value), `${value} is never shown`);
});

test('without a usable key, or with one Stripe refuses, the check says so', async () => {
  assert.deepEqual((await check()).body.check, { ok: false, mode: null, error: 'STRIPE_SECRET_KEY is not set' });
  process.env.STRIPE_SECRET_KEY = 'pk_live_check';
  assert.deepEqual((await check()).body.check, { ok: false, mode: null, error: 'STRIPE_SECRET_KEY is not a secret key' });
  goLive();
  refuseKey = true;
  const r = await check();
  assert.equal(r.body.check.ok, false);
  assert.ok(r.body.check.packages.every(p => p.problem === 'Stripe refused STRIPE_SECRET_KEY'));
  assert.ok(!JSON.stringify(r.body).includes('sk_live_check'));
  refuseKey = false;
  const realRetrieve = stripe.prices.retrieve;
  stripe.prices.retrieve = async () => { throw Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError' }); };
  try {
    const restricted = await check();
    assert.ok(restricted.body.check.packages.every(p => p.problem === 'STRIPE_SECRET_KEY may not read Prices (a restricted key needs Prices and Products: Read)'));
  } finally {
    stripe.prices.retrieve = realRetrieve;
  }
});

test('only an admin runs the check; signed out it is refused', async () => {
  goLive();
  assert.equal((await check(analyst.token)).status, 403);
  assert.equal((await check(fulfillment.token)).status, 403);
  assert.equal((await check(null)).status, 401);
  assert.equal((await h.call('GET', '/api/command/ops')).status, 401);
  assert.equal(asked.length, 0, 'Stripe is never asked for them');
});

test('at boot, good Prices are said once and a bad configuration loudly, with an operator alert', async () => {
  await checkStripeAtStartup(readStripeConfig({ STRIPE_SECRET_KEY: '' }));
  assert.deepEqual(logged, [], 'no key: checkout is simply off, and nothing is said');

  goLive();
  await checkStripeAtStartup();
  assert.deepEqual(logLines('stripe_prices_checked').map(l => [l.level, l.mode, l.packages]), [['info', 'live', 4]]);
  assert.equal(logLines('ops_alert').length, 0);

  logged.length = 0;
  setStripeClientForTests(stripe);
  goLive({ STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_FromTestMode' });
  await checkStripeAtStartup();
  const bad = logLines('stripe_price_mismatch');
  assert.deepEqual(bad.map(l => [l.level, l.package_key, l.variable, l.problem]), [
    ['error', 'tournament_pro', 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO', 'is a test-mode Price, but STRIPE_SECRET_KEY is a live key'],
  ]);
  assert.match(logLines('ops_alert')[0].title, /refuses 1 of 4 packages/);

  logged.length = 0;
  goLive({ STRIPE_TEST_PRICES: JSON.stringify(LIVE) });
  asked.length = 0;
  await checkStripeAtStartup();
  assert.equal(logLines('stripe_config_mismatch')[0].level, 'error');
  assert.match(logLines('stripe_config_mismatch')[0].problem, /^STRIPE_SECRET_KEY is a live key, but STRIPE_TEST_PRICES is set/);
  assert.match(logLines('ops_alert')[0].title, /different modes/);
  assert.equal(asked.length, 0, 'a mismatch is said before Stripe is asked');
  for (const line of logged) for (const value of ['sk_live_check', 'whsec_check', ...Object.values(LIVE), 'price_FromTestMode']) assert.ok(!line.includes(value), `never logged: ${value}`);
});
