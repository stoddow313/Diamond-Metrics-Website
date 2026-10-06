// Tournament checkout ("Find your player", QR) — pure rules, no database and
// no Stripe calls. Source: the Diamond Metrics Tournament Checkout Developer
// Handoff (2026-10-06, sections cited as handoff §n); decision record:
// docs/COMMAND_TDR.md. The browser sends a package key only; which Stripe
// Price is charged is decided here and nowhere else (handoff §1).
import { randomInt } from 'node:crypto';

// Will's four packages. livePriceId is handoff §1's live-mode Price — public,
// not a secret, and charged only with a live key (choosePrice). amount is the
// list price in cents; Stripe's Price, not this number, decides the charge.
export const PACKAGES = {
  individual_basic: { label: 'Individual Game — Basic', amount: 5000, livePriceId: 'price_1UNGeTQkGlcnNPo07CCI0CCK' },
  individual_pro: { label: 'Individual Game — Pro', amount: 7500, livePriceId: 'price_1UNGepQkGlcnNPo05FmG7Olz' },
  tournament_basic: { label: 'Single Tournament — Basic', amount: 12500, livePriceId: 'price_1UNGfFQkGlcnNPo0PCeTqYNO' },
  tournament_pro: { label: 'Single Tournament — Pro', amount: 15000, livePriceId: 'price_1UNGfZQkGlcnNPo0i8SqGcm7' },
};
export const PACKAGE_KEYS = Object.keys(PACKAGES);

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
// never echoed, so a log line cannot carry the configured values.
export function parseTestPrices(raw) {
  if (!raw) return { prices: {}, missing: [...PACKAGE_KEYS], problem: 'STRIPE_TEST_PRICES is not set' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { prices: {}, missing: [...PACKAGE_KEYS], problem: 'STRIPE_TEST_PRICES is not a JSON object' };
  }
  const prices = {};
  const missing = [];
  for (const key of PACKAGE_KEYS) {
    if (isPriceId(parsed[key])) prices[key] = parsed[key];
    else missing.push(key);
  }
  return { prices, missing, problem: missing.length ? `STRIPE_TEST_PRICES has no price_ id for ${missing.join(', ')}` : '' };
}

// Which Stripe Price a package is charged at (handoff §1). A live key charges
// only the handoff's live prices and ignores the test map; a test key only the
// test map. Anything else refuses rather than charging a guess.
export function choosePrice(packageKey, { mode, testPrices = {} } = {}) {
  if (!Object.hasOwn(PACKAGES, packageKey)) return { error: 'unknown_package' };
  if (mode === 'live') return { priceId: PACKAGES[packageKey].livePriceId };
  if (mode === 'test') return isPriceId(testPrices[packageKey]) ? { priceId: testPrices[packageKey] } : { error: 'test_price_missing' };
  return { error: 'not_configured' };
}

// TO-XXXX-XXXX: random, never the row number (A17), from the intake id
// alphabet (intakeLogic.js) so it reads aloud without 0/O/1/I/L/U mix-ups.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newOrderId(rand = randomInt) {
  const pick = () => ID_ALPHABET[rand(ID_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `TO-${block()}-${block()}`;
}
