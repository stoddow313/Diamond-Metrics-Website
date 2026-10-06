// Stripe settings for the tournament checkout, read from the server's
// environment and nowhere else. The secret key and the webhook signing secret
// never reach the React app (handoff §1), and the repository is public, so no
// key and no live Price ID lives in a tracked file. A missing or broken
// setting is logged by its name, never its value.
//
//   STRIPE_SECRET_KEY                    sk_live_/rk_live_ in production; sk_test_/rk_test_ elsewhere
//   STRIPE_WEBHOOK_SECRET                the signing secret of the endpoint that calls /api/stripe/webhook
//   STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC   live keys only, one live price_… each, set in Render
//   STRIPE_LIVE_PRICE_INDIVIDUAL_PRO
//   STRIPE_LIVE_PRICE_TOURNAMENT_BASIC
//   STRIPE_LIVE_PRICE_TOURNAMENT_PRO
//   STRIPE_TEST_PRICES                   test keys only: {"individual_basic":"price_…", …}
//
// The key decides the mode, and the other mode's Prices beside it refuse
// every checkout by name (priceSettings).
import Stripe from 'stripe';
import { priceSettings, choosePrice, priceProblem, missingPriceProblem, LIVE_PRICE_VARIABLES, PACKAGES, PACKAGE_KEYS } from './tournamentOrderLogic.js';
import { log, alertOps } from './observability.js';

