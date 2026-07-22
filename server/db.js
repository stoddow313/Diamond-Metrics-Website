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
`);

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
