import Database from 'better-sqlite3';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DM_DB_PATH || path.join(__dirname, 'data', 'diamond-metrics.db');

import fs from 'node:fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Player photo uploads live next to the database, so in production they sit
// on the same persistent disk and survive deploys.
export const UPLOADS_DIR = process.env.DM_UPLOADS_DIR || path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    slug               TEXT NOT NULL UNIQUE,
    first_name         TEXT NOT NULL,
    last_name          TEXT NOT NULL,
    school             TEXT DEFAULT '',
    city               TEXT DEFAULT '',
    state              TEXT DEFAULT '',
    grad_year          INTEGER,
    primary_position   TEXT DEFAULT '',
    secondary_position TEXT DEFAULT '',
    height             TEXT DEFAULT '',
    weight_lbs         INTEGER,
    bats               TEXT DEFAULT '',
    throws             TEXT DEFAULT '',
    committed_to       TEXT DEFAULT '',
    college_projection TEXT DEFAULT '',
    overall_rating     INTEGER,
    photo_url          TEXT DEFAULT '',
    -- attribute ratings, 0-100
    attr_power         INTEGER,
    attr_contact       INTEGER,
    attr_speed         INTEGER,
    attr_arm           INTEGER,
    attr_defense       INTEGER,
    attr_athleticism   INTEGER,
    is_public          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_date  TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
    game_type  TEXT NOT NULL DEFAULT 'game',
    opponent   TEXT DEFAULT '',
    location   TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_games_player ON games(player_id, game_date);

  -- Flexible per-game stat store: one row per (game, metric).
  CREATE TABLE IF NOT EXISTS stat_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    metric_key TEXT NOT NULL,
    value      REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (game_id, metric_key)
  );
  CREATE INDEX IF NOT EXISTS idx_stats_metric ON stat_entries(metric_key);

  -- Player/parent account claiming: admin generates an invite link per player;
  -- the recipient claims it with an email + password and can then sign in to
  -- see that player's data in isolation.
  CREATE TABLE IF NOT EXISTS invites (
    token      TEXT PRIMARY KEY,
    player_id  INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS player_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS player_sessions (
    token          TEXT PRIMARY KEY,
    player_user_id INTEGER NOT NULL REFERENCES player_users(id) ON DELETE CASCADE,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT NOT NULL
  );

  -- Shared events: rating-engine comparisons link participants by event id,
  -- never by matching event-name text (requirements §8).
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    event_date TEXT NOT NULL,
    location   TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (name, event_date)
  );

  -- Calculated-rating snapshots: raw measurements stay in stat_entries;
  -- derived ratings live here with full provenance (requirements §10).
  CREATE TABLE IF NOT EXISTS player_ratings (
    player_id           INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    game_id             INTEGER,
    benchmark_group     TEXT,
    benchmark_source    TEXT,
    benchmark_version   TEXT,
    calculation_version TEXT,
    calculated_at       TEXT,
    payload             TEXT NOT NULL
  );

  -- ═══ Team & Tournament platform (docs/PLATFORM_ROADMAP.md, Phases 1–2) ═══
  -- Non-negotiables: dated roster membership (never a single team_id on
  -- players), event rosters override season rosters without mutating them,
  -- teams join tournaments through division-scoped entries, and history is
  -- archived rather than deleted.

  CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    org_type   TEXT DEFAULT '',            -- school | club | academy | program
    city       TEXT DEFAULT '',
    state      TEXT DEFAULT '',
    logo_url   TEXT DEFAULT '',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    age_group       TEXT DEFAULT '',       -- e.g. 14U, 16U, Varsity
    level           TEXT DEFAULT '',       -- e.g. AAA, Gold, JV
    logo_url        TEXT DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS seasons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL UNIQUE,       -- e.g. "2026 Summer"
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',  -- active | archived
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dated player <-> team membership. Overlapping memberships are ALLOWED
  -- (club + school + guest scenarios); rows are archived, never deleted.
  CREATE TABLE IF NOT EXISTS roster_memberships (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id),
    team_id    INTEGER NOT NULL REFERENCES teams(id),
    season_id  INTEGER REFERENCES seasons(id),
    start_date TEXT NOT NULL,
    end_date   TEXT,                       -- null = open-ended
    jersey     TEXT DEFAULT '',
    positions  TEXT DEFAULT '',
    roster_role TEXT NOT NULL DEFAULT 'player',  -- player | captain | ...
    status     TEXT NOT NULL DEFAULT 'active',   -- active | archived
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_player ON roster_memberships(player_id, status);
  CREATE INDEX IF NOT EXISTS idx_memberships_team ON roster_memberships(team_id, status);

  CREATE TABLE IF NOT EXISTS tournaments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    location   TEXT DEFAULT '',
    organizer  TEXT DEFAULT '',
    logo_url   TEXT DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',  -- private | public
    published  INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS divisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    age_group     TEXT DEFAULT '',
    level         TEXT DEFAULT ''
  );

  -- Team <-> tournament/division participation record.
  CREATE TABLE IF NOT EXISTS tournament_entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    division_id   INTEGER NOT NULL REFERENCES divisions(id),
    team_id       INTEGER NOT NULL REFERENCES teams(id),
    seed          INTEGER,
    pool          TEXT DEFAULT '',
    placement     TEXT DEFAULT '',
    wins          INTEGER,
    losses        INTEGER,
    status        TEXT NOT NULL DEFAULT 'active',  -- active | withdrawn | archived
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (division_id, team_id)
  );

  -- Who actually represented an entry at the event. Overrides the season
  -- roster; guest players never join the permanent roster.
  CREATE TABLE IF NOT EXISTS event_rosters (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id  INTEGER NOT NULL REFERENCES tournament_entries(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    is_guest  INTEGER NOT NULL DEFAULT 0,
    jersey    TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (entry_id, player_id)
  );

  -- Shared game record between two entries. Distinct from the per-player
  -- \`games\` table, which remains the player's performance context and can
  -- point here via games.tournament_game_id.
  CREATE TABLE IF NOT EXISTS tournament_games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    division_id   INTEGER NOT NULL REFERENCES divisions(id),
    home_entry_id INTEGER NOT NULL REFERENCES tournament_entries(id),
    away_entry_id INTEGER NOT NULL REFERENCES tournament_entries(id),
    game_date     TEXT NOT NULL,
    game_time     TEXT DEFAULT '',
    field         TEXT DEFAULT '',
    home_score    INTEGER,
    away_score    INTEGER,
    status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | final | canceled
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tgames_tournament ON tournament_games(tournament_id, game_date);

  -- Strongest evidence a player took part in a specific shared game.
  CREATE TABLE IF NOT EXISTS player_game_appearances (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_game_id INTEGER NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
    player_id          INTEGER NOT NULL REFERENCES players(id),
    entry_id           INTEGER NOT NULL REFERENCES tournament_entries(id),
    starter            INTEGER NOT NULL DEFAULT 0,
    position           TEXT DEFAULT '',
    lineup_slot        INTEGER,
    UNIQUE (tournament_game_id, player_id)
  );

  -- Future coach/director access assignments (accounts claim these by email,
  -- same pattern as player invites — wired up in the connected-views phase).
  CREATE TABLE IF NOT EXISTS team_users (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email   TEXT NOT NULL,
    role    TEXT NOT NULL DEFAULT 'coach',
    UNIQUE (team_id, email)
  );

  CREATE TABLE IF NOT EXISTS tournament_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'director',
    UNIQUE (tournament_id, email)
  );
`);

