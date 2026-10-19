// A finished job created as a standalone game is linked to its tournament
// game without re-creating it: the job and its published player games carry
// the game, those games count for the team's entry on the tournament and
// team dashboards, a paired job follows, and the released final can be
// recorded on a game with no score yet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import express from 'express';

const TEST_DB = `/tmp/dm-tlink-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { linkTournamentGame, unlinkTournamentGame, tournamentLinkOf } = await import('./tournamentLink.js');
const { mountTournamentLinkRoutes } = await import('./tournamentLinkRoutes.js');
const { pairJobs } = await import('./gamePairing.js');
const { attributedGames } = await import('./aggregates.js');

let admin, sport, huskers, vice, other, tour, hEntry, vEntry, gameHV, gameHO, server, base;
const ins = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const team = name => ins('INSERT INTO teams (organization_id, name, slug) VALUES (?, ?, ?)', ins('INSERT INTO organizations (name) VALUES (?)', name), name, name.toLowerCase());
const player = (teamId, first) => {
  const id = ins('INSERT INTO players (first_name, last_name, slug) VALUES (?, ?, ?)', first, 'P', `${first.toLowerCase()}-${teamId}`);
  ins("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '1', '2026-01-01', '2026-12-31')", teamId, id);
  return id;
};
// A job with one player game already published (what a release writes).
function finishedJob(teamId, playerId, date = '2026-10-10') {
  const order = ins("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')");
  const job = ins("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label, game_type) VALUES (?, ?, ?, ?, 'Vice', 'game')", sport, teamId, date, order);
  const g = ins("INSERT INTO games (player_id, game_date, game_type, opponent, command_job_id) VALUES (?, ?, 'game', 'Vice', ?)", playerId, date, job);
  ins("INSERT INTO stat_entries (game_id, metric_key, value, method) VALUES (?, 'bs_h', 2, 'scorebook_derived')", g);
  return { job, game: g };
}
const entryGames = (teamId, entryId) => attributedGames(db, { id: teamId }, { entry: { id: entryId, start_date: '2026-10-09', end_date: '2026-10-12' } });
const tg = id => db.prepare('SELECT * FROM tournament_games WHERE id = ?').get(id);

before(async () => {
  sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  huskers = team('Huskers'); vice = team('Vice'); other = team('Gold');
  tour = ins("INSERT INTO tournaments (name, slug, start_date, end_date) VALUES ('Fall Classic', 'fall-classic', '2026-10-09', '2026-10-12')");
  const div = ins("INSERT INTO divisions (tournament_id, name) VALUES (?, '14U')", tour);
  hEntry = ins('INSERT INTO tournament_entries (tournament_id, division_id, team_id) VALUES (?, ?, ?)', tour, div, huskers);
  vEntry = ins('INSERT INTO tournament_entries (tournament_id, division_id, team_id) VALUES (?, ?, ?)', tour, div, vice);
  const oEntry = ins('INSERT INTO tournament_entries (tournament_id, division_id, team_id) VALUES (?, ?, ?)', tour, div, other);
  gameHV = ins("INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date) VALUES (?, ?, ?, ?, '2026-10-10')", tour, div, hEntry, vEntry);
  gameHO = ins("INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date) VALUES (?, ?, ?, ?, '2026-10-11')", tour, div, oEntry, hEntry);
  const app = express();
  app.use(express.json());
  mountTournamentLinkRoutes(app, { db, requireInternal: (req, _res, next) => { req.internal = { id: admin }; next(); } });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('a standalone job links to its tournament game and its player games count for the entry', async () => {
  const kyon = player(huskers, 'Kyon');
  const { job, game } = finishedJob(huskers, kyon);
  assert.equal(entryGames(huskers, hEntry).length, 0, 'standalone, and Kyon is on no event roster: nothing counts');

  const view = await fetch(`${base}/api/command/jobs/${job}/tournament-link`).then(r => r.json());
  assert.equal(view.linked, null);
  assert.deepEqual(view.candidates.map(c => [c.id, c.opponent, c.is_home]), [[gameHV, 'Vice', true]], 'its team, its date');

  const res = await fetch(`${base}/api/command/jobs/${job}/tournament-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tournament_game_id: gameHV }) });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).linked.id, gameHV);
  const j = db.prepare('SELECT tournament_game_id, tournament_id FROM cmd_jobs WHERE id = ?').get(job);
  assert.deepEqual([j.tournament_game_id, j.tournament_id], [gameHV, tour]);
  assert.equal(db.prepare('SELECT tournament_game_id FROM games WHERE id = ?').get(game).tournament_game_id, gameHV, 'the published game follows');
  assert.deepEqual(entryGames(huskers, hEntry).map(r => r.game_id), [game], 'now it counts for the Huskers entry');
  assert.equal(entryGames(vice, vEntry).length, 0, 'and not for the other team');
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table = 'cmd_jobs' AND target_id = ? AND action = 'tournament_game_linked'").get(job));

  unlinkTournamentGame(db, job, admin);
  assert.equal(db.prepare('SELECT tournament_game_id FROM games WHERE id = ?').get(game).tournament_game_id, null);
  assert.equal(entryGames(huskers, hEntry).length, 0);
});

