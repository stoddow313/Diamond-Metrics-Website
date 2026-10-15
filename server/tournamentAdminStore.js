// Tournament admin corrections — data access. Rules live in
// tournamentAdminLogic.js; routes in tournamentAdminRoutes.js. Event records
// are the tournament, its divisions, team entries (with event rosters) and
// games (with lineup appearances). Teams and players are shared records and
// are never written here.
import { assessRecord, stageLabel } from './tournamentAdminLogic.js';
import { slugify } from './rosterLogic.js';
import { randomBytes } from 'node:crypto';

export class AdminRecordError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => { throw new AdminRecordError(status, message, extra); };

const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;

const RECORD_SQL = {
  tournament: 'SELECT * FROM tournaments WHERE id = ?',
  division: 'SELECT * FROM divisions WHERE id = ?',
  entry: `SELECT te.*, t.name AS team_name, d.name AS division_name
            FROM tournament_entries te JOIN teams t ON t.id = te.team_id JOIN divisions d ON d.id = te.division_id
           WHERE te.id = ?`,
  game: `SELECT tg.*, d.name AS division_name, ht.name AS home_team_name, at.name AS away_team_name
           FROM tournament_games tg JOIN divisions d ON d.id = tg.division_id
           JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
           JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
          WHERE tg.id = ?`,
};

export function loadRecord(db, kind, id) {
  if (!Object.hasOwn(RECORD_SQL, kind)) fail(400, `Unknown record kind: ${kind}`);
  return db.prepare(RECORD_SQL[kind]).get(id) || null;
}

export function recordLabel(kind, row) {
  if (kind === 'entry') return `${row.team_name} · ${row.division_name}`;
  if (kind === 'game') return `${row.game_date}${row.game_time ? ` ${row.game_time}` : ''} · ${row.home_team_name} vs ${row.away_team_name}`;
  return row.name;
}

const tournamentOf = (kind, row) => (kind === 'tournament' ? row.id : row.tournament_id);

// The counts assessRecord() judges.
export function recordCounts(db, kind, row) {
  const gamesOf = 'SELECT id FROM tournament_games WHERE tournament_id = ?';
  if (kind === 'tournament') {
    const t = row.id;
    return {
      divisions: count(db, 'SELECT COUNT(*) c FROM divisions WHERE tournament_id = ?', t),
      entries: count(db, 'SELECT COUNT(*) c FROM tournament_entries WHERE tournament_id = ?', t),
      games: count(db, 'SELECT COUNT(*) c FROM tournament_games WHERE tournament_id = ?', t),
      final_games: count(db, "SELECT COUNT(*) c FROM tournament_games WHERE tournament_id = ? AND status = 'final' AND home_score IS NOT NULL", t),
      roster_rows: count(db, 'SELECT COUNT(*) c FROM event_rosters er JOIN tournament_entries te ON te.id = er.entry_id WHERE te.tournament_id = ?', t),
      appearances: count(db, 'SELECT COUNT(*) c FROM player_game_appearances a JOIN tournament_games tg ON tg.id = a.tournament_game_id WHERE tg.tournament_id = ?', t),
      command_jobs: count(db, `SELECT COUNT(*) c FROM cmd_jobs WHERE tournament_id = ? OR tournament_game_id IN (${gamesOf})`, t, t),
      intake_submissions: count(db, `SELECT COUNT(*) c FROM intake_submissions WHERE tournament_game_id IN (${gamesOf})`, t),
      player_games: count(db, `SELECT COUNT(*) c FROM games WHERE tournament_game_id IN (${gamesOf})`, t),
      directors: count(db, 'SELECT COUNT(*) c FROM tournament_users WHERE tournament_id = ?', t),
    };
  }
  if (kind === 'division') {
    return {
      entries: count(db, 'SELECT COUNT(*) c FROM tournament_entries WHERE division_id = ?', row.id),
      games: count(db, 'SELECT COUNT(*) c FROM tournament_games WHERE division_id = ?', row.id),
    };
  }
  if (kind === 'entry') {
    const mine = '(home_entry_id = ? OR away_entry_id = ?)';
    return {
      status: row.status,
      games: count(db, `SELECT COUNT(*) c FROM tournament_games WHERE ${mine}`, row.id, row.id),
      active_games: count(db, `SELECT COUNT(*) c FROM tournament_games WHERE ${mine} AND archived_at IS NULL`, row.id, row.id),
      archived_games: count(db, `SELECT COUNT(*) c FROM tournament_games WHERE ${mine} AND archived_at IS NOT NULL`, row.id, row.id),
      scheduled_games: count(db, `SELECT COUNT(*) c FROM tournament_games WHERE ${mine} AND archived_at IS NULL AND status = 'scheduled'`, row.id, row.id),
      appearances: count(db, 'SELECT COUNT(*) c FROM player_game_appearances WHERE entry_id = ?', row.id),
      roster_rows: count(db, 'SELECT COUNT(*) c FROM event_rosters WHERE entry_id = ?', row.id),
    };
  }
  return {
    appearances: count(db, 'SELECT COUNT(*) c FROM player_game_appearances WHERE tournament_game_id = ?', row.id),
    command_jobs: count(db, 'SELECT COUNT(*) c FROM cmd_jobs WHERE tournament_game_id = ?', row.id),
    intake_submissions: count(db, 'SELECT COUNT(*) c FROM intake_submissions WHERE tournament_game_id = ?', row.id),
    player_games: count(db, 'SELECT COUNT(*) c FROM games WHERE tournament_game_id = ?', row.id),
    has_score: row.home_score != null || row.away_score != null,
  };
}