// Additive column migrations (SQLite has no ADD COLUMN IF NOT EXISTS).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing('players', 'date_of_birth', 'date_of_birth TEXT');
addColumnIfMissing('games', 'event_id', 'event_id INTEGER REFERENCES events(id)');
// Per-player performance context can point at the shared tournament game.
addColumnIfMissing('games', 'tournament_game_id', 'tournament_game_id INTEGER REFERENCES tournament_games(id)');
// Admin exclusion of invalid/duplicate observations without deleting them.
addColumnIfMissing('stat_entries', 'excluded', 'excluded INTEGER NOT NULL DEFAULT 0');

// One-time backfill: link existing pro_day games to shared events using the
// legacy (date, name) grouping, so historical data joins the id-based model.
{
  const orphans = db.prepare(
    `SELECT id, game_date, TRIM(opponent) AS name, location FROM games
     WHERE game_type = 'pro_day' AND event_id IS NULL`
  ).all();
  const findEvent = db.prepare('SELECT id FROM events WHERE LOWER(name) = LOWER(?) AND event_date = ?');
  const makeEvent = db.prepare('INSERT INTO events (name, event_date, location) VALUES (?, ?, ?)');
  const linkGame = db.prepare('UPDATE games SET event_id = ? WHERE id = ?');
  for (const g of orphans) {
    const name = g.name || 'Pro Day';
    const existing = findEvent.get(name, g.game_date);
    const eventId = existing ? existing.id : makeEvent.run(name, g.game_date, g.location || '').lastInsertRowid;
    linkGame.run(eventId, g.id);
  }
  if (orphans.length) console.log(`[db] Linked ${orphans.length} pro day game(s) to shared events`);
}

// ── Password hashing (scrypt, no native deps beyond node:crypto) ────────
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ── Seed default admin ───────────────────────────────────────────────────
const ADMIN_EMAIL = process.env.DM_ADMIN_EMAIL || 'admin@diamondmetrics.ai';
const ADMIN_PASSWORD = process.env.DM_ADMIN_PASSWORD || 'diamond-admin-2026';

const existingAdmin = db.prepare('SELECT id FROM admins WHERE email = ?').get(ADMIN_EMAIL);
if (!existingAdmin) {
  db.prepare('INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?)')
    .run(ADMIN_EMAIL, 'Admin', hashPassword(ADMIN_PASSWORD));
  console.log(`[db] Seeded admin account: ${ADMIN_EMAIL}`);
}

export function newSlug(firstName, lastName) {
  const base = `${firstName}-${lastName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = base;
  // Add a short suffix on collision so profile links stay unique.
  while (db.prepare('SELECT 1 FROM players WHERE slug = ?').get(slug)) {
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}
