// Tournament checkout — pure rules: the refusal messages parents see, the
// length caps, which Stripe Price a key may charge, and order ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGES, PACKAGE_KEYS, TOURNAMENTS, validateCheckout, validateDetails, keyMode, choosePrice, isTeamPackage, TEAM_DETAIL_FIELDS, detailFieldsFor,
  parseTestPrices, priceSettings, priceProblem, missingPriceProblem, LIVE_PRICE_VARIABLES,
  newOrderId, packageLabel, tournamentLabel,
} from './tournamentOrderLogic.js';

const VALID = {
  guardianName: 'Jordan Example', playerName: 'Sky Example', email: 'jordan@example.com',
  phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageId: 'tournament_pro',
};
const long = n => 'x'.repeat(n);

test('a valid checkout keeps only the seven fields the page sends, trimmed', () => {
  const r = validateCheckout({ ...VALID, guardianName: '  Jordan Example ', amount: 100, priceId: 'price_not_ours', price: 1 });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, {
    guardianName: 'Jordan Example', playerName: 'Sky Example', teamName: '', email: 'jordan@example.com',
    phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageKey: 'tournament_pro', kind: 'player',
  });
  assert.equal(validateCheckout({ ...VALID, teamName: ' Hawks 14U ' }).value.teamName, 'Hawks 14U', 'a player order may name the team');
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

test('a team package needs the team name, not a player; the contact may be the coach', () => {
  const TEAM = { ...VALID, packageId: 'team_tournament_advanced', playerName: '', teamName: ' Huskers 12U ' };
  assert.deepEqual(validateCheckout(TEAM).value, {
    guardianName: 'Jordan Example', playerName: '', teamName: 'Huskers 12U', email: 'jordan@example.com',
    phone: '555-0100', tournamentId: 'better-baseball-nephi-2026', packageKey: 'team_tournament_advanced', kind: 'team',
  });
  assert.equal(validateCheckout({ ...TEAM, playerName: 'Sky Example' }).value.playerName, 'Sky Example', 'a player may still be named');
  assert.deepEqual(validateCheckout({ ...TEAM, teamName: '  ' }), { error: 'Enter the team name for this team purchase.' });
  assert.deepEqual(validateCheckout({ ...TEAM, guardianName: '' }), { error: 'Enter the parent, guardian, or team contact name.' });
  assert.deepEqual(validateCheckout({ ...TEAM, teamName: long(201) }), { error: 'Shorten the team name to 200 characters or fewer.' });
  assert.deepEqual(validateCheckout({ ...VALID, playerName: '', teamName: 'Huskers 12U' }), { error: 'Enter the player name.' }, 'a player package still needs the player');
  assert.deepEqual(PACKAGE_KEYS.filter(isTeamPackage), ['team_single_basic', 'team_single_advanced', 'team_tournament_basic', 'team_tournament_advanced']);
  assert.equal(isTeamPackage('constructor'), false);
});

test('a team order’s details step asks about the team, never a player', () => {
  assert.equal(detailFieldsFor({ order_kind: 'team' }), TEAM_DETAIL_FIELDS);
  assert.notEqual(detailFieldsFor({ order_kind: 'player' }), TEAM_DETAIL_FIELDS);
  assert.notEqual(detailFieldsFor(null), TEAM_DETAIL_FIELDS);
  assert.deepEqual(validateDetails({ division: ' 12U ', jerseyNumber: '7' }, TEAM_DETAIL_FIELDS).value, { division: '12U', headCoach: '', gameContext: '', notes: '' });
  assert.deepEqual(validateDetails({}, TEAM_DETAIL_FIELDS), { error: 'Enter the division or age group.' });
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

const TEST_MAP = JSON.stringify({
  individual_basic: 'price_TestA', individual_pro: 'price_TestB', tournament_basic: 'price_TestC', tournament_pro: 'price_TestD',
  team_single_basic: 'price_TestE', team_single_advanced: 'price_TestF', team_tournament_basic: 'price_TestG', team_tournament_advanced: 'price_TestH',
});
const LIVE_ENV = {
  STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC: 'price_LiveA', STRIPE_LIVE_PRICE_INDIVIDUAL_PRO: 'price_LiveB',
  STRIPE_LIVE_PRICE_TOURNAMENT_BASIC: 'price_LiveC', STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_LiveD',
  STRIPE_LIVE_PRICE_TEAM_SINGLE_BASIC: 'price_LiveE', STRIPE_LIVE_PRICE_TEAM_SINGLE_ADVANCED: 'price_LiveF',
  STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_BASIC: 'price_LiveG', STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_ADVANCED: 'price_LiveH',
};

test('production’s eight live Prices are one named setting each', () => {
  assert.deepEqual(LIVE_PRICE_VARIABLES, {
    individual_basic: 'STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC', individual_pro: 'STRIPE_LIVE_PRICE_INDIVIDUAL_PRO',
    tournament_basic: 'STRIPE_LIVE_PRICE_TOURNAMENT_BASIC', tournament_pro: 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO',
    team_single_basic: 'STRIPE_LIVE_PRICE_TEAM_SINGLE_BASIC', team_single_advanced: 'STRIPE_LIVE_PRICE_TEAM_SINGLE_ADVANCED',
    team_tournament_basic: 'STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_BASIC', team_tournament_advanced: 'STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_ADVANCED',
  });
  for (const [key, pkg] of Object.entries(PACKAGES)) assert.ok(Object.keys(pkg).every(k => ['amount', 'label', 'team'].includes(k)), `${key}: no Price in code`);
});

test('the key decides the mode: a live key reads only the live settings, a test key only the test map', () => {
  const live = priceSettings({ STRIPE_SECRET_KEY: 'sk_live_x', ...LIVE_ENV });
  assert.deepEqual(live, {
    mode: 'live', source: 'STRIPE_LIVE_PRICE_*', mismatch: '', missing: [], problems: {},
    prices: {
      individual_basic: 'price_LiveA', individual_pro: 'price_LiveB', tournament_basic: 'price_LiveC', tournament_pro: 'price_LiveD',
      team_single_basic: 'price_LiveE', team_single_advanced: 'price_LiveF', team_tournament_basic: 'price_LiveG', team_tournament_advanced: 'price_LiveH',
    },
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
    + 'Remove STRIPE_TEST_PRICES; live Prices come from the STRIPE_LIVE_PRICE_* settings.');
  assert.deepEqual(liveWithTest.prices, {}, 'nothing is charged, not even the live settings beside it');
  const testWithLive = priceSettings({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEST_PRICES: TEST_MAP, STRIPE_LIVE_PRICE_TOURNAMENT_PRO: 'price_LiveD' });
  assert.equal(testWithLive.mismatch, 'STRIPE_SECRET_KEY is a test key, but STRIPE_LIVE_PRICE_TOURNAMENT_PRO is set: a test key never charges live Prices. '
    + 'Remove it; test Prices come from STRIPE_TEST_PRICES.');
  assert.deepEqual(testWithLive.prices, {});
  const testWithAllLive = priceSettings({ STRIPE_SECRET_KEY: 'rk_test_x', ...LIVE_ENV });
  assert.match(testWithAllLive.mismatch, /^STRIPE_SECRET_KEY is a test key, but STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC, STRIPE_LIVE_PRICE_INDIVIDUAL_PRO, STRIPE_LIVE_PRICE_TOURNAMENT_BASIC, STRIPE_LIVE_PRICE_TOURNAMENT_PRO, STRIPE_LIVE_PRICE_TEAM_SINGLE_BASIC, .*STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_ADVANCED are set: .* Remove them;/);
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
  assert.deepEqual(settings.missing, ['individual_pro', 'tournament_basic', 'tournament_pro', 'team_single_basic', 'team_single_advanced', 'team_tournament_basic', 'team_tournament_advanced']);
  assert.deepEqual(settings.problems, {
    individual_pro: 'STRIPE_LIVE_PRICE_INDIVIDUAL_PRO holds a product ID (prod_…), not the product\'s Price ID (price_…)',
    tournament_basic: 'STRIPE_LIVE_PRICE_TOURNAMENT_BASIC is not a Price ID (price_…)',
    tournament_pro: 'STRIPE_LIVE_PRICE_TOURNAMENT_PRO is not set',
    team_single_basic: 'STRIPE_LIVE_PRICE_TEAM_SINGLE_BASIC is not set',
    team_single_advanced: 'STRIPE_LIVE_PRICE_TEAM_SINGLE_ADVANCED is not set',
    team_tournament_basic: 'STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_BASIC is not set',
    team_tournament_advanced: 'STRIPE_LIVE_PRICE_TEAM_TOURNAMENT_ADVANCED is not set',
  });
  assert.deepEqual(choosePrice('individual_basic', settings), { priceId: 'price_LiveA' });
  assert.deepEqual(choosePrice('tournament_pro', settings), { error: 'price_missing' });
  assert.ok(!JSON.stringify(settings.problems).includes('prod_SomeProduct'), 'never echoed');
});

test('the test price map is parsed as before, without ever echoing a value', () => {
  const full = JSON.parse(TEST_MAP);
  assert.deepEqual(parseTestPrices(TEST_MAP), { prices: full, missing: [], problem: '', problems: {} });
  assert.equal(parseTestPrices('').problem, 'STRIPE_TEST_PRICES is not set');
  assert.equal(parseTestPrices('{not json').problem, 'STRIPE_TEST_PRICES is not a JSON object');
  assert.equal(parseTestPrices('["price_A1"]').problems.tournament_pro, 'STRIPE_TEST_PRICES is not a JSON object');
  const partial = parseTestPrices(JSON.stringify({ individual_basic: 'price_A1', tournament_pro: 'prod_SECRETISH' }));
  assert.deepEqual(partial.missing, ['individual_pro', 'tournament_basic', 'tournament_pro', 'team_single_basic', 'team_single_advanced', 'team_tournament_basic', 'team_tournament_advanced']);
  assert.equal(partial.problem, 'STRIPE_TEST_PRICES has no price_ id for individual_pro, tournament_basic, tournament_pro, team_single_basic, team_single_advanced, team_tournament_basic, team_tournament_advanced');
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
  assert.equal(packageLabel('tournament_pro'), 'Individual Player Advanced — Whole Tournament');
  assert.equal(packageLabel('individual_basic'), 'Individual Player Basic — Single Game');
  assert.equal(packageLabel('team_tournament_advanced'), 'Team Advanced — Whole Tournament');
  assert.equal(tournamentLabel('better-baseball-nephi-2026'), 'Better Baseball Field of Screams — Nephi, Utah · October 9–10, 2026');
  assert.deepEqual(Object.keys(TOURNAMENTS), ['better-baseball-nephi-2026']);
  assert.deepEqual(Object.values(PACKAGES).map(p => p.amount), [5000, 7500, 12500, 15000, 15000, 30000, 45000, 90000], 'Will’s cards: $50 $75 $125 $150, teams $150 $300 $450 $900');
});