// The dependency summary the admin sees before withdrawing, archiving or deleting.
export function dependencies(db, kind, id) {
  const row = loadRecord(db, kind, id);
  if (!row) return null;
  const counts = recordCounts(db, kind, row);
  return { kind, id: row.id, label: recordLabel(kind, row), counts, actions: assessRecord(kind, counts) };
}

// ── Public URL: a renamed slug keeps answering at the old one ────────────
export function resolveTournamentSlug(db, slug) {
  return db.prepare('SELECT * FROM tournaments WHERE slug = ?').get(slug)
    || db.prepare('SELECT t.* FROM tournament_slug_aliases a JOIN tournaments t ON t.id = a.tournament_id WHERE a.slug = ?').get(slug)
    || null;
}

const slugTaken = (db, slug) => !!(db.prepare('SELECT 1 FROM tournaments WHERE slug = ?').get(slug)
  || db.prepare('SELECT 1 FROM tournament_slug_aliases WHERE slug = ?').get(slug));

// A new tournament's slug, never one an older URL still answers to.
export function freeTournamentSlug(db, name) {
  const base = slugify(name) || 'tournament';
  let slug = base;
  while (slugTaken(db, slug)) slug = `${base}-${randomBytes(2).toString('hex')}`;
  return slug;
}

// Changes the public URL; the old one becomes an alias. Switching back to an
// earlier URL of the same tournament reclaims that alias.
export function changeTournamentSlug(db, tournament, slug) {
  if (slug === tournament.slug) return;
  if (db.prepare('SELECT 1 FROM tournaments WHERE slug = ? AND id != ?').get(slug, tournament.id)) fail(409, 'Another tournament uses that URL.');
  const alias = db.prepare('SELECT tournament_id FROM tournament_slug_aliases WHERE slug = ?').get(slug);
  if (alias && alias.tournament_id !== tournament.id) fail(409, 'Another tournament’s old link still uses that URL. Pick a different one.');
  if (alias) db.prepare('DELETE FROM tournament_slug_aliases WHERE slug = ?').run(slug);
  db.prepare('INSERT OR IGNORE INTO tournament_slug_aliases (slug, tournament_id) VALUES (?, ?)').run(tournament.slug, tournament.id);
  db.prepare('UPDATE tournaments SET slug = ? WHERE id = ?').run(slug, tournament.id);
}

