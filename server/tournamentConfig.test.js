// Tournament checkout configuration: Stripe settings come from the server's
// environment only, and a server without them still boots, refuses checkout
// and lets the webhook change nothing (prd.md R7, AC21, AC23).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = `/tmp/dm-tournament-config-${process.pid}`;
fs.mkdirSync(TMP, { recursive: true });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { readStripeConfig, priceForPackage } = await import('./stripeConfig.js');

test('settings are read from the environment, and prices follow the key', () => {
  const testPrices = JSON.stringify({ individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' });
  const livePrices = JSON.stringify({ individual_basic: 'price_L1', individual_pro: 'price_L2', tournament_basic: 'price_L3', tournament_pro: 'price_L4' });
  const both = { STRIPE_TEST_PRICES: testPrices, STRIPE_LIVE_PRICES: livePrices };
  const test_ = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', ...both });
  assert.equal(test_.mode, 'test');
  assert.equal(test_.pricesVariable, 'STRIPE_TEST_PRICES');
  assert.equal(priceForPackage(test_, 'tournament_pro'), 'price_D4', 'a test key ignores the live map');
  const live = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abc', ...both });
  assert.equal(live.mode, 'live');
  assert.equal(live.pricesVariable, 'STRIPE_LIVE_PRICES');
  assert.equal(priceForPackage(live, 'tournament_pro'), 'price_L4', 'a live key ignores the test map');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'rk_live_abc', ...both }), 'individual_basic'), 'price_L1', 'a restricted live key too');
  assert.equal(priceForPackage(readStripeConfig({}), 'tournament_pro'), null, 'no key: no price');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'pk_test_abc', ...both }), 'tournament_pro'), null, 'a publishable key is not a secret key');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_LIVE_PRICES: livePrices }), 'tournament_pro'), null, 'a test key without a test map refuses');
  const noLiveMap = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_TEST_PRICES: testPrices });
  assert.equal(priceForPackage(noLiveMap, 'tournament_pro'), null, 'a live key without STRIPE_LIVE_PRICES refuses: no live Price is kept in code');
  assert.equal(noLiveMap.pricesProblem, 'STRIPE_LIVE_PRICES is not set');
});

test('no Stripe Price ID is written into server code: prices live in the environment', () => {
  const files = fs.readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, 'server', file), 'utf8');
    assert.ok(!/price_[A-Za-z0-9]{14,}/.test(source), `server/${file} must not hold a Stripe Price ID`);
  }
});

test('no Stripe key, signing secret or Price map is written into the web app or render.yaml', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(ROOT, 'src')).filter(f => /\.(jsx?|css|html)$/.test(f))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/STRIPE_|(sk|rk)_(test|live)_|whsec_/.test(source), `${path.relative(ROOT, file)} must not mention a Stripe secret`);
  }
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_LIVE_PRICES']) {
    const block = render.slice(render.indexOf(`- key: ${key}`)).split('\n').slice(0, 2).join('\n');
    assert.match(block, new RegExp(`- key: ${key}\\n\\s+sync: false`), `${key} is declared with sync: false`);
    assert.ok(!/value:/.test(block), `${key} has no value in render.yaml`);
  }
});

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('with no Stripe variables the API boots, refuses checkout and the webhook changes nothing', async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DM_DB_PATH: `${TMP}/dm.db`, DM_MEDIA_DIR: `${TMP}/media`, DM_STORAGE: 'local', DM_BACKUPS: '0', DM_INLINE_WORKER: '0', DM_ENV: 'development' };
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_PRICES', 'STRIPE_LIVE_PRICES', 'DM_LOG_SILENT']) delete env[k];
  const api = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  api.stdout.on('data', d => { output += d; });
  api.stderr.on('data', d => { output += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health = null;
    for (let i = 0; i < 100 && !health; i++) {
      health = await fetch(`${base}/api/health`).then(r => r.json()).catch(() => null);
      if (!health) await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(health, { ok: true });

    const checkout = await fetch(`${base}/api/create-checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com', phone: '', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro' }),
    });
    assert.ok(checkout.status >= 500, `checkout answered ${checkout.status}`);
    assert.deepEqual(await checkout.json(), { error: 'We could not start secure checkout. Please try again.' });

    const webhook = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=00' },
      body: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { id: 'cs_test_x', client_reference_id: 'TO-AAAA-AAAA', payment_status: 'paid' } } }),
    });
    assert.equal(webhook.status, 400);
    assert.ok((await webhook.json()).error);
  } finally {
    api.kill();
    await new Promise(r => api.once('exit', r));
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(`${TMP}/dm.db`, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n, 0, 'nothing stored');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stripe_events').get().n, 0);
  db.close();
  assert.ok(!/Jordan|Sky Example|jordan@example\.com/.test(output), 'the API log carries no parent or player data');
});
