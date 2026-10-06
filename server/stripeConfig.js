// Stripe settings for the tournament checkout, read from the server's
// environment and nowhere else. The secret key and the webhook signing secret
// never reach the React app (handoff §1), and the repository is public, so no
// key lives in a tracked file. A missing or broken setting is logged by its
// name, never its value.
//
//   STRIPE_SECRET_KEY      sk_live_/rk_live_ in production; sk_test_/rk_test_ elsewhere
//   STRIPE_WEBHOOK_SECRET  the signing secret of the endpoint that calls /api/stripe/webhook
//   STRIPE_LIVE_PRICES     live keys only: {"individual_basic":"price_…", …}, set in Render
//   STRIPE_TEST_PRICES     test keys only: the same shape, with test-mode Prices
import Stripe from 'stripe';
import { keyMode, parsePrices, choosePrice, priceProblem, PRICE_VARIABLES, PACKAGES, PACKAGE_KEYS } from './tournamentOrderLogic.js';
import { log } from './observability.js';

// Read on every request, so a corrected setting needs only a restart and
// tests can change the environment between cases. Only the Price map for the
// key's mode is read.
export function readStripeConfig(env = process.env) {
  const secretKey = env.STRIPE_SECRET_KEY || '';
  const mode = keyMode(secretKey);
  const pricesVariable = mode ? PRICE_VARIABLES[mode] : null;
  const map = pricesVariable ? parsePrices(env[pricesVariable], pricesVariable) : { prices: {}, missing: [], problem: '' };
  return {
    secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', mode,
    pricesVariable, prices: map.prices, pricesMissing: map.missing, pricesProblem: map.problem,
  };
}

// The Price a package is charged at under this configuration, or null after
// logging (by name) what is missing. The caller refuses the checkout.
export function priceForPackage(config, packageKey) {
  const choice = choosePrice(packageKey, { mode: config.mode, prices: config.prices });
  if (choice.priceId) return choice.priceId;
  if (choice.error === 'not_configured') {
    log('warn', 'stripe_not_configured', { missing: config.secretKey ? 'a STRIPE_SECRET_KEY starting sk_/rk_ live_/test_' : 'STRIPE_SECRET_KEY' });
  } else {
    // stripe_live_price_missing or stripe_test_price_missing
    log('warn', `stripe_${config.mode}_price_missing`, { package_key: packageKey, problem: config.pricesProblem });
  }
  return null;
}

// Package and Price pairs Stripe has shown to charge that package's card
// price, per client (so per key): a Price that is right for one package is
// wrong for the others. A Price's amount, currency and type never change in
// Stripe, so one look per process is enough; a pair with a problem is looked
// at again on the next checkout.
const verified = new WeakMap();
function verifiedFor(client) {
  if (!verified.has(client)) verified.set(client, new Set());
  return verified.get(client);
}
const pair = (packageKey, priceId) => `${packageKey} ${priceId}`;

// Just before a checkout: '' when the Price charges exactly the package's card
// price, once, in US dollars (priceProblem); otherwise the problem, logged by
// package and variable, never by ID, so the caller refuses rather than
// charging a parent another amount. Throws when Stripe cannot answer.
export async function priceMismatch(stripe, config, packageKey, priceId) {
  const seen = verifiedFor(stripe);
  if (seen.has(pair(packageKey, priceId))) return '';
  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    if (err?.code !== 'resource_missing') throw err;
    price = null;   // a Price of the other mode, or a typo
  }
  const problem = priceProblem(packageKey, price);
  if (problem) log('warn', 'stripe_price_mismatch', { package_key: packageKey, variable: config.pricesVariable, problem });
  else seen.add(pair(packageKey, priceId));
  return problem;
}

// Why Stripe could not show a configured Price, without Stripe's own message,
// which names the ID.
function lookupProblem(err, mode) {
  if (err?.code === 'resource_missing') return `was not found in Stripe with this ${mode} key`;
  if (err?.type === 'StripeAuthenticationError') return 'Stripe refused STRIPE_SECRET_KEY';
  return `Stripe did not answer (${err?.type || 'error'})`;
}

// /command/ops at a glance: which key and Price map checkout runs on, and
// what is still to set, by name only (the web app names no Stripe setting).
export function checkoutSummary(config = readStripeConfig()) {
  const problems = [];
  if (!config.secretKey) problems.push('set STRIPE_SECRET_KEY');
  else if (!config.mode) problems.push('STRIPE_SECRET_KEY is not a secret key');
  if (config.pricesMissing.length) problems.push(`${config.pricesVariable} has no price for ${config.pricesMissing.join(', ')}`);
  if (!config.webhookSecret) problems.push('set STRIPE_WEBHOOK_SECRET');
  return { mode: config.mode, prices_variable: config.pricesVariable, problems };
}

// /command/ops "Stripe prices": every package's configured Price as Stripe has
// it (amount, type, currency, product name), so a new STRIPE_LIVE_PRICES is
// checked before a parent pays. Asks Stripe every time; IDs stay here.
export async function checkPrices(config = readStripeConfig()) {
  if (!config.mode) {
    return { ok: false, mode: null, error: config.secretKey ? 'STRIPE_SECRET_KEY is not a secret key' : 'STRIPE_SECRET_KEY is not set' };
  }
  const stripe = stripeClient(config);
  const packages = await Promise.all(PACKAGE_KEYS.map(async key => {
    const row = { package_key: key, label: PACKAGES[key].label, card_amount: PACKAGES[key].amount };
    const priceId = config.prices[key];
    if (!priceId) return { ...row, problem: `has no price_ id in ${config.pricesVariable}` };
    let price;
    try {
      price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    } catch (err) {
      return { ...row, problem: lookupProblem(err, config.mode) };
    }
    const problem = priceProblem(key, price);
    if (!problem) verifiedFor(stripe).add(pair(key, priceId));
    return {
      ...row, problem,
      amount: price.unit_amount ?? null, currency: price.currency ?? null, type: price.type ?? null, active: price.active ?? null,
      product_name: typeof price.product === 'object' ? price.product?.name ?? null : null,
    };
  }));
  return { ok: packages.every(p => !p.problem), mode: config.mode, variable: config.pricesVariable, packages };
}

// Signature checks need no API key, only the endpoint's signing secret.
export const stripeWebhooks = Stripe.webhooks;

let injected = null;
let cached = null;

// Tests replace the API client with a stub (never the webhook verifier); each
// call starts its Price checks afresh.
export function setStripeClientForTests(client) {
  injected = client;
  cached = null;
  if (client) verified.delete(client);
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
