// Event registration end to end (docs/COMMAND_OPS.md §3.23): an event set up
// in Command, its public page and form, the Stripe Checkout our server starts
// for each registration, the signed webhook that marks it paid (once), the
// live desk — check-in, walk-ups, booth payment — and booth logins.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-event-reg-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-event-reg-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const SECRET = 'whsec_test_event_registration_secret';
const { startIntakeApp } = await import('./intakeTestHarness.js');
const { setStripeClientForTests, stripeWebhooks } = await import('./stripeConfig.js');
const { consentVersion, DEFAULT_CONSENT, rosterCsv } = await import('./eventLogic.js');

let h, db, fulfil, analyst;
const sessions = [];
let n = 0;
let lastSession = '';
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  setStripeClientForTests({ checkout: { sessions: { create: async params => { sessions.push(params); n += 1; lastSession = `cs_test_ev${n}`; return { id: lastSession, url: `https://checkout.stripe.test/c/${n}` }; } } } });
  fulfil = h.internal('fulfillment', 'Will S');
  analyst = h.internal('analyst');
});
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});
after(async () => {
  setStripeClientForTests(null);
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const DAYS = [{ date: '2099-11-06' }, { date: '2099-11-07' }];
async function newEvent(fields = {}) {
  const r = await h.call('POST', '/api/command/events', { token: fulfil.token, body: { name: `Gobbler Pro Day ${++n}`, days: DAYS, price_cents: 7500, ...fields } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.event;
}
const put = (id, body, token = fulfil.token) => h.call('PUT', `/api/command/events/${id}`, { token, body });
const form = (over = {}) => ({ guardianName: 'Pat Parent', email: 'pat@example.com', phone: '', playerName: 'Kai Player', playerAge: '13', playerTeam: 'Huskers 14U', preferredDay: '2099-11-06', consent: true, ...over });
const register = (slug, body) => h.call('POST', `/api/public/events/${slug}/register`, { body });
function completed(sessionId, registrationId, { eventId = `evt_ev${++n}`, paymentStatus = 'paid', amountTotal = 7500 } = {}) {
  return { id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: sessionId, object: 'checkout.session', client_reference_id: registrationId, payment_status: paymentStatus, payment_intent: `pi_ev${n}`, amount_total: amountTotal, currency: 'usd', mode: 'payment' } } };
}
async function deliver(event) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${h.base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeWebhooks.generateTestHeaderString({ payload, secret: SECRET }) }, body: payload });
  return { status: res.status, body: await res.json() };
}
const reg = rid => db.prepare('SELECT * FROM event_registrations WHERE registration_id = ?').get(rid);
async function paidRegistration(event, over = {}) {
  const r = await register(event.slug, form(over));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await deliver(completed(lastSession, r.body.registrationId));
  return r.body.registrationId;
}

test('an event is set up in Command, previewed as a draft, then opened and listed', async () => {
  assert.equal((await h.call('POST', '/api/command/events', { token: analyst.token, body: { name: 'X', days: DAYS, price_cents: 7500 } })).status, 403, 'analysts don’t set up events');
  const ev = await newEvent();
  assert.equal(ev.status, 'draft');
  assert.equal(ev.consent_text, DEFAULT_CONSENT);
  assert.equal(ev.consent_version, consentVersion(DEFAULT_CONSENT));
  assert.match(ev.slug, /^gobbler-pro-day-\d+$/);
  assert.equal((await h.call('GET', `/api/public/events/${ev.slug}`)).status, 404, 'a draft is not public');
  const preview = await h.call('GET', `/api/public/events/${ev.slug}`, { token: analyst.token });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.event.preview, true);
  assert.equal((await register(ev.slug, form())).status, 404, 'nor does it take registrations');

  assert.equal((await put(ev.id, { status: 'open', listed: true })).status, 200);
  const pub = await h.call('GET', `/api/public/events/${ev.slug}`);
  assert.deepEqual([pub.body.event.accepting, pub.body.event.either, pub.body.event.days.length, pub.body.event.price_cents], [true, true, 2, 7500]);
  assert.ok((await h.call('GET', '/api/public/events')).body.events.some(e => e.slug === ev.slug));
  assert.equal((await put(ev.id, { listed: false })).status, 200);
  assert.ok(!(await h.call('GET', '/api/public/events')).body.events.some(e => e.slug === ev.slug), 'unlisted: link only');
});

