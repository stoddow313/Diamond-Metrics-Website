// Tournament checkout — pure rules: the refusal messages parents see, the
// length caps, which Stripe Price a key may charge, and order ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGES, PACKAGE_KEYS, TOURNAMENTS, validateCheckout, validateDetails, keyMode, choosePrice,
  parseTestPrices, newOrderId, packageLabel, tournamentLabel,
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

test('a live key charges only the handoff’s live prices; a test key only the test map', () => {
  const testPrices = { individual_basic: 'price_TestA', individual_pro: 'price_TestB', tournament_basic: 'price_TestC', tournament_pro: 'price_TestD' };
  const live = {
    individual_basic: 'price_1UNGeTQkGlcnNPo07CCI0CCK', individual_pro: 'price_1UNGepQkGlcnNPo05FmG7Olz',
    tournament_basic: 'price_1UNGfFQkGlcnNPo0PCeTqYNO', tournament_pro: 'price_1UNGfZQkGlcnNPo0i8SqGcm7',
  };
  for (const key of PACKAGE_KEYS) {
    assert.deepEqual(choosePrice(key, { mode: 'live', testPrices }), { priceId: live[key] }, `${key}: the test map is ignored with a live key`);
    assert.deepEqual(choosePrice(key, { mode: 'test', testPrices }), { priceId: testPrices[key] }, `${key}: never a live price with a test key`);
  }
  assert.deepEqual(choosePrice('tournament_pro', { mode: 'test', testPrices: { individual_basic: 'price_TestA' } }), { error: 'test_price_missing' });
  assert.deepEqual(choosePrice('tournament_pro', { mode: 'test', testPrices: { tournament_pro: 'prod_NotAPrice' } }), { error: 'test_price_missing' });
  assert.deepEqual(choosePrice('tournament_pro', { mode: null, testPrices }), { error: 'not_configured' });
  assert.deepEqual(choosePrice('tournament_pro', {}), { error: 'not_configured' });
  assert.deepEqual(choosePrice('gold', { mode: 'live' }), { error: 'unknown_package' });
});

test('the test price map is parsed without ever echoing a value', () => {
  const full = JSON.stringify({ individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' });
  assert.deepEqual(parseTestPrices(full), {
    prices: { individual_basic: 'price_A1', individual_pro: 'price_B2', tournament_basic: 'price_C3', tournament_pro: 'price_D4' },
    missing: [], problem: '',
  });
  assert.equal(parseTestPrices('').problem, 'STRIPE_TEST_PRICES is not set');
  assert.equal(parseTestPrices('{not json').problem, 'STRIPE_TEST_PRICES is not a JSON object');
  assert.equal(parseTestPrices('["price_A1"]').problem, 'STRIPE_TEST_PRICES is not a JSON object');
  const partial = parseTestPrices(JSON.stringify({ individual_basic: 'price_A1', tournament_pro: 'prod_SECRETISH' }));
  assert.deepEqual(partial.missing, ['individual_pro', 'tournament_basic', 'tournament_pro']);
  assert.equal(partial.problem, 'STRIPE_TEST_PRICES has no price_ id for individual_pro, tournament_basic, tournament_pro');
  assert.ok(!partial.problem.includes('prod_SECRETISH') && !partial.problem.includes('price_A1'));
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
