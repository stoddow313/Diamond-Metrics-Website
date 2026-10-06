// Stripe settings for the tournament checkout, read from the server's
// environment and nowhere else. The secret key and the webhook signing secret
// never reach the React app (handoff §1), and the repository is public, so no
// key lives in a tracked file. A missing or broken setting is logged by its
// name, never its value.
//
//   STRIPE_SECRET_KEY      sk_live_/rk_live_ in production; sk_test_/rk_test_ elsewhere
//   STRIPE_WEBHOOK_SECRET  the signing secret of the endpoint that calls /api/stripe/webhook
//   STRIPE_TEST_PRICES     test keys only: {"individual_basic":"price_…", …}
import Stripe from 'stripe';
import { keyMode, parseTestPrices, choosePrice } from './tournamentOrderLogic.js';
import { log } from './observability.js';

// Read on every request, so a corrected setting needs only a restart and
// tests can change the environment between cases.
export function readStripeConfig(env = process.env) {
  const secretKey = env.STRIPE_SECRET_KEY || '';
  const mode = keyMode(secretKey);
  const test = mode === 'test' ? parseTestPrices(env.STRIPE_TEST_PRICES) : { prices: {}, problem: '' };
  return { secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', mode, testPrices: test.prices, testPricesProblem: test.problem };
}

// The Price a package is charged at under this configuration, or null after
// logging (by name) what is missing. The caller refuses the checkout.
export function priceForPackage(config, packageKey) {
  const choice = choosePrice(packageKey, { mode: config.mode, testPrices: config.testPrices });
  if (choice.priceId) return choice.priceId;
  if (choice.error === 'not_configured') {
    log('warn', 'stripe_not_configured', { missing: config.secretKey ? 'a STRIPE_SECRET_KEY starting sk_/rk_ live_/test_' : 'STRIPE_SECRET_KEY' });
  } else {
    log('warn', 'stripe_test_price_missing', { package_key: packageKey, problem: config.testPricesProblem });
  }
  return null;
}

// Signature checks need no API key, only the endpoint's signing secret.
export const stripeWebhooks = Stripe.webhooks;

let injected = null;
let cached = null;

// Tests replace the API client with a stub (never the webhook verifier).
export function setStripeClientForTests(client) {
  injected = client;
  cached = null;
}

// One client per configured key, built on first use.
export function stripeClient(config) {
  if (injected) return injected;
  if (!config.secretKey) return null;
  if (cached?.key !== config.secretKey) {
    cached = { key: config.secretKey, client: new Stripe(config.secretKey, { maxNetworkRetries: 1, timeout: 20_000 }) };
  }
  return cached.client;
}