test('a parent registers and pays; only the signed webhook marks it paid, once', async () => {
  const ev = await newEvent();
  await put(ev.id, { status: 'open' });
  for (const [over, message] of [
    [{ playerAge: '' }, /age/], [{ email: 'nope' }, /valid email/], [{ consent: false }, /consent/], [{ preferredDay: '2099-12-25' }, /Choose a day/], [{ playerTeam: '' }, /team/],
  ]) assert.match((await register(ev.slug, form(over))).body.error, message);

  const r = await register(ev.slug, form({ price_cents: 1, source: 'Flyer!' }));
  assert.equal(r.status, 200);
  assert.match(r.body.registrationId, /^ER-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const params = sessions.at(-1);
  assert.equal(params.line_items[0].price_data.unit_amount, 7500, 'the event’s price, never the browser’s');
  assert.equal(params.client_reference_id, r.body.registrationId);
  assert.ok(!JSON.stringify(params).includes('Kai Player'), 'Stripe gets ids and the email, no player name');
  assert.match(params.success_url, new RegExp(`/events/${ev.slug}/registered\\?session_id=\\{CHECKOUT_SESSION_ID\\}$`));
  const row = reg(r.body.registrationId);
  assert.deepEqual([row.status, row.source, row.player_age, row.preferred_day, row.consent_version], ['pending', 'flyer', 13, '2099-11-06', ev.consent_version]);

  const sessionId = lastSession;
  assert.equal((await deliver(completed('cs_test_somebody_else', r.body.registrationId))).status, 200);
  assert.equal(reg(r.body.registrationId).status, 'pending', 'a session we did not start for it changes nothing');
  const evt = completed(sessionId, r.body.registrationId);
  await deliver(evt);
  await deliver(evt);
  const paid = reg(r.body.registrationId);
  assert.deepEqual([paid.status, paid.payment_method, paid.amount_total], ['paid', 'stripe', 7500]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM event_registration_history WHERE registration_id = ? AND event_type = 'paid'").get(paid.id).c, 1, 'a redelivery adds nothing');
  const conf = await h.call('GET', `/api/public/event-registrations/session/${sessionId}`);
  assert.deepEqual([conf.body.registration.paid, conf.body.registration.player_first_name, conf.body.registration.day_label], [true, 'Kai', 'Fri, Nov 6']);
});

test('a day with a limit fills up; "Either day" stays while one has room; a full event says so', async () => {
  const ev = await newEvent({ days: [{ date: '2099-11-06', capacity: 1 }, { date: '2099-11-07', capacity: 1 }] });
  await put(ev.id, { status: 'open' });
  await paidRegistration(ev, { preferredDay: '2099-11-06' });
  assert.match((await register(ev.slug, form({ preferredDay: '2099-11-06' }))).body.error, /is full — choose another day/);
  assert.equal((await register(ev.slug, form({ preferredDay: 'either' }))).status, 200, 'either, while Nov 7 has room');
  await paidRegistration(ev, { preferredDay: '2099-11-07' });
  const full = await register(ev.slug, form({ preferredDay: '2099-11-07' }));
  assert.deepEqual([full.status, full.body.error], [409, 'This event is full.']);
  assert.equal((await h.call('GET', `/api/public/events/${ev.slug}`)).body.event.reason, 'full');
});

test('the desk: anyone internal can look; check-in, walk-ups and booth payment need admin, fulfillment or a booth login', async () => {
  const ev = await newEvent();
  await put(ev.id, { status: 'open' });
  const rid = await paidRegistration(ev);
  const pending = (await register(ev.slug, form({ playerName: 'Uma Unpaid' }))).body.registrationId;

  // A checkout that never started (Stripe down) leaves a registration the desk doesn't show.
  db.prepare("INSERT INTO event_registrations (registration_id, event_id, guardian_name, email, player_name, preferred_day) VALUES ('ER-2222-2222', ?, 'G', 'g@example.com', 'Never Started', '2099-11-06')").run(ev.id);
  const look = await h.call('GET', `/api/desk/events/${ev.id}`, { token: analyst.token });
  assert.ok(!look.body.registrations.some(r => r.registration_id === 'ER-2222-2222'));
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.counts.registered, look.body.counts.paid, look.body.actor.can_act], [2, 1, false]);
  assert.equal((await h.call('PUT', `/api/desk/registrations/${rid}/check-in`, { token: analyst.token, body: { checked_in: true } })).status, 403);
  assert.equal((await h.call('PUT', `/api/desk/registrations/${pending}/check-in`, { token: fulfil.token, body: { checked_in: true } })).status, 409, 'payment first');
  const ci = await h.call('PUT', `/api/desk/registrations/${rid}/check-in`, { token: fulfil.token, body: { checked_in: true } });
  assert.deepEqual([ci.status, ci.body.counts.checked_in, ci.body.registration.checked_in_by_name], [200, 1, 'Will S']);

  // Booth login: granted the event, claims the invite, sees only that event.
  const grant = await h.call('POST', `/api/command/events/${ev.id}/access`, { token: fulfil.token, body: { email: 'booth@example.com' } });
  assert.equal(grant.status, 201);
  assert.match(grant.body.invite_token, /^[0-9a-f]{32}$/, 'a new email gets an invite link to claim');
  // The claim page lives in index.js; here the claimed account is made directly.
  const staffId = db.prepare("INSERT INTO staff_users (email, name, password_hash) VALUES ('booth@example.com', 'Booth Helper', 'x')").run().lastInsertRowid;
  const booth = h.principals.createStaffSession(staffId);
  const other = await newEvent();
  const mine = await h.call('GET', '/api/desk/events', { token: booth });
  assert.deepEqual(mine.body.events.map(e => e.id), [ev.id]);
  assert.equal((await h.call('GET', `/api/desk/events/${other.id}`, { token: booth })).status, 404);
  assert.equal((await h.call('POST', `/api/command/events/${ev.id}/access`, { token: booth, body: { email: 'x@example.com' } })).status, 401, 'a booth login can’t hand out access');

  // Walk-ups: cash at the booth, or a QR to pay on the parent's phone.
  const cash = await h.call('POST', `/api/desk/events/${ev.id}/walk-ups`, { token: booth, body: { ...form({ playerName: 'Wes Walkup' }), payment: 'cash', note: 'paid $75 cash' } });
  assert.equal(cash.status, 201);
  assert.deepEqual([cash.body.registration.status, cash.body.registration.payment_label, cash.body.registration.walk_up, cash.body.url], ['paid', 'Cash', 1, null]);
  assert.equal(reg(cash.body.registration.registration_id).paid_by_name, 'Booth Helper');
  const qr = await h.call('POST', `/api/desk/events/${ev.id}/walk-ups`, { token: booth, body: { ...form({ playerName: 'Quinn Qr' }), payment: 'qr' } });
  assert.match(qr.body.url, /^https:\/\/checkout\.stripe\.test/);
  assert.equal(reg(qr.body.registration.registration_id).source, 'booth');
  assert.match((await h.call('POST', `/api/desk/events/${ev.id}/walk-ups`, { token: booth, body: { ...form(), consent: false, payment: 'cash' } })).body.error, /consent/);

  // An unpaid registration paid at the booth; Stripe paying it too later is flagged, not double counted.
  const link = await h.call('POST', `/api/desk/registrations/${pending}/pay-link`, { token: booth });
  assert.match(link.body.url, /checkout\.stripe\.test/);
  const sessionForPending = lastSession;
  const booth1 = await h.call('PUT', `/api/desk/registrations/${pending}/booth-payment`, { token: booth, body: { method: 'venmo' } });
  assert.deepEqual([booth1.body.registration.status, booth1.body.registration.payment_method], ['paid', 'venmo']);
  await deliver(completed(sessionForPending, pending));
  assert.equal(db.prepare("SELECT outcome FROM stripe_events WHERE registration_id = ? ORDER BY received_at DESC LIMIT 1").get(reg(pending).id).outcome, 'paid_twice');
  assert.equal(reg(pending).payment_method, 'venmo');
});

