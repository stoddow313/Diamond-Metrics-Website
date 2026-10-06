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

const TEST_MAP = JSON.stringify({ individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' });
const LIVE_ENV = {
  STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: 'price_L1', STRIPE_LIVE_PRICE_INDIVIDUAL_PRO: 'price_L2',
  STRIPE_LIVE_PRICE_TOURNAMENT_BASIC: 'price_L3', STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_L4',
};
const STRIPE_VARIABLES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_PRICES', ...Object.keys(LIVE_ENV)];

test('settings are read from the environment, and the key decides which Prices', () => {
  const test_ = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', STRIPE_TEST_PRICES: TEST_MAP });
  assert.equal(test_.mode, 'test');
  assert.equal(test_.webhookSecret, 'whsec_abc');
  assert.equal(priceForPackage(test_, 'tournament_pro'), 'price_D4', 'local test mode as before');
  const live = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abc', ...LIVE_ENV });
  assert.equal(live.mode, 'live');
  assert.equal(priceForPackage(live, 'tournament_pro'), 'price_L4');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'rk_live_abc', ...LIVE_ENV }), 'individual_basic'), 'price_L1', 'a restricted live key too');
  assert.equal(priceForPackage(readStripeConfig({}), 'tournament_pro'), null, 'no key: no price');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_TEST_PRICES: TEST_MAP }), 'tournament_pro'), null, 'a publishable key is not a secret key');
  assert.equal(priceForPackage(readStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' }), 'tournament_pro'), null, 'a test key without a test map refuses');
  const noLivePrice = readStripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abc', ...LIVE_ENV, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: '' });
  assert.equal(priceForPackage(noLivePrice, 'tournament_pro'), null, 'a live key without that package’s setting refuses: no live Price is kept in code');
  assert.equal(noLivePrice.problems.tournament_pro, 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO is not set');
  assert.equal(priceForPackage(noLivePrice, 'tournament_basic'), 'price_L3');
});

test('a key with the other mode’s Prices refuses every package', () => {
  for (const env of [
    { STRIPE_SECRET_KEY: 'sk_live_abc', ...LIVE_ENV, STRIPE_TEST_PRICES: TEST_MAP },
    { STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_TEST_PRICES: TEST_MAP, STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: 'price_L1' },
  ]) {
    const config = readStripeConfig(env);
    assert.ok(config.mismatch);
    for (const key of ['individual_basic', 'individual_pro', 'tournament_basic', 'tournament_pro']) assert.equal(priceForPackage(config, key), null, key);
  }
});

test('no real Stripe Price ID or live key is written anywhere in the code, tests or docs', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = ['server', 'src', 'docs', 'scripts'].flatMap(dir => walk(path.join(ROOT, dir)))
    .filter(f => /\.(jsx?|mjs|css|html|md|json|ya?ml)$/.test(f))
    .concat(['README.md', 'render.yaml', 'vercel.json', 'AGENTS.md'].map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f)));
  assert.ok(files.length > 100, 'the walk found the repository');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // Stripe's own ids are long (price_1 and 20-odd letters and digits; keys
    // far longer); the tests' made-up ones are short words.
    assert.ok(!/price_1[A-Za-z0-9]{20,}/.test(source), `${path.relative(ROOT, file)} must not hold a Stripe Price ID`);
    assert.ok(!/(sk|rk)_live_[A-Za-z0-9]{24,}/.test(source), `${path.relative(ROOT, file)} must not hold a live key`);
  }
});

