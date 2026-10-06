// Rate limits on the two public tournament endpoints, with the limiter on
// (prd.md R10, AC28): 60 checkouts per address per 10 minutes, 10 per email
// per hour, 60 post-purchase calls per address per 10 minutes. A refused call
// stores nothing, and Stripe's webhook is never limited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-limits-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-tournament-limits-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
delete process.env.DM_RATE_LIMITS;   // the limiter is what is under test
process.env.STRIPE_SECRET_KEY = 'sk_test_limits';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_limits';
process.env.STRIPE_TEST_PRICES = JSON.stringify({ individual_basic: 'price_LimA', individual_pro: 'price_LimB', tournament_basic: 'price_LimC', tournament_pro: 'price_LimD' });

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests } = await import('./stripeConfig.js');

let made = 0;
const stripe = { checkout: { sessions: {
  async create() { const id = `cs_test_lim${++made}`; return { id, url: `https://checkout.stripe.com/c/pay/${id}` }; },
  async retrieve(id) { return { id, payment_status: 'unpaid', client_reference_id: null }; },
} } };

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
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

async function post(path, body, ip, headers = {}) {
  const res = await fetch(h.base + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...headers },
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') };
}
const checkout = (email, ip) => post('/api/create-checkout-session', {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email, phone: '',
  tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
}, ip);
const orders = () => db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n;

test('the 61st checkout from one address in 10 minutes is refused and saves nothing', async () => {
  for (let i = 1; i <= 60; i++) {
    const r = await checkout(`parent${i}@example.com`, '203.0.113.10');
    assert.equal(r.status, 200, `call ${i}`);
  }
  const before = orders();
  const r = await checkout('parent61@example.com', '203.0.113.10');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /^Too many checkout attempts from this network\. Try again in \d+ (minutes|seconds)\.$/);
  assert.ok(Number(r.retryAfter) > 0);
  assert.equal(orders(), before, 'no order');
  assert.equal((await checkout('parent62@example.com', '203.0.113.11')).status, 200, 'another address is unaffected');
});

test('the 11th checkout for one email in an hour is refused, whatever the address', async () => {
  for (let i = 1; i <= 10; i++) {
    const r = await checkout(' Repeat.Parent@Example.com ', `198.51.100.${i}`);
    assert.equal(r.status, 200, `call ${i}`);
  }
  const before = orders();
  const r = await checkout('repeat.parent@example.com', '198.51.100.99');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /^Too many checkout attempts for this email\. Try again in \d+ minutes\.$/);
  assert.equal(orders(), before);
});

test('the 61st post-purchase call from one address in 10 minutes is refused', async () => {
  const details = { sessionId: 'cs_test_not_ours', teamClub: 'Example Hawks 14U', jerseyNumber: '12', primaryPosition: 'Shortstop' };
  for (let i = 1; i <= 60; i++) {
    const r = await post('/api/post-purchase-intake', details, '192.0.2.20');
    assert.equal(r.status, 402, `call ${i} reaches the payment check`);
  }
  const r = await post('/api/post-purchase-intake', details, '192.0.2.20');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /^Too many attempts from this network\. Try again in \d+ (minutes|seconds)\.$/);
});

test('Stripe’s webhook is never limited', async () => {
  for (let i = 1; i <= 120; i++) {
    const r = await post('/api/stripe/webhook', { id: `evt_${i}` }, '192.0.2.30', { 'Stripe-Signature': 't=1,v1=00' });
    assert.equal(r.status, 400, `call ${i} is judged by its signature, not counted`);
  }
});
