// Tournament admin corrections through the HTTP API (admin only): edit the
// event, its divisions, entries and games in place; move an entry between
// divisions keeping its id and event roster; merge 14U Gold / 14U Silver into
// one 14U division with the bracket stage on each game; withdraw, archive or
// delete with a dependency summary; restore what was deleted. Shared teams
// and player profiles are never deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-tournament-admin-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-tournament-admin-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';
process.env.DM_RATE_LIMITS = '0';

const { startIntakeApp } = await import('./intakeTestHarness.js');
const { resolveTournamentSlug } = await import('./tournamentAdminStore.js');
const { standings } = await import('./aggregates.js');

let h, db, call, admin;
before(async () => {
  h = await startIntakeApp();
  ({ db, call } = h);
  admin = h.internal('admin');
});
after(async () => {
  await h.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const as = (method, path, body) => call(method, path, { token: admin.token, body });
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

let n = 0;
const org = () => db.prepare('INSERT INTO organizations (name) VALUES (?)').run(`Club ${++n}`).lastInsertRowid;
const team = name => db.prepare('INSERT INTO teams (organization_id, name, slug, age_group) VALUES (?, ?, ?, ?)')
  .run(org(), name, `${name.toLowerCase().replace(/\W+/g, '-')}-${++n}`, '14U').lastInsertRowid;
const player = name => db.prepare('INSERT INTO players (slug, first_name, last_name) VALUES (?, ?, ?)')
  .run(`${name.toLowerCase().replace(/\W+/g, '-')}-${++n}`, name.split(' ')[0], name.split(' ')[1] || 'Player').lastInsertRowid;

// A Better Baseball-shaped event: 14U Gold and 14U Silver set up as
// divisions (the data to correct), plus the 14U division they belong in.
async function event(name = `Better Baseball ${++n}`) {
  const t = ok(await as('POST', '/api/tournaments', { name, start_date: '2026-10-09', end_date: '2026-10-10', location: 'Nephi, UT' }), 201).tournament;
  const div = async (dname, age) => ok(await as('POST', `/api/tournaments/${t.id}/divisions`, { name: dname, age_group: age }), 201).division;
  const gold = await div('14U Gold', '14U');
  const silver = await div('14U Silver', '14U');
  const u14 = await div('14U', '14U');
  const enter = async (division, teamName, seed) =>
    ok(await as('POST', `/api/tournaments/${t.id}/entries`, { division_id: division.id, team_id: team(teamName), seed }), 201).entry;
  const a = await enter(gold, 'Aces', 1);
  const b = await enter(gold, 'Bombers', 2);
  const c = await enter(silver, 'Comets', 3);
  const d = await enter(silver, 'Dukes', 4);
  const game = async (division, home, away, extra = {}) => ok(await as('POST', `/api/tournaments/${t.id}/games`, {
    division_id: division.id, home_entry_id: home.id, away_entry_id: away.id, game_date: '2026-10-10', game_time: '09:00', field: 'Field 1', ...extra,
  }), 201).game;
  return { t, gold, silver, u14, a, b, c, d, game };
}

test('edit tournament details: renaming keeps the public URL, and a changed URL keeps answering at the old one', async () => {
  const { t } = await event('Better Baseball Nephi');
  const r = ok(await as('PUT', `/api/tournaments/${t.id}`, { name: 'Better Baseball Fall Classic', start_date: '2026-10-08', end_date: '2026-10-11', location: 'Nephi, Utah' }));
  assert.equal(r.tournament.name, 'Better Baseball Fall Classic');
  assert.equal(r.tournament.location, 'Nephi, Utah');
  assert.equal(r.tournament.slug, t.slug, 'renaming leaves the public URL alone');

  assert.equal((await as('PUT', `/api/tournaments/${t.id}`, { end_date: '2026-10-01' })).status, 400, 'end before start');
  assert.equal((await as('PUT', `/api/tournaments/${t.id}`, { start_date: '10/08/2026' })).status, 400);
  assert.equal((await as('PUT', `/api/tournaments/${t.id}`, { name: '  ' })).status, 400);
  assert.equal((await as('PUT', `/api/tournaments/${t.id}`, { slug: 'Bad URL!' })).status, 400);

  const moved = ok(await as('PUT', `/api/tournaments/${t.id}`, { slug: 'better-baseball-fall-2026' }));
  assert.equal(moved.tournament.slug, 'better-baseball-fall-2026');
  assert.deepEqual(moved.aliases.map(a => a.slug), [t.slug]);
  assert.equal(resolveTournamentSlug(db, t.slug).id, t.id, 'the old URL still finds the event');
  assert.equal(resolveTournamentSlug(db, 'better-baseball-fall-2026').id, t.id);

  // Another event can neither take the current URL nor the old one.
  const other = (await event('Other Event')).t;
  assert.equal((await as('PUT', `/api/tournaments/${other.id}`, { slug: 'better-baseball-fall-2026' })).status, 409);
  assert.equal((await as('PUT', `/api/tournaments/${other.id}`, { slug: t.slug })).status, 409);
  const sameName = ok(await as('POST', '/api/tournaments', { name: 'Better Baseball Nephi', start_date: '2026-11-01', end_date: '2026-11-01' }), 201).tournament;
  assert.notEqual(sameName.slug, t.slug, 'a new event never takes a URL an older link still answers to');

  // Switching back reclaims the old URL.
  const back = ok(await as('PUT', `/api/tournaments/${t.id}`, { slug: t.slug }));
  assert.equal(back.tournament.slug, t.slug);
  assert.deepEqual(back.aliases.map(a => a.slug), ['better-baseball-fall-2026']);
});

test('edit a division, and merge 14U Gold and 14U Silver into 14U with each game keeping its bracket stage', async () => {
  const { t, gold, silver, u14, a, b, c, d, game } = await event();
  const renamed = ok(await as('PUT', `/api/divisions/${u14.id}`, { name: '14U Open', age_group: '14U' })).division;
  assert.equal(renamed.name, '14U Open');
  assert.equal((await as('PUT', `/api/divisions/${u14.id}`, { name: '' })).status, 400);

  const pool = await game(gold, a, b, { stage: 'pool' });
  const goldFinal = await game(gold, a, b);
  const silverFinal = await game(silver, c, d);

  const m1 = ok(await as('POST', `/api/divisions/${gold.id}/merge`, { into_division_id: u14.id, stage: 'gold' }));
  assert.deepEqual([m1.entries_moved, m1.games_moved, m1.games_staged], [2, 2, 1]);
  ok(await as('POST', `/api/divisions/${silver.id}/merge`, { into_division_id: u14.id, stage: 'silver' }));

  const detail = ok(await as('GET', `/api/tournaments/${t.id}`));
  assert.deepEqual(detail.divisions.map(x => x.name), ['14U Open']);
  assert.deepEqual(detail.entries.map(e => e.id).sort(), [a.id, b.id, c.id, d.id].sort(), 'same entry ids');
  const stageOf = id => detail.games.find(g => g.id === id);
  assert.equal(stageOf(pool.id).stage, 'pool', 'a stage already set is kept');
  assert.equal(stageOf(goldFinal.id).stage_label, 'Gold');
  assert.equal(stageOf(silverFinal.id).stage_label, 'Silver');
  assert.ok(detail.games.every(g => g.division_id === u14.id && !g.division_mismatch));

  // A team entered in both divisions has to be resolved first.
  const x = await event();
  const dupTeam = x.a.team_id;
  ok(await as('POST', `/api/tournaments/${x.t.id}/entries`, { division_id: x.silver.id, team_id: dupTeam }), 201);
  const clash = await as('POST', `/api/divisions/${x.gold.id}/merge`, { into_division_id: x.silver.id });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Aces/);
  assert.equal((await as('DELETE', `/api/divisions/${x.gold.id}`)).status, 409, 'a division with entries is not deleted');
});

test('moving an entry keeps its entry id and event roster; a game follows once both teams are in the new division', async () => {
  const { t, gold, u14, a, b, game } = await event();
  const p1 = player('Ray Runner');
  const p2 = player('Sam Slugger');
  ok(await as('POST', `/api/entries/${a.id}/roster`, { player_id: p1, jersey: '7' }), 201);
  ok(await as('POST', `/api/entries/${a.id}/roster`, { player_id: p2, is_guest: 1 }), 201);
  const g = await game(gold, a, b);

  const first = ok(await as('POST', `/api/entries/${a.id}/move`, { division_id: u14.id }));
  assert.equal(first.entry.id, a.id);
  assert.equal(first.entry.division_id, u14.id);
  assert.deepEqual([first.games_moved, first.games_left], [0, 1], 'the game waits for its other team');
  const roster = ok(await as('GET', `/api/entries/${a.id}/roster`));
  assert.equal(roster.source, 'event');
  assert.deepEqual(roster.roster.map(r => r.player_id).sort(), [p1, p2].sort());

  const second = ok(await as('POST', `/api/entries/${b.id}/move`, { division_id: u14.id }));
  assert.equal(second.games_moved, 1);
  const moved = ok(await as('GET', `/api/tournaments/${t.id}`)).games.find(x => x.id === g.id);
  assert.equal(moved.division_id, u14.id);

  // Into a division where the team is already entered: refused, nothing duplicated.
  const again = ok(await as('POST', `/api/tournaments/${t.id}/entries`, { division_id: gold.id, team_id: a.team_id }), 201).entry;
  assert.equal((await as('POST', `/api/entries/${again.id}/move`, { division_id: u14.id })).status, 409);
  // Into another tournament's division: refused.
  const other = await event();
  assert.equal((await as('POST', `/api/entries/${a.id}/move`, { division_id: other.u14.id })).status, 400);
});

test('withdraw keeps the team and players; archive and delete warn or block while games depend on the entry; delete is restorable', async () => {
  const { gold, a, b, game } = await event();
  const p1 = player('Kai Keeper');
  ok(await as('POST', `/api/entries/${b.id}/roster`, { player_id: p1 }), 201);
  const g = await game(gold, a, b);

  const dep = ok(await as('GET', `/api/event-records/entry/${b.id}/dependencies`));
  assert.equal(dep.actions.withdraw.allowed, true);
  assert.match(dep.actions.withdraw.warnings[0], /1 scheduled game/);
  assert.equal(dep.actions.archive.allowed, false);
  assert.equal(dep.actions.delete.allowed, false);

  const withdrawn = ok(await as('PUT', `/api/entries/${b.id}`, { status: 'withdrawn' })).entry;
  assert.equal(withdrawn.status, 'withdrawn');
  assert.ok(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(b.team_id), 'the shared team stays');
  assert.equal((await as('PUT', `/api/entries/${b.id}`, { status: 'archived' })).status, 409, 'archive blocked by a scheduled game');
  assert.equal((await as('DELETE', `/api/event-records/entry/${b.id}`)).status, 409, 'delete blocked by a game');

  // Once the game is gone the entry can go too — and come back intact.
  ok(await as('DELETE', `/api/event-records/game/${g.id}`));
  const del = ok(await as('DELETE', `/api/event-records/entry/${b.id}`));
  assert.ok(del.trash_id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tournament_entries WHERE id = ?').get(b.id).c, 0);
  assert.ok(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(b.team_id), 'team kept');
  assert.ok(db.prepare('SELECT 1 FROM players WHERE id = ?').get(p1), 'player kept');

  ok(await as('POST', `/api/event-trash/${del.trash_id}/restore`));
  const back = db.prepare('SELECT * FROM tournament_entries WHERE id = ?').get(b.id);
  assert.equal(back.status, 'withdrawn');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM event_rosters WHERE entry_id = ?').get(b.id).c, 1, 'event roster restored');
  assert.equal((await as('POST', `/api/event-trash/${del.trash_id}/restore`)).status, 409, 'only once');
  // Re-entering instead of reinstating is refused with a pointer.
  const dupe = await as('POST', `/api/tournaments/${b.tournament_id}/entries`, { division_id: gold.id, team_id: b.team_id });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /reinstate/);
});

test('entry details: seed, pool, placement, wins and losses are validated, and an entered record wins in the standings', async () => {
  const { t, gold, a, b, game } = await event();
  assert.equal((await as('PUT', `/api/entries/${a.id}`, { seed: 0 })).status, 400);
  assert.equal((await as('PUT', `/api/entries/${a.id}`, { wins: -1 })).status, 400);
  assert.equal((await as('PUT', `/api/entries/${a.id}`, { status: 'gone' })).status, 400);
  const e = ok(await as('PUT', `/api/entries/${a.id}`, { seed: '2', pool: 'A', placement: '1st — Gold', wins: 4, losses: 1 })).entry;
  assert.deepEqual([e.seed, e.pool, e.placement, e.wins, e.losses], [2, 'A', '1st — Gold', 4, 1]);

  await game(gold, a, b, { status: 'final', home_score: 2, away_score: 5 });
  const rows = standings(db, t.id);
  const aRow = rows.find(r => r.entry_id === a.id);
  const bRow = rows.find(r => r.entry_id === b.id);
  assert.deepEqual([aRow.wins, aRow.losses, aRow.record_source], [4, 1, 'manual']);
  assert.deepEqual([bRow.wins, bRow.losses, bRow.record_source], [1, 0, 'games']);
  // Clearing the entered record falls back to the scores.
  ok(await as('PUT', `/api/entries/${a.id}`, { wins: '', losses: '' }));
  assert.deepEqual([standings(db, t.id).find(r => r.entry_id === a.id).losses], [1]);
});

test('edit a game: date, time, field, status, stage, division and teams', async () => {
  const { gold, silver, a, b, c, d, game } = await event();
  const g = await game(gold, a, b);
  const edited = ok(await as('PUT', `/api/tournament-games/${g.id}`, {
    game_date: '2026-10-09', game_time: '13:30', field: 'Field 3', status: 'final', home_score: 6, away_score: 4,
    stage: 'gold', division_id: silver.id, home_entry_id: c.id, away_entry_id: d.id,
  })).game;
  assert.deepEqual(
    [edited.game_date, edited.game_time, edited.field, edited.status, edited.stage_label, edited.division_id, edited.home_entry_id, edited.away_entry_id],
    ['2026-10-09', '13:30', 'Field 3', 'final', 'Gold', silver.id, c.id, d.id],
  );
  ok(await as('PUT', `/api/tournament-games/${g.id}`, { stage: '' }));
  assert.equal(db.prepare('SELECT stage FROM tournament_games WHERE id = ?').get(g.id).stage, null, 'stage can be cleared');

  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { stage: 'platinum' })).status, 400);
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { game_time: '9am' })).status, 400);
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { status: 'postponed' })).status, 400);
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { away_entry_id: c.id })).status, 400, 'a team cannot play itself');
  const other = await event();
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { home_entry_id: other.a.id })).status, 400);
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { division_id: other.gold.id })).status, 400);

  // A lineup recorded for a team holds that team in the game; swapping sides is fine.
  const p = player('Lou Lineup');
  ok(await as('POST', `/api/tournament-games/${g.id}/appearances`, { player_id: p, entry_id: c.id }), 201);
  assert.equal((await as('PUT', `/api/tournament-games/${g.id}`, { home_entry_id: a.id })).status, 409);
  const swapped = ok(await as('PUT', `/api/tournament-games/${g.id}`, { home_entry_id: d.id, away_entry_id: c.id })).game;
  assert.deepEqual([swapped.home_entry_id, swapped.away_entry_id], [d.id, c.id]);
});