export const tournamentAliases = (db, tournamentId) =>
  db.prepare('SELECT slug, created_at FROM tournament_slug_aliases WHERE tournament_id = ? ORDER BY created_at DESC').all(tournamentId);

// ── Admin detail: everything the editor shows ────────────────────────────
export function tournamentDetail(db, tournament) {
  const divisions = db.prepare(
    `SELECT d.*,
            (SELECT COUNT(*) FROM tournament_entries te WHERE te.division_id = d.id) AS entry_count,
            (SELECT COUNT(*) FROM tournament_games tg WHERE tg.division_id = d.id) AS game_count
       FROM divisions d WHERE d.tournament_id = ? ORDER BY d.age_group, d.name`
  ).all(tournament.id);
  const entries = db.prepare(
    `SELECT te.*, t.name AS team_name, t.slug AS team_slug, d.name AS division_name,
            (SELECT COUNT(*) FROM event_rosters er WHERE er.entry_id = te.id) AS event_roster_count,
            (SELECT COUNT(*) FROM tournament_games tg WHERE (tg.home_entry_id = te.id OR tg.away_entry_id = te.id) AND tg.archived_at IS NULL) AS game_count
       FROM tournament_entries te
       JOIN teams t ON t.id = te.team_id
       JOIN divisions d ON d.id = te.division_id
      WHERE te.tournament_id = ? ORDER BY d.age_group, d.name, t.name`
  ).all(tournament.id);
  const games = db.prepare(
    `SELECT tg.*, d.name AS division_name,
            ht.name AS home_team_name, at.name AS away_team_name,
            he.division_id AS home_division_id, ae.division_id AS away_division_id
       FROM tournament_games tg
       JOIN divisions d ON d.id = tg.division_id
       JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
       JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
      WHERE tg.tournament_id = ? ORDER BY tg.game_date, tg.game_time, tg.id`
  ).all(tournament.id).map(g => ({
    ...g,
    stage_label: stageLabel(g.stage),
    // A game outside its teams' division usually means a team was moved and the game was not.
    division_mismatch: g.home_division_id !== g.division_id || g.away_division_id !== g.division_id,
  }));
  return { tournament, aliases: tournamentAliases(db, tournament.id), divisions, entries, games };
}

// ── Move an entry: same entry id, same event roster ──────────────────────
// A game follows the entry when its other team is already in the new
// division; the rest stay put and are reported.
export function moveEntry(db, entryId, divisionId) {
  const entry = loadRecord(db, 'entry', entryId);
  if (!entry) fail(404, 'Entry not found');
  const division = db.prepare('SELECT * FROM divisions WHERE id = ?').get(divisionId);
  if (!division || division.tournament_id !== entry.tournament_id) fail(400, 'Choose a division of this tournament.');
  if (division.id === entry.division_id) fail(400, `${entry.team_name} is already in ${division.name}.`);
  const clash = db.prepare('SELECT status FROM tournament_entries WHERE division_id = ? AND team_id = ?').get(division.id, entry.team_id);
  if (clash) fail(409, `${entry.team_name} already has a${clash.status === 'active' ? 'n' : ` ${clash.status}`} entry in ${division.name}. Remove one of the two entries first.`);

  return db.transaction(() => {
    db.prepare('UPDATE tournament_entries SET division_id = ? WHERE id = ?').run(division.id, entry.id);
    const games = db.prepare(
      `SELECT tg.id, tg.division_id, CASE WHEN tg.home_entry_id = ? THEN ae.division_id ELSE he.division_id END AS other_division_id
         FROM tournament_games tg
         JOIN tournament_entries he ON he.id = tg.home_entry_id
         JOIN tournament_entries ae ON ae.id = tg.away_entry_id
        WHERE tg.home_entry_id = ? OR tg.away_entry_id = ?`
    ).all(entry.id, entry.id, entry.id);
    const follow = games.filter(g => g.other_division_id === division.id && g.division_id !== division.id);
    const setDivision = db.prepare('UPDATE tournament_games SET division_id = ? WHERE id = ?');
    for (const g of follow) setDivision.run(division.id, g.id);
    const left = games.filter(g => g.division_id !== division.id && !follow.includes(g)).length;
    return { entry: loadRecord(db, 'entry', entry.id), games_moved: follow.length, games_left: left, from_division: entry.division_name };
  })();
}

