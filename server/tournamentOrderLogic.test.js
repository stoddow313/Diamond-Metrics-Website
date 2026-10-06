// Tournament checkout — pure rules: the refusal messages parents see, the
// length caps, which Stripe Price a key may charge, and order ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGES, PACKAGE_KEYS, TOURNAMENTS, validateCheckout, validateDetails, keyMode, choosePrice,
  parseTestPrices, priceSettings, priceProblem, missingPriceProblem, LIVE_PRICE_VARIABLES,
  newOrderId, packageLabel, tournamentLabel,
} from './tournamentOrderLogic.js';

const VALID = {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com',
  phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
};
const long = n => 'x'.repeat(n);

test('a valid checkout keeps only the six fields the page sends, trimmed', () => {
  const r = validateCheckout({ ...VALID, guardianName: '  Jordan Example ', amount: 100, priceId: 'price_not_ours', price: 1 });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {
    guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com',
    phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageKey: 'tournament_pro',
  });
  assert.equal(validateCheckout({ ...VALID, phone: '' }).value.phone, '', 'phone is optional');
  assert.equal(validateCheckout({ ...VALID, phone: undefined }).value.phone, '');
});

test('checkout refusals use the page’s own wording, in the order the parent filled the form', () => {
  const cases = [
    [{ guardianName: '   ' }, 'Enter the parent or guardian name.'],
    [{ playerName: '' }, 'Enter the player name.'],
    [{ email: '' }, 'Enter an email address.'],
    [{ email: 'casey@example' }, 'Enter a valid email address.'],
    [{ email: 'casey example@example.com' }, 'Enter a valid email address.'],
    [{ tournamentId: 'some-other-event' }, 'Choose the tournament attended.'],
    [{ tournamentId: '' }, 'Choose the tournament attended.'],
    [{ packageId: 'tournament_platinum' }, 'Choose a package.'],
    [{ packageId: '__proto__' }, 'Choose a package.'],
    [{ packageId: 'constructor' }, 'Choose a package.'],
    [{ packageId: { individual_basic: true } }, 'Choose a package.'],
    [{ guardianName: { name: 'x' } }, 'Enter the parent or guardian name.'],
    [{ guardianName: '', packageId: 'nope' }, 'Enter the parent or guardian name.'],
  ];
  for (const [patch, message] of cases) {
    assert.deepEqual(validateCheckout({ ...VALID, ...patch }), { error: message }, JSON.stringify(patch));
  }
  assert.deepEqual(validateCheckout(undefined), { error: 'Enter the parent or guardian name.' });
});

test('checkout text fields are capped at 200 characters', () => {
  assert.equal(validateCheckout({ ...VALID, guardianName: long(200) }).error, undefined, '200 is allowed');
  assert.deepEqual(validateCheckout({ ...VALID, guardianName: long(201) }), { error: 'Shorten the parent or guardian name to 200 characters or fewer.' });
  assert.deepEqual(validateCheckout({ ...VALID, playerName: long(201) }), { error: 'Shorten the player name to 200 characters or fewer.' });
  assert.deepEqual(validateCheckout({ ...VALID, email: `${long(190)}@example.com` }), { error: 'Shorten the email to 200 characters or fewer.' });
  assert.deepEqual(validateCheckout({ ...VALID, phone: long(201) }), { error: 'Shorten the phone number to 200 characters or fewer.' });
});