test('archived games leave the standings until restored; deleting a game is blocked by linked stats and restorable otherwise', async () => {
  const { t, gold, a, b, game } = await event();
  const g = await game(gold, a, b, { status: 'final', home_score: 3, away_score: 1, stage: 'pool' });
  const winsOf = () => standings(db, t.id).find(r => r.entry_id === a.id).wins;
  assert.equal(winsOf(), 1);

  ok(await as('POST', `/api/event-records/game/${g.id}/archive`));
  assert.equal(winsOf(), 0, 'archived game is out of the standings');
  ok(await as('POST', `/api/event-records/game/${g.id}/restore`));
  assert.equal(winsOf(), 1);

  const p = player('Stat Line');
  const statGame = db.prepare("INSERT INTO games (player_id, game_date, tournament_game_id) VALUES (?, '2026-10-10', ?)").run(p, g.id).lastInsertRowid;
  const dep = ok(await as('GET', `/api/event-records/game/${g.id}/dependencies`));
  assert.equal(dep.actions.delete.allowed, false);
  assert.match(dep.actions.delete.blockers[0], /player stat line/);
  assert.equal((await as('DELETE', `/api/event-records/game/${g.id}`)).status, 409);
  db.prepare('DELETE FROM games WHERE id = ?').run(statGame);

  ok(await as('POST', `/api/tournament-games/${g.id}/appearances`, { player_id: p, entry_id: a.id }), 201);
  const del = ok(await as('DELETE', `/api/event-records/game/${g.id}`));
  const trash = ok(await as('GET', `/api/event-trash?tournament_id=${t.id}`)).items;
  assert.equal(trash[0].id, del.trash_id);
  assert.deepEqual(trash[0].contents.map(c => c.table), ['tournament_games', 'player_game_appearances']);
  ok(await as('POST', `/api/event-trash/${del.trash_id}/restore`));
  const back = db.prepare('SELECT * FROM tournament_games WHERE id = ?').get(g.id);
  assert.equal(back.stage, 'pool');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM player_game_appearances WHERE tournament_game_id = ?').get(g.id).c, 1);
});

