// Player deletion must remove every dependent record in one transaction —
// including the team/tournament tables that have no ON DELETE CASCADE
// (the gap that made the admin delete 500 after failed imports).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-delete-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db, hashPassword } = await import('./db.js');
const { deletePlayers } = await import('./playerDelete.js');

let doomed, keeper;

before(() => {
  // Two players with identical full dependency graphs; only one gets deleted.
  const org = db.prepare(`INSERT INTO organizations (name) VALUES ('Org')`).run().lastInsertRowid;
  const team = db.prepare(`INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')`).run(org).lastInsertRowid;
  const season = db.prepare(`INSERT INTO seasons (label, start_date, end_date) VALUES ('S', '2026-01-01', '2026-12-31')`).run().lastInsertRowid;
  const tournament = db.prepare(`INSERT INTO tournaments (name, slug, start_date, end_date) VALUES ('T', 't', '2026-06-01', '2026-06-03')`).run().lastInsertRowid;
  const division = db.prepare(`INSERT INTO divisions (tournament_id, name) VALUES (?, 'D')`).run(tournament).lastInsertRowid;
  const entry = db.prepare(`INSERT INTO tournament_entries (tournament_id, division_id, team_id) VALUES (?, ?, ?)`).run(tournament, division, team).lastInsertRowid;
  const tGame = db.prepare(
    `INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date) VALUES (?, ?, ?, ?, '2026-06-01')`
  ).run(tournament, division, entry, entry).lastInsertRowid;

  const makePlayer = slug => {
    const id = db.prepare(`INSERT INTO players (slug, first_name, last_name) VALUES (?, 'P', ?)`).run(slug, slug).lastInsertRowid;
    const game = db.prepare(`INSERT INTO games (player_id, game_date, game_type) VALUES (?, '2026-06-01', 'game')`).run(id).lastInsertRowid;
    db.prepare(`INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, 'bs_h', 2)`).run(game);
    db.prepare(`INSERT INTO roster_memberships (player_id, team_id, season_id, start_date) VALUES (?, ?, ?, '2026-01-01')`).run(id, team, season);
    db.prepare(`INSERT INTO event_rosters (entry_id, player_id) VALUES (?, ?)`).run(entry, id);
    db.prepare(`INSERT INTO player_game_appearances (tournament_game_id, player_id, entry_id) VALUES (?, ?, ?)`).run(tGame, id, entry);
    db.prepare(`INSERT INTO player_ratings (player_id, payload) VALUES (?, '{}')`).run(id);
    db.prepare(`INSERT INTO invites (token, player_id, expires_at) VALUES (?, ?, '2027-01-01')`).run(`tok-${slug}`, id);
    const user = db.prepare(`INSERT INTO player_users (player_id, email, password_hash) VALUES (?, ?, ?)`)
      .run(id, `${slug}@x.com`, hashPassword('pw')).lastInsertRowid;
    db.prepare(`INSERT INTO player_sessions (token, player_user_id, expires_at) VALUES (?, ?, '2027-01-01')`).run(`sess-${slug}`, user);
    return id;
  };
  doomed = makePlayer('doomed');
  keeper = makePlayer('keeper');
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const countsFor = id => ({
  players: db.prepare('SELECT COUNT(*) c FROM players WHERE id = ?').get(id).c,
  games: db.prepare('SELECT COUNT(*) c FROM games WHERE player_id = ?').get(id).c,
  stats: db.prepare('SELECT COUNT(*) c FROM stat_entries WHERE game_id IN (SELECT id FROM games WHERE player_id = ?)').get(id).c,
  memberships: db.prepare('SELECT COUNT(*) c FROM roster_memberships WHERE player_id = ?').get(id).c,
  eventRosters: db.prepare('SELECT COUNT(*) c FROM event_rosters WHERE player_id = ?').get(id).c,
  appearances: db.prepare('SELECT COUNT(*) c FROM player_game_appearances WHERE player_id = ?').get(id).c,
  ratings: db.prepare('SELECT COUNT(*) c FROM player_ratings WHERE player_id = ?').get(id).c,
  invites: db.prepare('SELECT COUNT(*) c FROM invites WHERE player_id = ?').get(id).c,
  users: db.prepare('SELECT COUNT(*) c FROM player_users WHERE player_id = ?').get(id).c,
  sessions: db.prepare(
    'SELECT COUNT(*) c FROM player_sessions WHERE player_user_id IN (SELECT id FROM player_users WHERE player_id = ?)'
  ).get(id).c,
});

test('delete removes the player and every dependent record, others untouched', () => {
  // Both players fully wired before the delete.
  assert.ok(Object.values(countsFor(doomed)).every(c => c === 1));
  assert.ok(Object.values(countsFor(keeper)).every(c => c === 1));

  const deleted = deletePlayers(db, [doomed]);
  assert.equal(deleted, 1);

  assert.ok(Object.values(countsFor(doomed)).every(c => c === 0)); // nothing orphaned
  assert.ok(Object.values(countsFor(keeper)).every(c => c === 1)); // neighbor intact

  // Shared rows (team, tournament, game) survive — only player-scoped data goes.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tournament_games').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams').get().c, 1);
});

test('bulk delete is transactional and reports the count', () => {
  const a = db.prepare(`INSERT INTO players (slug, first_name, last_name) VALUES ('bulk-a', 'A', 'A')`).run().lastInsertRowid;
  const b = db.prepare(`INSERT INTO players (slug, first_name, last_name) VALUES ('bulk-b', 'B', 'B')`).run().lastInsertRowid;
  assert.equal(deletePlayers(db, [a, b]), 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM players WHERE id IN (?, ?)').get(a, b).c, 0);
});

// Regression: Command (Phase 1) added player references in cmd_metric_results,
// cmd_events/cmd_measurements, and cmd_radar_readings. Before these were part
// of the cascade, deleting any athlete who had been through the analysis
// pipeline aborted with a FOREIGN KEY error — the same 500 the admin UI hit
// before the original cascade fix.
test('deletes a player who has Command results, attempts, and radar readings', () => {
  const pid = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('cmd-del','C','D')").run().lastInsertRowid;
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('O2')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'T2', 't2')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'R')").run().lastInsertRowid;
  const sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-21', ?)").run(sport, team, order).lastInsertRowid;
  const feed = db.prepare("INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, effective_fps) VALUES (?, 'BH', 'k', 'f.mp4', 'ready', 60)").run(job).lastInsertRowid;
  const evt = db.prepare("INSERT INTO cmd_events (job_id, sequence, event_type, player_id, payload, selected_feed_id) VALUES (?, 1, 'running_attempt', ?, '{}', ?)").run(job, pid, feed).lastInsertRowid;
  db.prepare("INSERT INTO cmd_measurements (event_id, start_frame, end_frame, fps_used, elapsed_s, validity, formula_version) VALUES (?, 60, 332, 60, 4.533, 'valid', 'CMD_MEASURE_V1')").run(evt);
  db.prepare("INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, method, evidence_kind) VALUES (?, 'home_to_first', ?, 4.533, 'frame_timed', 'measurement')").run(job, pid);
  const reading = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, player_id, status) VALUES (?, 'manual', 73.6, ?, 'matched')").run(job, pid).lastInsertRowid;

  assert.equal(deletePlayers(db, [pid]), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_metric_results WHERE player_id = ?').get(pid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_events WHERE player_id = ?').get(pid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cmd_measurements WHERE event_id = ?').get(evt).n, 0);

  // The radar reading survives, unlinked — captured evidence is not destroyed
  // just because a player record was removed.
  const kept = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(reading);
  assert.ok(kept, 'radar reading retained');
  assert.equal(kept.player_id, null);
  assert.equal(kept.status, 'unmatched');
  assert.equal(kept.velocity, 73.6);
});