test('details: three required fields, three optional, the note capped at 1,000', () => {
  const ok = validateDetails({ teamClub: ' Example Hawks 14U ', jerseyNumber: 12, primaryPosition: 'Shortstop', batsThrows: 'R/R' });
  assert.deepEqual(ok.value, {
    teamClub: 'Example Hawks 14U', jerseyNumber: '12', primaryPosition: 'Shortstop', batsThrows: 'R/R', gameContext: '', notes: '',
  });
  const base = { teamClub: 'Hawks', jerseyNumber: '7', primaryPosition: 'Catcher' };
  assert.deepEqual(validateDetails({ ...base, teamClub: ' ' }), { error: 'Enter the team or club.' });
  assert.deepEqual(validateDetails({ ...base, jerseyNumber: '' }), { error: 'Enter the jersey number.' });
  assert.deepEqual(validateDetails({ ...base, primaryPosition: undefined }), { error: 'Enter the primary position.' });
  assert.deepEqual(validateDetails({}), { error: 'Enter the team or club.' });
  assert.deepEqual(validateDetails({ ...base, teamClub: long(201) }), { error: 'Shorten the team or club to 200 characters or fewer.' });
  assert.deepEqual(validateDetails({ ...base, jerseyNumber: long(201) }), { error: 'Shorten the jersey number to 200 characters or fewer.' });
  assert.deepEqual(validateDetails({ ...base, primaryPosition: long(201) }), { error: 'Shorten the primary position to 200 characters or fewer.' });
  assert.deepEqual(validateDetails({ ...base, batsThrows: long(201) }), { error: 'Shorten bats / throws to 200 characters or fewer.' });
  assert.deepEqual(validateDetails({ ...base, gameContext: long(201) }), { error: 'Shorten the game date or opponent to 200 characters or fewer.' });
  assert.equal(validateDetails({ ...base, notes: long(1000) }).error, undefined);
  assert.deepEqual(validateDetails({ ...base, notes: long(1001) }), { error: 'Shorten the note to 1,000 characters or fewer.' });
});

test('the key mode comes from the key prefix only', () => {
  assert.equal(keyMode('sk_live_abc'), 'live');
  assert.equal(keyMode('rk_live_abc'), 'live');
  assert.equal(keyMode('sk_test_abc'), 'test');
  assert.equal(keyMode('rk_test_abc'), 'test');
  for (const k of ['', undefined, null, 'pk_test_abc', 'sk_test', 'whsec_abc', 'live_sk_abc']) assert.equal(keyMode(k), null, String(k));
});

const TEST_MAP = JSON.stringify({ individual_basic: 'price_TestA', individual_pro: 'price_TestB', tournament_basic: 'price_TestC', tournament_pro: 'price_TestD' });
const LIVE_ENV = {
  STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: 'price_LiveA', STRIPE_LIVE_PRICE_INDIVIDUAL_PRO: 'price_LiveB',
  STRIPE_LIVE_PRICE_TOURNAMENT_BASIC: 'price_LiveC', STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_LiveD',
};

test('production’s four live Prices are one named setting each', () => {
  assert.deepEqual(LIVE_PRICE_VARIABLES, {
    individual_basic: 'STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC', individual_pro: 'STRIPE_LIVE_PRICE_INDIVIDUAL_PRO',
    tournament_basic: 'STRIPE_LIVE_PRICE_TOURNAMENT_BASIC', tournament_pro: 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO',
  });
  for (const [key, pkg] of Object.entries(PACKAGES)) assert.deepEqual(Object.keys(pkg).sort(), ['amount', 'label'], `${key}: no Price in code`);
});

test('the key decides the mode: a live key reads only the live settings, a test key only the test map', () => {
  const live = priceSettings({ STRIPE_SECRET_KEY: 'sk_live_x', ...LIVE_ENV });
  assert.deepEqual(live, {
    mode: 'live', source: 'STRIPE_LIVE_PRICE_*', mismatch: '', missing: [], problems: {},
    prices: { individual_basic: 'price_LiveA', individual_pro: 'price_LiveB', tournament_basic: 'price_LiveC', tournament_pro: 'price_LiveD' },
  });
  assert.deepEqual(priceSettings({ STRIPE_SECRET_KEY: 'rk_live_x', ...LIVE_ENV }).prices, live.prices, 'a restricted live key too');
  const test_ = priceSettings({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_PRICES: TEST_MAP });
  assert.equal(test_.mode, 'test');
  assert.equal(test_.source, 'STRIPE_TEST_PRICES');
  assert.equal(test_.prices.tournament_pro, 'price_TestD');
  for (const key of PACKAGE_KEYS) {
    assert.deepEqual(choosePrice(key, live), { priceId: live.prices[key] });
    assert.deepEqual(choosePrice(key, test_), { priceId: test_.prices[key] });
  }
  assert.deepEqual(priceSettings({ ...LIVE_ENV, STRIPE_TEST_PRICES: TEST_MAP }), {
    mode: null, source: null, prices: {}, missing: [], problems: {}, mismatch: '',
  }, 'no key: nothing is read');
  assert.deepEqual(choosePrice('tournament_pro', priceSettings({ STRIPE_SECRET_KEY: 'pk_live_x', ...LIVE_ENV })), { error: 'not_configured' }, 'a publishable key is not a secret key');
  assert.deepEqual(choosePrice('gold', live), { error: 'unknown_package' });
  assert.deepEqual(choosePrice('constructor', live), { error: 'unknown_package' });
});

