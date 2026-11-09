// The giveaway's entry window is a setting (Command → Events → Giveaway), not
// code: the page and the rules read it, entries follow it, and admin and
// fulfillment see the entries next to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-giveaway-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-giveaway-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { zonedToUtc, utcToZoned, windowState, readSettingsPatch } = await import('./giveawayLogic.js');

let h, db, fulfil, admin, analyst;
before(async () => {
  h = await startIntakeApp();
  ({ db } = h);
  fulfil = h.internal('fulfillment', 'Will S');
  admin = h.internal('admin');
  analyst = h.internal('analyst');
});
after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const entry = (over = {}) => ({ fullName: 'Avery Example', email: `avery${Math.random().toString(36).slice(2, 8)}@example.com`, phone: '', ageConfirmed: true, eligibilityConfirmed: true, marketingConsent: true, ...over });
const enter = body => h.call('POST', '/api/giveaway/entries', { body });
const setWindow = (body, token = fulfil.token) => h.call('PUT', '/api/command/giveaway/settings', { token, body });
const local = ms => utcToZoned(new Date(ms).toISOString());

test('Mountain time in, UTC stored, either side of daylight time', () => {
  assert.equal(zonedToUtc('2026-11-06T07:00'), '2026-11-06T14:00:00.000Z', 'MST is UTC−7');
  assert.equal(zonedToUtc('2026-07-04T07:00'), '2026-07-04T13:00:00.000Z', 'MDT is UTC−6');
  assert.equal(utcToZoned('2026-11-08T07:00:00.000Z'), '2026-11-08T00:00');
  assert.equal(zonedToUtc('Nov 6'), null);
  assert.deepEqual(windowState({ opens_at: null, closes_at: null }), { accepting: true, reason: null }, 'no window: open');
  assert.equal(readSettingsPatch({ opens_local: 'soon' }).error, 'Enter the opening time as a date and time.');
  assert.deepEqual(readSettingsPatch({ closes_local: '', drawing_on: '' }).value, { closes_at: null, drawing_on: null }, 'blank clears');
});

test('the first giveaway’s window is the seeded setting: it has ended, and entries say so', async () => {
  const pub = (await h.call('GET', '/api/giveaway')).body.giveaway;
  assert.deepEqual([pub.opens_at, pub.closes_at, pub.drawing_on, pub.accepting, pub.reason],
    ['2026-11-06T14:00:00.000Z', '2026-11-08T07:00:00.000Z', '2026-11-11', false, 'ended']);
  const r = await enter(entry());
  assert.deepEqual([r.status, r.body.error], [403, 'The giveaway entry period has ended.']);
});

test('admin and fulfillment set the window in Command; entries follow it; analysts can’t', async () => {
  assert.equal((await setWindow({ opens_local: local(Date.now() - 36e5) }, analyst.token)).status, 403);
  assert.equal((await h.call('GET', '/api/command/giveaway', { token: analyst.token })).status, 403, 'entries are personal data');
  assert.equal((await h.call('GET', '/api/command/giveaway')).status, 401);

  // Not open yet: the reply names the opening time.
  const later = await setWindow({ opens_local: local(Date.now() + 2 * 864e5), closes_local: local(Date.now() + 3 * 864e5) });
  assert.equal(later.status, 200);
  assert.equal(later.body.giveaway.reason, 'not_open_yet');
  assert.match((await enter(entry())).body.error, /^Entries open \w+day, \w+ \d+, \d{4} at \d+:\d{2} [AP]M M[SD]T\.$/);

  assert.equal((await setWindow({ opens_local: local(Date.now() + 864e5), closes_local: local(Date.now()) })).body.error, 'The giveaway must close after it opens.');

  // Open now, closing tomorrow.
  const open = await setWindow({ opens_local: local(Date.now() - 36e5), closes_local: local(Date.now() + 864e5), drawing_on: '2026-11-20' }, admin.token);
  assert.deepEqual([open.body.giveaway.accepting, open.body.giveaway.drawing_on], [true, '2026-11-20']);
  assert.equal((await h.call('GET', '/api/giveaway')).body.giveaway.accepting, true);
  const ok = await enter(entry({ fullName: 'Rowan Example', email: 'rowan@example.com', phone: '801-555-0100' }));
  assert.deepEqual([ok.status, ok.body.ok], [201, true]);
  assert.equal((await enter(entry({ email: 'ROWAN@example.com' }))).status, 409, 'one entry per email');

  // Command shows the entries beside the window; fulfillment exports the CSV.
  const cmd = (await h.call('GET', '/api/command/giveaway', { token: fulfil.token })).body;
  assert.equal(cmd.counts.entries, 1);
  assert.deepEqual([cmd.entries[0].full_name, cmd.entries[0].email, cmd.entries[0].phone], ['Rowan Example', 'rowan@example.com', '801-555-0100']);
  assert.match(cmd.giveaway.opens_local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const csv = await fetch(`${h.base}/api/giveaway/entries.csv`, { headers: { Authorization: `Bearer ${fulfil.token}` } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Rowan Example,rowan@example\.com,801-555-0100,Yes/);

  // No end: a blank closing time keeps it open.
  assert.equal((await setWindow({ closes_local: '' })).body.giveaway.closes_at, null);
  assert.equal((await enter(entry())).status, 201);
});