test('a renamed link still opens the page; a closed page takes walk-ups but not online sign-ups; the roster exports', async () => {
  const ev = await newEvent();
  await put(ev.id, { status: 'open' });
  await paidRegistration(ev, { playerName: '=HYPERLINK("x")' });
  const renamed = await put(ev.id, { slug: 'gobbler-pro-day-2099' });
  assert.equal(renamed.body.event.slug, 'gobbler-pro-day-2099');
  assert.deepEqual(renamed.body.aliases.map(a => a.slug), [ev.slug]);
  assert.equal((await h.call('GET', `/api/public/events/${ev.slug}`)).body.event.slug, 'gobbler-pro-day-2099', 'the old QR code still works');

  await put(ev.id, { status: 'closed' });
  assert.deepEqual([(await register('gobbler-pro-day-2099', form())).status, (await register('gobbler-pro-day-2099', form())).body.error], [409, 'Registration for this event is closed.']);
  assert.equal((await h.call('POST', `/api/desk/events/${ev.id}/walk-ups`, { token: fulfil.token, body: { ...form(), payment: 'comp' } })).body.registration.amount_total, 0);

  const csv = await fetch(`${h.base}/api/desk/events/${ev.id}/roster.csv`, { headers: { Authorization: `Bearer ${fulfil.token}` } });
  assert.equal(csv.status, 200);
  const body = await csv.text();
  assert.match(body, /^Registration,Player,Age,Team,Day/);
  assert.ok(body.includes(`"'=HYPERLINK(""x"")"`), 'a formula-looking name is defused');
  assert.equal(rosterCsv({ days: '[]' }, []).trim(), body.split('\r\n')[0]);
  assert.equal((await fetch(`${h.base}/api/desk/events/${ev.id}/roster.csv`)).status, 401);
});