test('deleting a tournament never deletes shared teams or players, is blocked by Command work, and restores with the same ids', async () => {
  const { t, gold, a, b, c, game } = await event();
  const p = player('Pat Prospect');
  ok(await as('POST', `/api/entries/${a.id}/roster`, { player_id: p }), 201);
  const g = await game(gold, a, b);

  const sport = db.prepare("SELECT id FROM sports WHERE key = 'baseball'").get().id;
  const order = db.prepare("INSERT INTO cmd_orders (package_key) VALUES ('rookie')").run().lastInsertRowid;
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, tournament_game_id) VALUES (?, ?, '2026-10-10', ?, ?)")
    .run(sport, a.team_id, order, g.id).lastInsertRowid;
  const blocked = await as('DELETE', `/api/event-records/tournament/${t.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Command job/);
  assert.equal(blocked.body.dependencies.actions.archive.allowed, true, 'archive stays available');
  // A Command job also holds its game's teams in place.
  const held = await as('PUT', `/api/tournament-games/${g.id}`, { home_entry_id: c.id });
  assert.equal(held.status, 409);
  assert.match(held.body.error, /Command job/);
  db.prepare('DELETE FROM cmd_jobs WHERE id = ?').run(job);

  const archived = ok(await as('POST', `/api/event-records/tournament/${t.id}/archive`)).record;
  assert.equal(archived.archived, 1);
  ok(await as('POST', `/api/event-records/tournament/${t.id}/restore`));

  const del = ok(await as('DELETE', `/api/event-records/tournament/${t.id}`));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tournaments WHERE id = ?').get(t.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tournament_entries WHERE tournament_id = ?').get(t.id).c, 0);
  assert.ok(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(a.team_id), 'team kept');
  assert.ok(db.prepare('SELECT 1 FROM players WHERE id = ?').get(p), 'player kept');
  const listed = ok(await as('GET', '/api/event-trash')).items.find(i => i.id === del.trash_id);
  assert.equal(listed.kind, 'tournament');

  ok(await as('POST', `/api/event-trash/${del.trash_id}/restore`));
  const detail = ok(await as('GET', `/api/tournaments/${t.id}`));
  assert.equal(detail.tournament.slug, t.slug);
  assert.equal(detail.entries.length, 4);
  assert.ok(detail.games.some(x => x.id === g.id));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM event_rosters WHERE entry_id = ?').get(a.id).c, 1);
});

test('only admins use the tournament admin tools', async () => {
  const { gold } = await event();
  const analyst = h.internal('analyst');
  assert.equal((await call('PUT', `/api/divisions/${gold.id}`, { token: analyst.token, body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', `/api/event-records/division/${gold.id}/dependencies`)).status, 401);
});
