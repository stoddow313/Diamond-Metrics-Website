// GET /api/command/tournament-orders through the HTTP API: every internal
// role reads the paid orders, newest paid first, with what staff need to
// fulfil them; nobody else reads anything, and pending or abandoned checkouts
// never appear (prd.md R4, AC6, AC17).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-orders-cmd-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-tournament-orders-cmd-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { createPendingOrder, attachSession, markPaid, saveDetails, getOrder } = await import('./tournamentOrderStore.js');
const { hashPassword } = await import('./db.js');

let h, db, call;
before(async () => {
  h = await startIntakeApp();
  ({ db, call } = h);
});
after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

let n = 0;
function order({ paid = true, packageKey = 'tournament_pro', amount = 15000, player = `Player ${++n}`, paidAt = null } = {}) {
  const o = createPendingOrder(db, {
    guardianName: `Guardian ${n}`, playerName: player, email: `guardian${n}@example.com`, phone: n % 2 ? '555-0100' : '',
    tournamentId: 'better-baseball-nephi-2026', packageKey, priceId: 'price_TestX',
  });
  attachSession(db, o.id, `cs_test_cmd${n}`);
  if (paid) {
    markPaid(db, o.id, { sessionId: `cs_test_cmd${n}`, paymentIntentId: `pi_test_cmd${n}`, amountTotal: amount, currency: 'usd', paymentStatus: 'paid', eventId: `evt_cmd${n}` });
    if (paidAt) db.prepare('UPDATE tournament_orders SET paid_at = ? WHERE id = ?').run(paidAt, o.id);
  }
  return getOrder(db, o.id);
}

test('with no paid orders the list is empty', async () => {
  order({ paid: false });
  const r = await call('GET', '/api/command/tournament-orders', { token: h.internal('admin').token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { orders: [] });
});

test('every internal role reads paid orders only, newest paid first, with every field staff need', async () => {
  const older = order({ packageKey: 'individual_basic', amount: 5000, paidAt: '2026-10-09 15:47:00' });
  const newer = order({ paidAt: '2026-10-10 22:18:00' });
  saveDetails(db, newer.id, { teamClub: 'Example Hawks 14U', jerseyNumber: '4', primaryPosition: 'Catcher', batsThrows: 'R/R', gameContext: '', notes: '' });
  const abandoned = order({ paid: false });

  for (const role of ['admin', 'analyst', 'reviewer', 'fulfillment']) {
    const r = await call('GET', '/api/command/tournament-orders', { token: h.internal(role).token });
    assert.equal(r.status, 200, role);
    const ids = r.body.orders.map(o => o.order_id);
    assert.deepEqual(ids, [newer.order_id, older.order_id], `${role}: paid only, newest paid first`);
    assert.ok(!ids.includes(abandoned.order_id));
  }

  const { body } = await call('GET', '/api/command/tournament-orders', { token: h.internal('fulfillment').token });
  const top = body.orders[0];
  assert.deepEqual(top, {
    order_id: newer.order_id, paid_at: '2026-10-10 22:18:00', package_key: 'tournament_pro', amount_total: 15000, currency: 'usd',
    tournament_id: 'better-baseball-nephi-2026', guardian_name: newer.guardian_name, email: newer.email, phone: newer.phone,
    player_name: newer.player_name, team_club: 'Example Hawks 14U', jersey_number: '4', primary_position: 'Catcher',
    bats_throws: 'R/R', game_context: '', notes: '', details_received_at: top.details_received_at,
    stripe_session_id: newer.stripe_session_id, stripe_payment_intent_id: newer.stripe_payment_intent_id,
    package_label: 'Single Tournament — Pro', tournament_label: 'Better Baseball — Nephi, Utah · October 9–10, 2026',
  });
  assert.ok(top.details_received_at);
  assert.equal(body.orders[1].details_received_at, null, 'no details yet: the screen says "Details missing"');
  assert.equal(body.orders[1].package_label, 'Individual Game — Basic');
  assert.ok(!('price_id' in top) && !('status' in top) && !('id' in top), 'nothing beyond the list’s fields');
});

test('signed out, or signed in as anyone but internal staff, reads nothing', async () => {
  assert.equal((await call('GET', '/api/command/tournament-orders')).status, 401, 'anonymous');
  assert.equal((await call('GET', '/api/command/tournament-orders', { token: 'not-a-session' })).status, 401);

  const customer = await h.customer();
  assert.equal((await call('GET', '/api/command/tournament-orders', { token: customer.token })).status, 401, 'customer');

  const playerId = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Pat', 'Portal', ?)").run(`pat-portal-${Date.now()}`).lastInsertRowid;
  const playerUser = db.prepare('INSERT INTO player_users (player_id, email, password_hash) VALUES (?, ?, ?)')
    .run(playerId, `pat.portal.${Date.now()}@example.com`, hashPassword('player-password-1')).lastInsertRowid;
  assert.equal((await call('GET', '/api/command/tournament-orders', { token: h.principals.createPlayerSession(playerUser) })).status, 401, 'player');

  const staffUser = db.prepare('INSERT INTO staff_users (email, name, password_hash) VALUES (?, ?, ?)')
    .run(`coach.${Date.now()}@example.com`, 'Coach', hashPassword('staff-password-1')).lastInsertRowid;
  assert.equal((await call('GET', '/api/command/tournament-orders', { token: h.principals.createStaffSession(staffUser) })).status, 401, 'staff');

  const gone = h.internal('fulfillment');
  db.prepare('UPDATE admins SET active = 0 WHERE id = ?').run(gone.id);
  assert.equal((await call('GET', '/api/command/tournament-orders', { token: gone.token })).status, 401, 'a deactivated internal account');
});
