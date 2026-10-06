// Tournament checkout ("Find your player", QR) — pure rules, no database and
// no Stripe calls. Source: the Diamond Metrics Tournament Checkout Developer
// Handoff (2026-10-06, sections cited as handoff §n); decision record:
// docs/COMMAND_TDR.md. The browser sends a package key only; which Stripe
// Price is charged is decided here and nowhere else (handoff §1).
import { randomInt } from 'node:crypto';

// Will's four packages. amount is the price on the package card, in cents.
// Which Stripe Price charges a package comes from the environment, never from
// code or the browser (choosePrice), and a Price that does not charge exactly
// this amount, once, in US dollars is refused (priceProblem).
export const PACKAGES = {
  individual_basic: { label: 'Individual Game — Basic', amount: 5000 },
  individual_pro: { label: 'Individual Game — Pro', amount: 7500 },
  tournament_basic: { label: 'Single Tournament — Basic', amount: 12500 },
  tournament_pro: { label: 'Single Tournament — Pro', amount: 15000 },
};
export const PACKAGE_KEYS = Object.keys(PACKAGES);

// Production's live Prices: one setting per package, each a live-mode
// `price_…` ID set in Render beside the live key (ship gate, round 2,
// 2026-10-06), so no live Price ID is ever in code, the repository or a
// laptop: STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC and so on.
export const LIVE_PRICE_VARIABLES = Object.fromEntries(PACKAGE_KEYS.map(key => [key, `STRIPE_LIVE_PRICE_${key.toUpperCase()}`]));

// The events a parent can buy for. Adding the next tournament is a code change
// and a deploy (A21); the id is stored as text, not a tournaments row.
export const TOURNAMENTS = {
  'better-baseball-nephi-2026': { label: 'Better Baseball — Nephi, Utah · October 9–10, 2026' },
};

export const packageLabel = key => (Object.hasOwn(PACKAGES, key) ? PACKAGES[key].label : key);
export const tournamentLabel = id => (Object.hasOwn(TOURNAMENTS, id) ? TOURNAMENTS[id].label : id);

export const TEXT_LIMIT = 200;
export const NOTE_LIMIT = 1000;

// Will's page sends strings; a number (a jersey typed by another client) is
// read as its digits, and anything else as blank.
function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

const tooLong = (label, limit) => `Shorten ${label} to ${limit.toLocaleString('en-US')} characters or fewer.`;

// Each field: required message (Will's wording) when blank, then the length cap.
function readFields(body, fields) {
  const value = {};
  for (const f of fields) {
    const v = text(body?.[f.key]);
    if (!v && f.required) return { error: f.required };
    if ([...v].length > (f.limit || TEXT_LIMIT)) return { error: tooLong(f.label, f.limit || TEXT_LIMIT) };
    value[f.key] = v;
  }
  return { value };
}

const CONTACT_FIELDS = [
  { key: 'guardianName', label: 'the parent or guardian name', required: 'Enter the parent or guardian name.' },
  { key: 'playerName', label: 'the player name', required: 'Enter the player name.' },
  { key: 'email', label: 'the email', required: 'Enter an email address.' },
];
const PHONE_FIELD = [{ key: 'phone', label: 'the phone number' }];

// POST /api/create-checkout-session. Only these six fields are read: amount,
// price, priceId or anything else the browser adds never reaches a decision.
// Checked in the order the parent filled them in.
export function validateCheckout(body) {
  const contact = readFields(body, CONTACT_FIELDS);
  if (contact.error) return contact;
  const { guardianName, playerName, email } = contact.value;
  // The same shape Will's page checks before it lets the parent continue.
  if (!/^\S+@\S+\.\S+$/.test(email)) return { error: 'Enter a valid email address.' };
  const phoneField = readFields(body, PHONE_FIELD);
  if (phoneField.error) return phoneField;
  const { phone } = phoneField.value;
  const tournamentId = text(body?.tournamentId);
  if (!Object.hasOwn(TOURNAMENTS, tournamentId)) return { error: 'Choose the tournament attended.' };
  const packageKey = text(body?.packageId);
  if (!Object.hasOwn(PACKAGES, packageKey)) return { error: 'Choose a package.' };
  return { value: { guardianName, playerName, email, phone, tournamentId, packageKey } };
}

// The post-purchase identification step (handoff §6): three required, three
// optional; the column each one is stored in.
export const DETAIL_FIELDS = [
  { key: 'teamClub', column: 'team_club', label: 'the team or club', required: 'Enter the team or club.' },
  { key: 'jerseyNumber', column: 'jersey_number', label: 'the jersey number', required: 'Enter the jersey number.' },
  { key: 'primaryPosition', column: 'primary_position', label: 'the primary position', required: 'Enter the primary position.' },
  { key: 'batsThrows', column: 'bats_throws', label: 'bats / throws' },
  { key: 'gameContext', column: 'game_context', label: 'the game date or opponent' },
  { key: 'notes', column: 'notes', label: 'the note', limit: NOTE_LIMIT },
];

export function validateDetails(body) {
  return readFields(body, DETAIL_FIELDS);
}

// sk_live_ / rk_live_ → 'live', sk_test_ / rk_test_ → 'test', else null.
export function keyMode(secretKey) {
  const m = /^(?:sk|rk)_(live|test)_/.exec(String(secretKey || ''));
  return m ? m[1] : null;
}

const isPriceId = value => typeof value === 'string' && /^price_[A-Za-z0-9]+$/.test(value);

