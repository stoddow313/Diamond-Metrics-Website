// `npm run dev`: the API and the Vite site together, with the site proxying
// /api to the API so the browser sees one origin.
//
//   npm run dev                                                  site :5173, API :3001
//   PORT=5901 HOST=0.0.0.0 npm run dev -- --host 0.0.0.0 --port 5901
//
// PORT / HOST (and Vite's own --port / --host, passed through untouched) pick
// where the site answers; HOST=0.0.0.0 is what a phone on the studio's
// http://<mac>.local:<port> link needs. The API listens on DM_API_PORT, else
// 3001 — or, when another process already holds 3001, on a free port, so the
// site's /api never reaches some other server by accident. DM_API_PROXY still
// overrides where the site sends /api.
//
// Stripe webhooks: with a test key (sk_test_/rk_test_) and no
// STRIPE_WEBHOOK_SECRET, the Stripe CLI's `stripe listen` forwards
// checkout.session.completed to this API and its signing secret goes to the
// API, so a test payment made on a phone is marked paid as in production.
// STRIPE_CLI names the binary when `stripe` is not on PATH. Setting
// STRIPE_WEBHOOK_SECRET yourself means you forward webhooks yourself.
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import readline from 'node:readline';
import concurrently from 'concurrently';

const DEFAULT_API_PORT = 3001;

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function chooseApiPort() {
  if (process.env.DM_API_PORT) return Number(process.env.DM_API_PORT);
  if (process.env.DM_API_PROXY || await portIsFree(DEFAULT_API_PORT)) return DEFAULT_API_PORT;
  const port = await freePort();
  console.log(`[dev] Port ${DEFAULT_API_PORT} is held by another process; this API runs on ${port} instead.`);
  return port;
}

// Signing secrets never reach the console, even in the CLI's own output.
const redact = line => line.replace(/whsec_[A-Za-z0-9]+/g, 'whsec_…');

function startStripeListener(apiPort) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (process.env.STRIPE_WEBHOOK_SECRET || !/^(sk|rk)_test_/.test(key)) return null;
  const cli = process.env.STRIPE_CLI || 'stripe';
  const env = { ...process.env, STRIPE_API_KEY: key };
  let secret = '';
  try {
    secret = execFileSync(cli, ['listen', '--print-secret'], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    secret = '';
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(secret)) {
    console.log('[dev] Stripe webhooks are NOT forwarded, so test payments will not be marked paid. Install the Stripe CLI'
      + ' (brew install stripe/stripe-cli/stripe), or set STRIPE_CLI to its path, or run `stripe listen` yourself and set STRIPE_WEBHOOK_SECRET.');
    return null;
  }
  const target = `http://localhost:${apiPort}/api/stripe/webhook`;
  const child = spawn(cli, ['listen', '--events', 'checkout.session.completed', '--forward-to', target], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', line => {
      if (!line.startsWith('<claude-code-hint')) console.log(`[stripe] ${redact(line)}`);
    });
  }
  child.on('exit', code => console.log(`[stripe] stripe listen stopped (${code ?? 'signal'}); webhooks are no longer forwarded.`));
  process.on('exit', () => child.kill());
  console.log(`[dev] Forwarding Stripe test-mode webhooks to ${target}`);
  return { secret };
}

const shellQuote = arg => `'${String(arg).replace(/'/g, `'\\''`)}'`;

const apiPort = await chooseApiPort();
const apiProxy = process.env.DM_API_PROXY || `http://localhost:${apiPort}`;
const viteArgs = process.argv.slice(2).map(shellQuote).join(' ');
const listener = startStripeListener(apiPort);

const { result } = concurrently([
  // PORT belongs to the site; the API reads DM_API_PORT (server/index.js).
  {
    command: 'npm run server', name: 'api', prefixColor: 'blue',
    env: { PORT: '', DM_API_PORT: String(apiPort), ...(listener ? { STRIPE_WEBHOOK_SECRET: listener.secret } : {}) },
  },
  { command: `vite ${viteArgs}`.trim(), name: 'web', prefixColor: 'green', env: { DM_API_PROXY: apiProxy } },
], { prefix: 'name', killOthersOn: ['failure'] });

result.then(() => process.exit(0), () => process.exit(1));