// ── Merge one division into another (14U Gold → 14U, games marked Gold) ──
export function mergeDivision(db, fromId, intoId, stage = null) {
  const from = db.prepare('SELECT * FROM divisions WHERE id = ?').get(fromId);
  const into = db.prepare('SELECT * FROM divisions WHERE id = ?').get(intoId);
  if (!from) fail(404, 'Division not found');
  if (!into || into.tournament_id !== from.tournament_id) fail(400, 'Choose a division of this tournament.');
  if (into.id === from.id) fail(400, 'Choose a different division.');
  const clashes = db.prepare(
    `SELECT t.name FROM tournament_entries a JOIN tournament_entries b ON b.team_id = a.team_id AND b.division_id = ?
       JOIN teams t ON t.id = a.team_id WHERE a.division_id = ? ORDER BY t.name`
  ).all(into.id, from.id).map(r => r.name);
  if (clashes.length) fail(409, `Already entered in ${into.name}: ${clashes.join(', ')}. Remove one entry for each first.`, { teams: clashes });

  return db.transaction(() => {
    const staged = stage
      ? db.prepare('UPDATE tournament_games SET stage = ? WHERE division_id = ? AND stage IS NULL').run(stage, from.id).changes
      : 0;
    const entries = db.prepare('UPDATE tournament_entries SET division_id = ? WHERE division_id = ?').run(into.id, from.id).changes;
    const games = db.prepare('UPDATE tournament_games SET division_id = ? WHERE division_id = ?').run(into.id, from.id).changes;
    db.prepare('DELETE FROM divisions WHERE id = ?').run(from.id);
    return { entries_moved: entries, games_moved: games, games_staged: staged, removed: from.name, into: into.name };
  })();
}

