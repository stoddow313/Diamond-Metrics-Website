// Import-workflow acceptance tests (requirements §8, §12): dry-run planning,
// duplicate flagging with resolution, idempotent re-import, guest rosters,
// and audit records — against a scratch database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-import-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const { planImport, applyImport, resolvePlayer } = await import('./importEngine.js');

before(() => {
  db.prepare(`INSERT INTO seasons (label, start_date, end_date) VALUES ('2026 Summer', '2026-05-01', '2026-08-15')`).run();
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('teams import: dry-run plans creates; apply is idempotent on re-import', () => {
  const rows = [
    { organization: 'Bingham High School', org_type: 'school', team_name: 'Bingham Miners', age_group: '16U', level: 'Gold', team_external_id: 'EXT-MINERS' },
    { organization: 'Corner Canyon Club', team_name: 'CC Chargers', age_group: '16U' },
  ];
  const plan = planImport(db, 'teams', rows);
  assert.deepEqual(plan.map(p => p.action), ['create', 'create']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams').get().c, 0); // dry-run wrote nothing

  const first = applyImport(db, 'teams', rows, {}, { filename: 'teams.csv', uploader: 'admin@test' });
  assert.equal(first.counts.created, 2);

  const again = applyImport(db, 'teams', rows, {}, { filename: 'teams.csv', uploader: 'admin@test' });
  assert.equal(again.counts.created, 0);
  assert.equal(again.counts.updated, 2); // idempotent — no duplicates
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams').get().c, 2);
  assert.ok(db.prepare(`SELECT 1 FROM teams WHERE external_id = 'EXT-MINERS'`).get());
});

test('season roster import: creates players, flags possible duplicates, resolves by choice', () => {
  const rows = [
    { team: 'EXT-MINERS', season_label: '2026 Summer', first_name: 'Jake', last_name: 'Rivera', grad_year: 2027, start_date: '2026-05-01', jersey: '9' },
  ];
  const r1 = applyImport(db, 'season_roster', rows, {}, { uploader: 'admin@test' });
  assert.equal(r1.counts.created, 1);

  // Same name, no distinguishing DOB/grad → flagged, and apply is blocked.
  const dupRows = [{ team: 'EXT-MINERS', first_name: 'Jake', last_name: 'Rivera', start_date: '2026-06-01' }];
  const plan = planImport(db, 'season_roster', dupRows);
  assert.equal(plan[0].action, 'needs_resolution');
  assert.equal(plan[0].candidates.length, 1);

  const blocked = applyImport(db, 'season_roster', dupRows, {}, { uploader: 'admin@test' });
  assert.equal(blocked.blocked, true); // never silently creates on a name match

  // Resolution: link to the existing player → membership updates, no new player.
  const linked = applyImport(db, 'season_roster', dupRows, { 0: { player_id: plan[0].candidates[0].id } }, { uploader: 'admin@test' });
  assert.equal(linked.blocked, false);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM players WHERE last_name = 'Rivera'`).get().c, 1);

  // Resolution: explicitly create a second Jake Rivera (different person).
  const created = applyImport(db, 'season_roster', dupRows, { 0: { create: true } }, { uploader: 'admin@test' });
  assert.equal(created.counts.created, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM players WHERE last_name = 'Rivera'`).get().c, 2);
});

test('name+grad_year disambiguates without manual resolution', () => {
  const { player, matchedBy } = resolvePlayer(db, { first_name: 'Jake', last_name: 'Rivera', grad_year: 2027 });
  assert.ok(player);
  assert.equal(matchedBy, 'name+grad_year');
});

test('entries, event rosters (guests), and games import with full context', () => {
  db.prepare(`INSERT INTO tournaments (name, slug, start_date, end_date) VALUES ('Fall Classic', 'fall-classic', '2026-09-01', '2026-09-03')`).run();

  const entries = applyImport(db, 'tournament_entries', [
    { tournament: 'Fall Classic', division: '16U Gold', team: 'EXT-MINERS', seed: 1 },
    { tournament: 'Fall Classic', division: '16U Gold', team: 'CC Chargers', seed: 2 },
  ], {}, { uploader: 'admin@test' });
  assert.equal(entries.counts.created, 2);

  // Event roster: existing player joins; unknown player errors (never created here).
  const roster = applyImport(db, 'event_rosters', [
    { tournament: 'Fall Classic', division: '16U Gold', team: 'EXT-MINERS', first_name: 'Jake', last_name: 'Rivera', player_external_id: '', is_guest: 'yes', jersey: '44', grad_year: 2027 },
    { tournament: 'Fall Classic', division: '16U Gold', team: 'EXT-MINERS', first_name: 'Nobody', last_name: 'Unknown' },
  ], {}, { uploader: 'admin@test' });
  assert.equal(roster.counts.created, 1);
  assert.equal(roster.counts.errors, 1);
  assert.equal(db.prepare('SELECT is_guest FROM event_rosters LIMIT 1').get().is_guest, 1);

  // Games: create with score, re-import updates the same game (external id).
  const gameRows = [{ tournament: 'Fall Classic', division: '16U Gold', home_team: 'EXT-MINERS', away_team: 'CC Chargers', game_date: '2026-09-01', home_score: 5, away_score: 2, game_external_id: 'G-001' }];
  const g1 = applyImport(db, 'games', gameRows, {}, { uploader: 'admin@test' });
  assert.equal(g1.counts.created, 1);
  gameRows[0].home_score = 6;
  const g2 = applyImport(db, 'games', gameRows, {}, { uploader: 'admin@test' });
  assert.equal(g2.counts.updated, 1);
  const game = db.prepare(`SELECT * FROM tournament_games WHERE external_id = 'G-001'`).get();
  assert.equal(game.home_score, 6);
  assert.equal(game.status, 'final');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tournament_games').get().c, 1);
});

test('metrics import: creates per-player context + stat entries, update on re-import', () => {
  const rows = [{ first_name: 'Jake', last_name: 'Rivera', grad_year: 2027, game_date: '2026-09-01', game_type: 'game', opponent: 'vs Chargers', max_exit_velo: 88.5, dash_60: 7.1 }];
  const r1 = applyImport(db, 'metrics', rows, {}, { uploader: 'admin@test' });
  assert.equal(r1.counts.created, 1);
  rows[0].max_exit_velo = 90.0;
  const r2 = applyImport(db, 'metrics', rows, {}, { uploader: 'admin@test' });
  assert.equal(r2.counts.updated, 1);
  const entries = db.prepare(
    `SELECT s.metric_key, s.value FROM stat_entries s JOIN games g ON g.id = s.game_id
     JOIN players p ON p.id = g.player_id WHERE p.last_name = 'Rivera' AND p.grad_year = 2027`
  ).all();
  assert.equal(entries.length, 2); // updated, not duplicated
  assert.equal(entries.find(e => e.metric_key === 'max_exit_velo').value, 90.0);
});

test('JSON-serialized date cells never shift a day (timezone-safe)', () => {
  // SheetJS date cells arrive as ISO datetimes after JSON serialization;
  // the intended day is the date component, regardless of server timezone.
  const rows = [{ team: 'EXT-MINERS', first_name: 'Dated', last_name: 'Rowcheck', grad_year: 2029, start_date: '2026-05-01T00:00:00.000Z' }];
  const r = applyImport(db, 'season_roster', rows, {}, { uploader: 'admin@test' });
  assert.equal(r.counts.created, 1);
  const membership = db.prepare(
    `SELECT rm.start_date FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE p.last_name = 'Rowcheck'`
  ).get();
  assert.equal(membership.start_date, '2026-05-01');

  // Idempotency must hold across serialization styles of the same date.
  const again = applyImport(db, 'season_roster', [{ ...rows[0], start_date: '2026-05-01' }], {}, { uploader: 'admin@test' });
  assert.equal(again.counts.created, 0);
  assert.equal(again.counts.updated, 1);
});

test('importing into an archived season warns but does not block', () => {
  db.prepare(`INSERT INTO seasons (label, start_date, end_date, status) VALUES ('2025 Fall', '2025-08-20', '2025-11-01', 'archived')`).run();
  const rows = [{ team: 'EXT-MINERS', first_name: 'Archie', last_name: 'Seasoncheck', grad_year: 2029, season_label: '2025 Fall', start_date: '2025-08-20' }];

  const plan = planImport(db, 'season_roster', rows);
  assert.equal(plan[0].action, 'create');
  assert.match(plan[0].message, /season "2025 Fall" is archived/);

  const r = applyImport(db, 'season_roster', rows, {}, { uploader: 'admin@test' });
  assert.equal(r.blocked, false);
  assert.equal(r.counts.created, 1); // historical backfills stay possible
});

test('metrics import: zeros in zero-impossible metrics are skipped with a warning, real zeros kept', () => {
  const rows = [{
    first_name: 'Jake', last_name: 'Rivera', grad_year: 2027, game_date: '2026-09-10', opponent: 'Zero Test',
    max_velo: 0, strike_pct: 0,          // impossible → skipped + warned
    launch_angle: 0,                     // signed metric → a real value
    bs_h: 0, bs_ab: 3,                   // box zeros are real data
  }];
  const plan = planImport(db, 'metrics', rows);
  assert.equal(plan[0].action, 'create');
  assert.match(plan[0].message, /max_velo, strike_pct = 0 treated as not measured/);

  const r = applyImport(db, 'metrics', rows, {}, { uploader: 'admin@test' });
  assert.equal(r.counts.created, 1);
  const entries = db.prepare(
    `SELECT metric_key, value FROM stat_entries s JOIN games g ON g.id = s.game_id
     WHERE g.opponent = 'Zero Test'`
  ).all();
  const keys = new Set(entries.map(e => e.metric_key));
  assert.ok(!keys.has('max_velo') && !keys.has('strike_pct'), 'impossible zeros never stored');
  assert.ok(keys.has('launch_angle') && keys.has('bs_h'), 'legitimate zeros stored');

  // A row that is ONLY impossible zeros errors instead of creating an empty record.
  const emptyPlan = planImport(db, 'metrics', [{ first_name: 'Jake', last_name: 'Rivera', grad_year: 2027, game_date: '2026-09-11', max_velo: 0 }]);
  assert.equal(emptyPlan[0].action, 'error');
  assert.match(emptyPlan[0].message, /no metric values/);
});

test('every apply writes an audit record with uploader and counts', () => {
  const audits = db.prepare('SELECT * FROM import_audits ORDER BY id').all();
  assert.ok(audits.length >= 6);
  assert.ok(audits.every(a => a.uploader_email === 'admin@test'));
  assert.ok(audits.every(a => a.created_count + a.updated_count + a.skipped_count + a.error_count > 0));
  const report = JSON.parse(audits[0].report);
  assert.ok(Array.isArray(report) && report[0].action); // traceable row-level report
});
