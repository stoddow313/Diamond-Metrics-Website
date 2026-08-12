// Aggregate-engine acceptance tests: attribution rules, null preservation,
// standings math, leaderboard minimums, and the no-averaging-of-overalls rule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-agg-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const {
  attributedGames, sumBox, deriveRates, standings,
  aggregateByPlayer, leaderboard, overallLeaderboard, trendSeries, DEFAULT_MINS,
} = await import('./aggregates.js');

let team, rival, tournament, entry, rivalEntry, season;
const P = {};

function addGame(playerId, date, stats, type = 'game') {
  const gid = db.prepare(`INSERT INTO games (player_id, game_date, game_type, opponent) VALUES (?, ?, ?, 'Opp')`)
    .run(playerId, date, type).lastInsertRowid;
  for (const [k, v] of Object.entries(stats)) {
    db.prepare('INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, ?, ?)').run(gid, k, v);
  }
  return gid;
}

before(() => {
  const org = db.prepare(`INSERT INTO organizations (name) VALUES ('Org')`).run().lastInsertRowid;
  team = { id: db.prepare(`INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Miners', 'miners')`).run(org).lastInsertRowid };
  rival = { id: db.prepare(`INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Chargers', 'chargers')`).run(org).lastInsertRowid };
  season = db.prepare(`INSERT INTO seasons (label, start_date, end_date) VALUES ('2026 Summer', '2026-05-01', '2026-08-15')`).run().lastInsertRowid;

  tournament = db.prepare(`INSERT INTO tournaments (name, slug, start_date, end_date) VALUES ('Cup', 'cup', '2026-06-10', '2026-06-12')`).run().lastInsertRowid;
  const division = db.prepare(`INSERT INTO divisions (tournament_id, name) VALUES (?, '16U')`).run(tournament).lastInsertRowid;
  entry = db.prepare(`INSERT INTO tournament_entries (tournament_id, division_id, team_id, seed) VALUES (?, ?, ?, 1)`).run(tournament, division, team.id).lastInsertRowid;
  rivalEntry = db.prepare(`INSERT INTO tournament_entries (tournament_id, division_id, team_id, seed) VALUES (?, ?, ?, 2)`).run(tournament, division, rival.id).lastInsertRowid;

  // Shared games: two finals (split) + one scheduled → coverage 2/3.
  db.prepare(`INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, home_score, away_score, status)
              VALUES (?, ?, ?, ?, '2026-06-10', 7, 3, 'final')`).run(tournament, division, entry, rivalEntry);
  db.prepare(`INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, home_score, away_score, status)
              VALUES (?, ?, ?, ?, '2026-06-11', 2, 5, 'final')`).run(tournament, division, rivalEntry, entry);
  db.prepare(`INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, status)
              VALUES (?, ?, ?, ?, '2026-06-12', 'scheduled')`).run(tournament, division, entry, rivalEntry);

  const mk = (slug, pos) => db.prepare(`INSERT INTO players (slug, first_name, last_name, primary_position) VALUES (?, ?, 'Test', ?)`)
    .run(slug, slug, pos).lastInsertRowid;
  P.hitter = mk('hitter', 'SS');
  P.slugger = mk('slugger', '1B');
  P.pitcher = mk('pitcher', 'RHP');
  P.guest = mk('guest', 'CF');
  P.former = mk('former', '2B');

  // Memberships: three on the roster all season; 'former' ended in May.
  for (const pid of [P.hitter, P.slugger, P.pitcher]) {
    db.prepare(`INSERT INTO roster_memberships (player_id, team_id, season_id, start_date) VALUES (?, ?, ?, '2026-05-01')`).run(pid, team.id, season);
  }
  db.prepare(`INSERT INTO roster_memberships (player_id, team_id, season_id, start_date, end_date) VALUES (?, ?, ?, '2026-05-01', '2026-05-20')`)
    .run(P.former, team.id, season);

  // Event roster: the three + a labeled guest ('former' NOT on it).
  for (const [pid, g] of [[P.hitter, 0], [P.slugger, 0], [P.pitcher, 0], [P.guest, 1]]) {
    db.prepare('INSERT INTO event_rosters (entry_id, player_id, is_guest) VALUES (?, ?, ?)').run(entry, pid, g);
  }

  // In-window games (June 10-11).
  addGame(P.hitter, '2026-06-10', { bs_pa: 4, bs_ab: 4, bs_h: 3, bs_2b: 1, bs_hr: 1, bs_bb: 0, bs_k: 1, bs_sb: 1, avg_exit_velo: 88, max_exit_velo: 99, home_to_first: 4.35 });
  addGame(P.hitter, '2026-06-11', { bs_pa: 4, bs_ab: 3, bs_h: 1, bs_bb: 1, bs_k: 0, avg_exit_velo: 84, max_exit_velo: 95, home_to_first: 4.30 });
  addGame(P.slugger, '2026-06-10', { bs_pa: 4, bs_ab: 4, bs_h: 2, bs_hr: 2, bs_k: 2, avg_exit_velo: 92, max_exit_velo: 103 });
  addGame(P.slugger, '2026-06-11', { bs_pa: 3, bs_ab: 3, bs_h: 0, bs_k: 2, avg_exit_velo: 85, max_exit_velo: 97 });
  addGame(P.guest, '2026-06-10', { bs_pa: 4, bs_ab: 4, bs_h: 2, avg_exit_velo: 86, max_exit_velo: 94, home_to_first: 4.10 });
  addGame(P.pitcher, '2026-06-11', { bs_ip: 4, bs_kp: 6, bs_bba: 1, strike_pct: 68, max_velo: 84, avg_velo: 80 });
  // Pro Day inside the window — must stay out of game aggregates.
  addGame(P.hitter, '2026-06-11', { max_exit_velo: 105 }, 'pro_day');
  // Out-of-window game (season, not tournament).
  addGame(P.hitter, '2026-07-01', { bs_pa: 5, bs_ab: 5, bs_h: 5, bs_2b: 2, avg_exit_velo: 90 });
  // 'former' plays after leaving the roster — must not attribute to the team.
  addGame(P.former, '2026-06-10', { bs_pa: 4, bs_ab: 4, bs_h: 4 });
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

function tournamentAttribution() {
  const e = db.prepare('SELECT te.*, tr.start_date, tr.end_date FROM tournament_entries te JOIN tournaments tr ON tr.id = te.tournament_id WHERE te.id = ?').get(entry);
  return attributedGames(db, team, { entry: e });
}

test('tournament attribution: event roster decides, window applies, pro day excluded', () => {
  const rows = tournamentAttribution();
  const byPlayer = new Set(rows.map(r => r.player.slug));
  assert.ok(byPlayer.has('guest'), 'guest on event roster is attributed');
  assert.ok(!byPlayer.has('former'), 'player not on event roster is excluded');
  assert.ok(rows.every(r => r.game_date >= '2026-06-10' && r.game_date <= '2026-06-12'), 'window enforced');
  assert.ok(rows.every(r => r.game_type !== 'pro_day'), 'pro day stays separate');
  const guestRow = rows.find(r => r.player.slug === 'guest');
  assert.equal(guestRow.player.isGuest, true, 'guests keep their label');
});

test('season attribution: membership must cover the game day', () => {
  const rows = attributedGames(db, team, { seasonId: season });
  const formerRows = rows.filter(r => r.player.slug === 'former');
  assert.equal(formerRows.length, 0, 'game after membership end never counts');
  const hitterDates = rows.filter(r => r.player.slug === 'hitter').map(r => r.game_date);
  assert.ok(hitterDates.includes('2026-07-01'), 'season view includes non-tournament games');
});

test('box sums and derived rates preserve nulls (never zero)', () => {
  const box = sumBox([{ stats: { bs_ab: 4, bs_h: 2 } }, { stats: { bs_ab: 3, bs_h: 1 } }]);
  assert.equal(box.bs_pa, null, 'metric never logged stays null');
  const rates = deriveRates(box);
  assert.equal(rates.obp, null, 'OBP unknown without PA');
  assert.equal(rates.avg, 3 / 7);
  assert.equal(rates.k_bb, null, 'no walks logged → null, not division by zero');
});

test('standings: W-L-T, win %, runs, differential, coverage', () => {
  const rows = standings(db, tournament);
  const miners = rows.find(r => r.team_slug === 'miners');
  const chargers = rows.find(r => r.team_slug === 'chargers');
  assert.deepEqual([miners.wins, miners.losses, miners.ties], [2, 0, 0]);
  assert.equal(miners.win_pct, 1);
  assert.equal(miners.runs_scored, 12);
  assert.equal(miners.runs_allowed, 5);
  assert.equal(miners.run_diff, 7);
  assert.deepEqual([miners.games_final, miners.games_total], [2, 3]);
  assert.deepEqual([chargers.wins, chargers.losses], [0, 2]);
  assert.equal(rows[0].team_slug, 'miners', 'sorted by win % first');
});

test('leaderboards: ranked, sampled, limited-labeled below qualified', () => {
  const aggs = aggregateByPlayer(tournamentAttribution());
  const board = leaderboard(aggs, 'hitting', { ...DEFAULT_MINS, pa: 6 });
  assert.equal(board.metric.key, 'ops');
  const qualified = board.rows.filter(r => !r.limited);
  const limited = board.rows.filter(r => r.limited);
  assert.ok(qualified.length >= 2 && limited.length >= 1, 'guest with 4 PA is limited');
  assert.ok(limited.every(r => r.rank > qualified.length), 'limited ranks after qualified');
  assert.ok(board.rows.every(r => r.sample > 0), 'sample sizes present');

  const speed = leaderboard(aggs, 'speed', DEFAULT_MINS);
  assert.equal(speed.metric.key, 'home_to_first');
  assert.equal(speed.metric.lowerIsBetter, true);
  const q = speed.rows.filter(r => !r.limited);
  assert.ok(q.every((r, i) => i === 0 || r.value >= q[i - 1].value), 'lower-is-better sorts ascending');
});

test('overall board rates event-relative from game metrics, never stored overalls', () => {
  const aggs = aggregateByPlayer(tournamentAttribution());
  const board = overallLeaderboard(aggs, DEFAULT_MINS);
  assert.ok(board.rows.length >= 2, 'players with 3+ rated metrics rank');
  assert.ok(board.rows.every(r => r.value >= 40 && r.value <= 95), 'Pro Day 40-95 scale');
  assert.ok(board.rows.every(r => r.metrics_rated >= 3));
  assert.match(board.note, /not an average of Pro Day overalls/);
});

test('trend series aggregates per date and skips missing values', () => {
  const rows = attributedGames(db, team, { seasonId: season, playerId: P.hitter });
  const ev = trendSeries(rows, 'avg_exit_velo');
  assert.deepEqual(ev.map(p => p.date), ['2026-06-10', '2026-06-11', '2026-07-01']);
  const hits = trendSeries(rows, 'bs_h');
  assert.equal(hits.find(p => p.date === '2026-07-01').value, 5, 'sum metrics sum per date');
  const missing = trendSeries(rows, 'pop_time');
  assert.equal(missing.length, 0, 'unlogged metric yields no fabricated points');
});