// ── Archive / restore ────────────────────────────────────────────────────
export function setArchived(db, kind, id, archived) {
  const dep = dependencies(db, kind, id);
  if (!dep) fail(404, 'Not found');
  if (kind === 'tournament') {
    db.prepare('UPDATE tournaments SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, new Date().toISOString(), id);
  } else if (kind === 'entry') {
    if (archived && !dep.actions.archive.allowed) fail(409, dep.actions.archive.blockers[0], { dependencies: dep });
    db.prepare('UPDATE tournament_entries SET status = ? WHERE id = ?').run(archived ? 'archived' : 'active', id);
  } else if (kind === 'game') {
    db.prepare("UPDATE tournament_games SET archived_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?").run(archived ? 1 : 0, id);
  } else {
    fail(400, 'Divisions are not archived — delete an empty division or merge it into another.');
  }
  return loadRecord(db, kind, id);
}

// ── Delete with a restorable snapshot ────────────────────────────────────
// Insert order; deletes run in reverse. Teams and players are never included.
const SNAPSHOT = {
  tournament: [
    ['tournaments', 'SELECT * FROM tournaments WHERE id = ?'],
    ['tournament_slug_aliases', 'SELECT * FROM tournament_slug_aliases WHERE tournament_id = ?'],
    ['tournament_users', 'SELECT * FROM tournament_users WHERE tournament_id = ?'],
    ['divisions', 'SELECT * FROM divisions WHERE tournament_id = ?'],
    ['tournament_entries', 'SELECT * FROM tournament_entries WHERE tournament_id = ?'],
    ['event_rosters', 'SELECT er.* FROM event_rosters er JOIN tournament_entries te ON te.id = er.entry_id WHERE te.tournament_id = ?'],
    ['tournament_games', 'SELECT * FROM tournament_games WHERE tournament_id = ?'],
    ['player_game_appearances', 'SELECT a.* FROM player_game_appearances a JOIN tournament_games tg ON tg.id = a.tournament_game_id WHERE tg.tournament_id = ?'],
  ],
  division: [['divisions', 'SELECT * FROM divisions WHERE id = ?']],
  entry: [
    ['tournament_entries', 'SELECT * FROM tournament_entries WHERE id = ?'],
    ['event_rosters', 'SELECT * FROM event_rosters WHERE entry_id = ?'],
  ],
  game: [
    ['tournament_games', 'SELECT * FROM tournament_games WHERE id = ?'],
    ['player_game_appearances', 'SELECT * FROM player_game_appearances WHERE tournament_game_id = ?'],
  ],
};
const SNAPSHOT_TABLES = new Set(Object.values(SNAPSHOT).flat().map(([table]) => table));
const KEY = table => (table === 'tournament_slug_aliases' ? 'slug' : 'id');

export function deleteRecord(db, kind, id, adminId = null) {
  const dep = dependencies(db, kind, id);
  if (!dep) fail(404, 'Not found');
  if (!dep.actions.delete.allowed) fail(409, dep.actions.delete.blockers[0], { dependencies: dep });
  const row = loadRecord(db, kind, id);
  return db.transaction(() => {
    const snapshot = SNAPSHOT[kind].map(([table, sql]) => [table, db.prepare(sql).all(id)]);
    for (const [table, rows] of [...snapshot].reverse()) {
      const del = db.prepare(`DELETE FROM ${table} WHERE ${KEY(table)} = ?`);
      for (const r of rows) del.run(r[KEY(table)]);
    }
    const info = db.prepare(
      'INSERT INTO event_trash (kind, record_id, tournament_id, label, snapshot, deleted_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(kind, id, tournamentOf(kind, row), dep.label, JSON.stringify(snapshot), adminId);
    return { trash_id: info.lastInsertRowid, label: dep.label };
  })();
}

// Recently deleted: inside a tournament its divisions, entries and games;
// otherwise whole tournaments.
export function listTrash(db, { tournamentId = null } = {}) {
  const rows = tournamentId
    ? db.prepare("SELECT * FROM event_trash WHERE tournament_id = ? AND kind != 'tournament' AND restored_at IS NULL ORDER BY deleted_at DESC, id DESC LIMIT 50").all(tournamentId)
    : db.prepare("SELECT * FROM event_trash WHERE kind = 'tournament' AND restored_at IS NULL ORDER BY deleted_at DESC, id DESC LIMIT 50").all();
  const names = new Map(db.prepare('SELECT id, name FROM admins').all().map(a => [a.id, a.name]));
  return rows.map(({ snapshot, ...r }) => ({
    ...r,
    deleted_by_name: names.get(r.deleted_by) || null,
    contents: JSON.parse(snapshot).map(([table, list]) => ({ table, rows: list.length })).filter(c => c.rows),
  }));
}

export function restoreTrash(db, trashId) {
  const item = db.prepare('SELECT * FROM event_trash WHERE id = ?').get(trashId);
  if (!item) fail(404, 'Not found');
  if (item.restored_at) fail(409, 'That record was already restored.');
  const snapshot = JSON.parse(item.snapshot);
  try {
    db.transaction(() => {
      for (const [table, rows] of snapshot) {
        if (!SNAPSHOT_TABLES.has(table)) throw new Error(`Unexpected table in snapshot: ${table}`);
        for (const r of rows) {
          const cols = Object.keys(r);
          db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(r);
        }
      }
      db.prepare("UPDATE event_trash SET restored_at = datetime('now') WHERE id = ?").run(item.id);
    })();
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      fail(409, `Can’t restore ${item.label}: something it belongs to was deleted since (its tournament, division, team or a player). Restore that first.`);
    }
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      fail(409, `Can’t restore ${item.label}: it clashes with a record created since (the same team entered again in that division, or its URL now used by another tournament).`);
    }
    throw err;
  }
  return { kind: item.kind, record_id: item.record_id, tournament_id: item.tournament_id, label: item.label };
}