test('no Stripe key, signing secret or Price is written into the web app or render.yaml', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(ROOT, 'src')).filter(f => /\.(jsx?|css|html)$/.test(f))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/STRIPE_|(sk|rk)_(test|live)_|whsec_/.test(source), `${path.relative(ROOT, file)} must not mention a Stripe secret`);
  }
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...Object.keys(LIVE_ENV)]) {
    const block = render.slice(render.indexOf(`- key: ${key}`)).split('\n').slice(0, 2).join('\n');
    assert.match(block, new RegExp(`- key: ${key}\\n\\s+sync: false`), `${key} is declared with sync: false`);
    assert.ok(!/value:/.test(block), `${key} has no value in render.yaml`);
  }
  assert.ok(!render.includes('- key: STRIPE_TEST_PRICES'), 'production never declares test Prices');
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
  for (const k of [...STRIPE_VARIABLES, 'DM_LOG_SILENT']) delete env[k];
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

// Boots the real API with these Stripe settings (and no others) on its own
// database; the configurations here stop before Stripe is ever asked.
async function bootWith(stripeEnv, name) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DM_DB_PATH: `${TMP}/${name}.db`, DM_MEDIA_DIR: `${TMP}/media`, DM_STORAGE: 'local', DM_BACKUPS: '0', DM_INLINE_WORKER: '0', DM_ENV: 'production', DM_ADMIN_PASSWORD: 'config-test-password' };
  for (const k of [...STRIPE_VARIABLES, 'DM_LOG_SILENT', 'DM_ALERT_WEBHOOK_URL']) delete env[k];
  Object.assign(env, stripeEnv);
  const api = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { output: '', base: `http://127.0.0.1:${port}` };
  api.stdout.on('data', d => { run.output += d; });
  api.stderr.on('data', d => { run.output += d; });
  run.stop = async () => { api.kill(); await new Promise(r => api.once('exit', r)); };
  for (let i = 0; i < 100 && !run.output.includes('api_started'); i++) await new Promise(r => setTimeout(r, 100));
  return run;
}

test('a live key with test Prices, or a test key with a live Price, is said at startup and refuses every checkout', async () => {
  const cases = [
    ['live-with-test', { STRIPE_SECRET_KEY: 'sk_live_configtest', STRIPE_WEBHOOK_SECRET: 'whsec_configtest', ...LIVE_ENV, STRIPE_TEST_PRICES: TEST_MAP },
      'STRIPE_SECRET_KEY is a live key, but STRIPE_TEST_PRICES is set'],
    ['test-with-live', { STRIPE_SECRET_KEY: 'sk_test_configtest', STRIPE_WEBHOOK_SECRET: 'whsec_configtest', STRIPE_TEST_PRICES: TEST_MAP, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_L4' },
      'STRIPE_SECRET_KEY is a test key, but STRIPE_LIVE_PRICE_TOURNAMENT_PRO is set'],
  ];
  for (const [name, stripeEnv, said] of cases) {
    const run = await bootWith(stripeEnv, name);
    try {
      for (let i = 0; i < 50 && !run.output.includes('stripe_config_mismatch'); i++) await new Promise(r => setTimeout(r, 100));
      const line = run.output.split('\n').find(l => l.includes('"stripe_config_mismatch"'));
      assert.ok(line?.includes(said), `${name}: said at startup, before any parent: ${run.output.slice(-600)}`);
      assert.ok(run.output.includes('"ops_alert"'), `${name}: an operator alert`);
      const checkout = await fetch(`${run.base}/api/create-checkout-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com', phone: '', tournamentId: 'better-baseball-nephi-2026', packageId: 'individual_basic' }),
      });
      assert.equal(checkout.status, 503, name);
      assert.deepEqual(await checkout.json(), { error: 'We could not start secure checkout. Please try again.' });
      assert.ok(run.output.split('\n').filter(l => l.includes('"stripe_config_mismatch"')).length >= 2, `${name}: the refusal names it again`);
      for (const value of ['price_L1', 'price_L4', 'price_A1', 'configtest']) assert.ok(!run.output.includes(value), `${name}: no value is logged`);
    } finally {
      await run.stop();
    }
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(`${TMP}/${name}.db`, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tournament_orders').get().n, 0, `${name}: nothing stored`);
    db.close();
  }
});