test('a live key with test Prices, or a test key with live Prices, is a mismatch that names both', () => {
  const liveWithTest = priceSettings({ STRIPE_SECRET_KEY: 'sk_live_x', ...LIVE_ENV, STRIPE_TEST_PRICES: TEST_MAP });
  assert.equal(liveWithTest.mismatch, 'STRIPE_SECRET_KEY is a live key, but STRIPE_TEST_PRICES is set: a live key never charges test Prices. '
    + 'Remove STRIPE_TEST_PRICES; live Prices come from the four STRIPE_LIVE_PRICE_* settings.');
  assert.deepEqual(liveWithTest.prices, {}, 'nothing is charged, not even the live settings beside it');
  const testWithLive = priceSettings({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_PRICES: TEST_MAP, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_LiveD' });
  assert.equal(testWithLive.mismatch, 'STRIPE_SECRET_KEY is a test key, but STRIPE_LIVE_PRICE_TOURNAMENT_PRO is set: a test key never charges live Prices. '
    + 'Remove it; test Prices come from STRIPE_TEST_PRICES.');
  assert.deepEqual(testWithLive.prices, {});
  const testWithAllLive = priceSettings({ STRIPE_SECRET_KEY: 'rk_test_x', ...LIVE_ENV });
  assert.match(testWithAllLive.mismatch, /^STRIPE_SECRET_KEY is a test key, but STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC, STRIPE_LIVE_PRICE_INDIVIDUAL_PRO, STRIPE_LIVE_PRICE_TOURNAMENT_BASIC, STRIPE_LIVE_PRICE_TOURNAMENT_PRO are set: .* Remove them;/);
  for (const settings of [liveWithTest, testWithLive, testWithAllLive]) {
    for (const key of PACKAGE_KEYS) assert.deepEqual(choosePrice(key, settings), { error: 'mismatch' }, `${key} refused`);
    assert.ok(!/price_(Live|Test)/.test(settings.mismatch), 'the mismatch names settings, never values');
  }
  assert.equal(priceSettings({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_PRICES: TEST_MAP, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: '  ' }).mismatch, '', 'a blank setting is not set');
});

test('a live setting that is missing, a product ID or not a Price ID refuses its package by name', () => {
  const settings = priceSettings({
    STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: ' price_LiveA\n',
    STRIPE_LIVE_PRICE_INDIVIDUAL_PRO: 'prod_SomeProduct', STRIPE_LIVE_PRICE_TOURNAMENT_BASIC: 'Tournament Basic',
  });
  assert.deepEqual(settings.prices, { individual_basic: 'price_LiveA' }, 'pasted spaces are trimmed');
  assert.deepEqual(settings.missing, ['individual_pro', 'tournament_basic', 'tournament_pro']);
  assert.deepEqual(settings.problems, {
    individual_pro: 'STRIPE_LIVE_PRICE_INDIVIDUAL_PRO holds a product ID (prod_…), not the product\'s Price ID (price_…)',
    tournament_basic: 'STRIPE_LIVE_PRICE_TOURNAMENT_BASIC is not a Price ID (price_…)',
    tournament_pro: 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO is not set',
  });
  assert.deepEqual(choosePrice('individual_basic', settings), { priceId: 'price_LiveA' });
  assert.deepEqual(choosePrice('tournament_pro', settings), { error: 'price_missing' });
  assert.ok(!JSON.stringify(settings.problems).includes('prod_SomeProduct'), 'never echoed');
});

test('the test price map is parsed as before, without ever echoing a value', () => {
  const full = JSON.stringify({ individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' });
  assert.deepEqual(parseTestPrices(full), {
    prices: { individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' },
    missing: [], problem: '', problems: {},
  });
  assert.equal(parseTestPrices('').problem, 'STRIPE_TEST_PRICES is not set');
  assert.equal(parseTestPrices('{not json').problem, 'STRIPE_TEST_PRICES is not a JSON object');
  assert.equal(parseTestPrices('["price_A1"]').problems.tournament_pro, 'STRIPE_TEST_PRICES is not a JSON object');
  const partial = parseTestPrices(JSON.stringify({ individual_basic: 'price_A1', tournament_pro: 'prod_SECRETISH' }));
  assert.deepEqual(partial.missing, ['individual_pro', 'tournament_basic', 'tournament_pro']);
  assert.equal(partial.problem, 'STRIPE_TEST_PRICES has no price_ id for individual_pro, tournament_basic, tournament_pro');
  assert.equal(partial.problems.tournament_pro, 'STRIPE_TEST_PRICES has no price_ id for tournament_pro');
  assert.ok(!JSON.stringify(partial).includes('prod_SECRETISH'));
});

test('Stripe’s answer for a Price of the other mode is named as a mode mismatch', () => {
  assert.equal(missingPriceProblem("No such price: 'price_X'; a similar object exists in test mode, but a live mode key was used to make this request.", 'live'),
    'is a test-mode Price, but STRIPE_SECRET_KEY is a live key');
  assert.equal(missingPriceProblem("No such price: 'price_X'; a similar object exists in live mode, but a test mode key was used to make this request.", 'test'),
    'is a live-mode Price, but STRIPE_SECRET_KEY is a test key');
  assert.equal(missingPriceProblem("No such price: 'price_X'", 'live'), 'was not found in Stripe with this live key');
  assert.equal(missingPriceProblem(undefined, 'test'), 'was not found in Stripe with this test key');
});

test('a Price is fit to charge only when it is the card’s amount, once, in US dollars', () => {
  const price = { id: 'price_LiveD', object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: 15000 };
  assert.equal(priceProblem('tournament_pro', price), '');
  assert.equal(priceProblem('tournament_basic', price), 'charges $150.00, not the card’s $125.00', 'a swapped Price');
  assert.equal(priceProblem('tournament_pro', { ...price, unit_amount: 14999 }), 'charges $149.99, not the card’s $150.00');
  assert.equal(priceProblem('tournament_pro', { ...price, unit_amount: null }), 'charges no fixed amount, not the card’s $150.00');
  assert.equal(priceProblem('tournament_pro', { ...price, currency: 'cad' }), 'is in CAD, not USD');
  assert.equal(priceProblem('tournament_pro', { ...price, type: 'recurring' }), 'is a recurring Price, not a one-time one');
  assert.equal(priceProblem('tournament_pro', { ...price, active: false }), 'is archived in Stripe');
  assert.equal(priceProblem('tournament_pro', null), 'was not found in Stripe');
  for (const key of PACKAGE_KEYS) {
    assert.ok(!priceProblem(key, { ...price, unit_amount: 1 }).includes('price_LiveD'), 'the problem never names the Price');
  }
});

test('order ids are random, readable aloud and never a row number', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newOrderId();
    assert.match(id, /^TO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 500, 'no repeats in 500 draws');
  assert.ok(![...seen].some(id => /^TO-0*\d{1,3}$/.test(id)));
});

test('labels come from the server catalog', () => {
  assert.equal(packageLabel('tournament_pro'), 'Single Tournament — Pro');
  assert.equal(packageLabel('individual_basic'), 'Individual Game — Basic');
  assert.equal(tournamentLabel('better-baseball-nephi-2026'), 'Better Baseball — Nephi, Utah · October 9–10, 2026');
  assert.deepEqual(Object.keys(TOURNAMENTS), ['better-baseball-nephi-2026']);
  assert.deepEqual(Object.values(PACKAGES).map(p => p.amount), [5000, 7500, 12500, 15000]);
});