// STRIPE_TEST_PRICES: {"individual_basic":"price_…", …}. Problems are named,
// never echoed, so a log line cannot carry the configured values; problems
// holds one per package that has no Price.
export function parseTestPrices(raw) {
  const none = problem => ({ prices: {}, missing: [...PACKAGE_KEYS], problem, problems: Object.fromEntries(PACKAGE_KEYS.map(key => [key, problem])) });
  if (!raw) return none('STRIPE_TEST_PRICES is not set');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none('STRIPE_TEST_PRICES is not a JSON object');
  const prices = {};
  const missing = [];
  for (const key of PACKAGE_KEYS) {
    if (isPriceId(parsed[key])) prices[key] = parsed[key];
    else missing.push(key);
  }
  return {
    prices, missing,
    problem: missing.length ? `STRIPE_TEST_PRICES has no price_ id for ${missing.join(', ')}` : '',
    problems: Object.fromEntries(missing.map(key => [key, `STRIPE_TEST_PRICES has no price_ id for ${key}`])),
  };
}

// What is wrong with one live Price setting, or '': named, never echoed. A
// product ID is the likely slip, since Stripe shows it first.
function livePriceProblem(variable, value) {
  if (!value) return `${variable} is not set`;
  if (isPriceId(value)) return '';
  if (value.startsWith('prod_')) return `${variable} holds a product ID (prod_…), not the product's Price ID (price_…)`;
  return `${variable} is not a Price ID (price_…)`;
}

// The environment decides the mode: the key's prefix (keyMode) says live or
// test, and each mode reads only its own Prices, a live key the four
// STRIPE_LIVE_PRICE_* settings and a test key STRIPE_TEST_PRICES. The other
// mode's Prices beside a key is a mismatch, named here so that every checkout
// is refused before Stripe is asked: a live key never meets a test Price, or a
// test key a live one, when a parent taps Pay.
export function priceSettings(env = {}) {
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  const source = { live: 'STRIPE_LIVE_PRICE_*', test: 'STRIPE_TEST_PRICES' }[mode] || null;
  const settings = { mode, source, prices: {}, missing: [], problems: {}, mismatch: '' };
  const liveSet = Object.values(LIVE_PRICE_VARIABLES).filter(name => String(env[name] ?? '').trim());
  if (mode === 'live' && env.STRIPE_TEST_PRICES) {
    settings.mismatch = 'STRIPE_SECRET_KEY is a live key, but STRIPE_TEST_PRICES is set: a live key never charges test Prices. '
      + 'Remove STRIPE_TEST_PRICES; live Prices come from the four STRIPE_LIVE_PRICE_* settings.';
  } else if (mode === 'test' && liveSet.length) {
    const many = liveSet.length > 1;
    settings.mismatch = `STRIPE_SECRET_KEY is a test key, but ${liveSet.join(', ')} ${many ? 'are' : 'is'} set: a test key never charges live Prices. `
      + `Remove ${many ? 'them' : 'it'}; test Prices come from STRIPE_TEST_PRICES.`;
  } else if (mode === 'live') {
    for (const key of PACKAGE_KEYS) {
      const value = String(env[LIVE_PRICE_VARIABLES[key]] ?? '').trim();
      const problem = livePriceProblem(LIVE_PRICE_VARIABLES[key], value);
      if (problem) {
        settings.missing.push(key);
        settings.problems[key] = problem;
      } else {
        settings.prices[key] = value;
      }
    }
  } else if (mode === 'test') {
    const test = parseTestPrices(env.STRIPE_TEST_PRICES);
    Object.assign(settings, { prices: test.prices, missing: test.missing, problems: test.problems });
  }
  return settings;
}

// Which Stripe Price a package is charged at (handoff §1), from the Prices
// priceSettings read for the key's mode. Anything else refuses rather than
// charging a guess.
export function choosePrice(packageKey, { mode, prices = {}, mismatch = '' } = {}) {
  if (!Object.hasOwn(PACKAGES, packageKey)) return { error: 'unknown_package' };
  if (mode !== 'live' && mode !== 'test') return { error: 'not_configured' };
  if (mismatch) return { error: 'mismatch' };
  return isPriceId(prices[packageKey]) ? { priceId: prices[packageKey] } : { error: 'price_missing' };
}

// Stripe answers a Price of the other mode as missing, adding "a similar
// object exists in test mode, but a live mode key was used". Says which,
// without Stripe's message, which names the ID.
export function missingPriceProblem(stripeMessage, mode) {
  const other = /similar object exists in (live|test) mode/i.exec(String(stripeMessage || ''))?.[1]?.toLowerCase();
  if (other && other !== mode) return `is a ${other}-mode Price, but STRIPE_SECRET_KEY is a ${mode} key`;
  return `was not found in Stripe with this ${mode} key`;
}

const dollars = cents => `$${(cents / 100).toFixed(2)}`;

// What is wrong with the Stripe Price configured for a package, in words an
// operator can act on, or '' when it charges exactly the card's price: active,
// one-time, in US dollars. Never names the Price ID.
export function priceProblem(packageKey, price) {
  const card = PACKAGES[packageKey].amount;
  if (!price) return 'was not found in Stripe';
  if (price.active !== true) return 'is archived in Stripe';
  if (price.type !== 'one_time') return 'is a recurring Price, not a one-time one';
  if (price.currency !== 'usd') return `is in ${String(price.currency || 'no currency').toUpperCase()}, not USD`;
  if (price.unit_amount !== card) {
    const charged = Number.isInteger(price.unit_amount) ? dollars(price.unit_amount) : 'no fixed amount';
    return `charges ${charged}, not the card’s ${dollars(card)}`;
  }
  return '';
}

// TO-XXXX-XXXX: random, never the row number (A17), from the intake id
// alphabet (intakeLogic.js) so it reads aloud without 0/O/1/I/L/U mix-ups.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newOrderId(rand = randomInt) {
  const pick = () => ID_ALPHABET[rand(ID_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `TO-${block()}-${block()}`;
}