test('a link is refused for the wrong team, the wrong date, or a game another job already has', () => {
  const p = player(huskers, 'Ana');
  const a = finishedJob(huskers, p).job;
  const late = finishedJob(huskers, p, '2026-10-11').job;
  const gold = finishedJob(other, player(other, 'Gus')).job;
  assert.throws(() => linkTournamentGame(db, gold, { tournament_game_id: gameHV }, admin), /doesn't play in that game/);
  assert.throws(() => linkTournamentGame(db, late, { tournament_game_id: gameHV }, admin), /is on 2026-10-10; this job is dated 2026-10-11/);
  assert.equal(tournamentLinkOf(db, late).candidates[0].id, gameHO, 'its own date offers its own game');
  linkTournamentGame(db, a, { tournament_game_id: gameHV }, admin);
  const b = finishedJob(huskers, p).job;
  assert.throws(() => linkTournamentGame(db, b, { tournament_game_id: gameHV }, admin), new RegExp(`Job #${a} is already linked`));
  assert.equal(tournamentLinkOf(db, b).candidates[0].linked_job_id, a, 'the form says which job has it');
  unlinkTournamentGame(db, a, admin);
});

test("the released final is recorded on a game with no score — never over one", () => {
  const { job } = finishedJob(huskers, player(huskers, 'Bo'));
  assert.throws(() => linkTournamentGame(db, job, { tournament_game_id: gameHV, record_score: true }, admin), /hasn't been released/);
  db.prepare("INSERT INTO cmd_game_results (job_id, us_runs, them_runs, winner) VALUES (?, 7, 3, 'us')").run(job);
  assert.deepEqual(tournamentLinkOf(db, job).result, { us_runs: 7, them_runs: 3, winner: 'us' });
  linkTournamentGame(db, job, { tournament_game_id: gameHV, record_score: true }, admin);
  assert.deepEqual([tg(gameHV).home_score, tg(gameHV).away_score, tg(gameHV).status], [7, 3, 'final'], 'Huskers are home: 7–3');
  unlinkTournamentGame(db, job, admin);
  assert.equal(tg(gameHV).status, 'final', 'unlinking leaves the tournament score as recorded');
  assert.throws(() => linkTournamentGame(db, job, { tournament_game_id: gameHV, record_score: true }, admin), /already has a score/);
  linkTournamentGame(db, job, { tournament_game_id: gameHV }, admin);   // linking without the score is fine
  unlinkTournamentGame(db, job, admin);
  db.prepare("UPDATE tournament_games SET home_score = NULL, away_score = NULL, status = 'scheduled' WHERE id = ?").run(gameHV);
});

test("a paired job links with it — the other team's games count for its own entry", () => {
  const hp = player(huskers, 'Hal'); const vp = player(vice, 'Vic');
  const h = finishedJob(huskers, hp); const v = finishedJob(vice, vp);
  pairJobs(db, v.job, h.job, admin);
  linkTournamentGame(db, h.job, { tournament_game_id: gameHV }, admin);
  assert.equal(db.prepare('SELECT tournament_game_id FROM cmd_jobs WHERE id = ?').get(v.job).tournament_game_id, gameHV, 'the paired job follows');
  assert.ok(entryGames(vice, vEntry).some(r => r.game_id === v.game), "Vice's player counts for Vice");
  assert.ok(!entryGames(huskers, hEntry).some(r => r.game_id === v.game));
  unlinkTournamentGame(db, v.job, admin);
  assert.equal(db.prepare('SELECT tournament_game_id FROM cmd_jobs WHERE id = ?').get(h.job).tournament_game_id, null, 'and unlinks with it');
});