// Read on every request, so a corrected setting needs only a restart and
// tests can change the environment between cases.
export function readStripeConfig(env = process.env) {
  return { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', ...priceSettings(env) };
}

// The setting a package's Price comes from under this configuration.
const priceVariable = (config, packageKey) => (config.mode === 'live' ? LIVE_PRICE_VARIABLES[packageKey] : 'STRIPE_TEST_PRICES');

// The Price a package is charged at under this configuration, or null after
// logging (by name) what is missing or mismatched. The caller refuses the
// checkout.
export function priceForPackage(config, packageKey) {
  const choice = choosePrice(packageKey, config);
  if (choice.priceId) return choice.priceId;
  if (choice.error === 'not_configured') {
    log('warn', 'stripe_not_configured', { missing: config.secretKey ? 'a STRIPE_SECRET_KEY starting sk_/rk_ live_/test_' : 'STRIPE_SECRET_KEY' });
  } else if (choice.error === 'mismatch') {
    log('error', 'stripe_config_mismatch', { problem: config.mismatch });
  } else {
    // stripe_live_price_missing or stripe_test_price_missing
    log('warn', `stripe_${config.mode}_price_missing`, { package_key: packageKey, problem: config.problems[packageKey] });
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

// One Price as Stripe has it, with '' as its problem when it charges exactly
// the package's card price, once, in US dollars (a Price of the other mode is
// a problem too). Throws when Stripe cannot answer.
async function lookUp(stripe, config, packageKey, priceId, params) {
  let price;
  try {
    price = await stripe.prices.retrieve(priceId, params);
  } catch (err) {
    if (err?.code !== 'resource_missing') throw err;
    return { price: null, problem: missingPriceProblem(err.message, config.mode) };
  }
  const problem = priceProblem(packageKey, price);
  if (!problem) verifiedFor(stripe).add(pair(packageKey, priceId));
  return { price, problem };
}

// Just before a checkout: '' when the Price may be charged for this package;
// otherwise the problem, logged by package and setting, never by ID, so the
// caller refuses rather than charging a parent another amount or another
// mode's Price. Throws when Stripe cannot answer.
export async function priceMismatch(stripe, config, packageKey, priceId) {
  if (verifiedFor(stripe).has(pair(packageKey, priceId))) return '';
  const { problem } = await lookUp(stripe, config, packageKey, priceId);
  if (problem) log('warn', 'stripe_price_mismatch', { package_key: packageKey, variable: priceVariable(config, packageKey), problem });
  return problem;
}

// Why Stripe could not show a configured Price, without Stripe's own message.
function lookupError(err) {
  if (err?.type === 'StripeAuthenticationError') return 'Stripe refused STRIPE_SECRET_KEY';
  if (err?.type === 'StripePermissionError') return 'STRIPE_SECRET_KEY may not read Prices (a restricted key needs Prices and Products: Read)';
  return `Stripe did not answer (${err?.type || 'error'})`;
}

// /command/ops at a glance: which key and Prices checkout runs on, and what is
// still to set or fix, by name only (the web app names no Stripe setting).
export function checkoutSummary(config = readStripeConfig()) {
  const problems = [];
  if (!config.secretKey) problems.push('set STRIPE_SECRET_KEY');
  else if (!config.mode) problems.push('STRIPE_SECRET_KEY is not a secret key');
  if (config.mismatch) problems.push(config.mismatch);
  else problems.push(...new Set(Object.values(config.problems)));
  if (!config.webhookSecret) problems.push('set STRIPE_WEBHOOK_SECRET');
  return { mode: config.mode, prices_from: config.source, problems };
}

// /command/ops "Stripe prices", and the check at boot: every package's
// configured Price as Stripe has it (amount, type, currency, product name),
// so new live Prices are checked before a parent pays. Asks Stripe every
// time; IDs stay here.
export async function checkPrices(config = readStripeConfig()) {
  if (!config.mode) {
    return { ok: false, mode: null, error: config.secretKey ? 'STRIPE_SECRET_KEY is not a secret key' : 'STRIPE_SECRET_KEY is not set' };
  }
  if (config.mismatch) return { ok: false, mode: config.mode, error: config.mismatch };
  const stripe = stripeClient(config);
  const packages = await Promise.all(PACKAGE_KEYS.map(async key => {
    const row = { package_key: key, label: PACKAGES[key].label, card_amount: PACKAGES[key].amount };
    const priceId = config.prices[key];
    if (!priceId) return { ...row, problem: config.problems[key] };
    let found;
    try {
      found = await lookUp(stripe, config, key, priceId, { expand: ['product'] });
    } catch (err) {
      return { ...row, problem: lookupError(err) };
    }
    const { price, problem } = found;
    if (!price) return { ...row, problem };
    return {
      ...row, problem,
      amount: price.unit_amount ?? null, currency: price.currency ?? null, type: price.type ?? null, active: price.active ?? null,
      product_name: typeof price.product === 'object' ? price.product?.name ?? null : null,
    };
  }));
  return { ok: packages.every(p => !p.problem), mode: config.mode, prices_from: config.source, packages };
}

// At boot, once: a configuration that cannot charge correctly is said loudly
// in the log, and to the operator alert hook when one is set, at deploy time
// rather than when a parent taps Pay. Checkout refuses the same things by
// itself, and this never blocks the boot. Nothing is said when no key is set
// (checkout is simply off).
export async function checkStripeAtStartup(config = readStripeConfig()) {
  if (!config.secretKey) return;
  if (!config.mode) {
    log('error', 'stripe_not_configured', { missing: 'a STRIPE_SECRET_KEY starting sk_/rk_ live_/test_' });
    alertOps('Tournament checkout is off: STRIPE_SECRET_KEY is not a secret key (sk_ or rk_, live_ or test_)');
    return;
  }
  if (config.mismatch) {
    log('error', 'stripe_config_mismatch', { problem: config.mismatch });
    alertOps('Tournament checkout refuses every order: the Stripe key and the Prices are from different modes', { problem: config.mismatch });
    return;
  }
  if (!config.webhookSecret) log('warn', 'stripe_webhook_not_configured', { missing: ['STRIPE_WEBHOOK_SECRET'] });
  let check;
  try {
    check = await checkPrices(config);
  } catch (err) {
    log('warn', 'stripe_prices_unchecked', { type: err?.type });
    return;
  }
  const failing = check.packages.filter(p => p.problem);
  if (!failing.length) {
    log('info', 'stripe_prices_checked', { mode: config.mode, packages: check.packages.length });
    return;
  }
  for (const p of failing) {
    log('error', 'stripe_price_mismatch', { package_key: p.package_key, variable: priceVariable(config, p.package_key), problem: p.problem });
  }
  alertOps(`Tournament checkout refuses ${failing.length} of ${check.packages.length} packages until their Stripe Prices are fixed`, {
    mode: config.mode, problems: failing.map(p => `${p.package_key}: ${p.problem}`),
  });
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
