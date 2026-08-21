import Database from 'better-sqlite3';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { REGISTRY_SEED, CAPTURE_PROFILE_SEED } from './commandLogic.js';
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

  -- Coach/director accounts (staff). Assignments live in team_users /
  -- tournament_users keyed by email; a staff account claims that email via
  -- an invite, mirroring the player invite-claim flow. One account can be a
  -- coach on some teams and a director on some tournaments simultaneously.
  CREATE TABLE IF NOT EXISTS staff_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS staff_sessions (
    token         TEXT PRIMARY KEY,
    staff_user_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staff_invites (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    claimed_at TEXT
  );

  -- Server-side import audit trail (requirements §8): every preview/apply is
  -- recorded with uploader, source file, and result counts.
  CREATE TABLE IF NOT EXISTS import_audits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,
    filename       TEXT DEFAULT '',
    uploader_email TEXT NOT NULL,
    dry_run        INTEGER NOT NULL DEFAULT 0,
    created_count  INTEGER NOT NULL DEFAULT 0,
    updated_count  INTEGER NOT NULL DEFAULT 0,
    skipped_count  INTEGER NOT NULL DEFAULT 0,
    error_count    INTEGER NOT NULL DEFAULT 0,
    report         TEXT DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
// Command metric-release adapter provenance (Phase 4.2 / Command M1+):
addColumnIfMissing('stat_entries', 'method', 'method TEXT');
addColumnIfMissing('stat_entries', 'metric_result_id', 'metric_result_id INTEGER');
// Internal roles: admin (full), analyst (Command workspace), reviewer (QA+publish).
addColumnIfMissing('admins', 'role', "role TEXT NOT NULL DEFAULT 'admin'");
// External/source ids so re-imports are idempotent and never duplicate
// players, teams, games, or events (requirements §3/§8).
for (const table of ['players', 'organizations', 'teams', 'tournaments', 'tournament_games']) {
  addColumnIfMissing(table, 'external_id', 'external_id TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_external ON ${table}(external_id) WHERE external_id IS NOT NULL`);
}

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

// ═══ Diamond Metrics Command (internal analyst platform) ═════════════════
// Shared-foundation rule: Command references existing organizations, teams,
// rosters, tournaments, tournament_games, and players. It never duplicates
// them. Approved results publish through the metric-release adapter into the
// existing stat_entries path. docs/COMMAND_TDR.md is the decision record.
db.exec(`
  CREATE TABLE IF NOT EXISTS sports (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    key  TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rulesets (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sport_id  INTEGER NOT NULL REFERENCES sports(id),
    key       TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    config    TEXT NOT NULL DEFAULT '{}'      -- innings, time/run rules, tiebreaker
  );

  -- Sellable/production metric registry (appendix recipes). Distinct from the
  -- display catalog: a registry row knows its recipe, capture tier, and which
  -- public metric keys it publishes to.
  CREATE TABLE IF NOT EXISTS cmd_metric_registry (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_code        TEXT NOT NULL UNIQUE,      -- e.g. pitch_velocity_radar
    label              TEXT NOT NULL,
    category           TEXT NOT NULL,             -- rookie | pitching | hitting | fielding | athleticism | game_context
    availability_tier  TEXT NOT NULL,             -- A | B | C | D | X (appendix)
    recipe_version     TEXT NOT NULL,
    unit               TEXT DEFAULT '',
    decimals           INTEGER NOT NULL DEFAULT 2,
    method             TEXT NOT NULL,             -- radar_verified | frame_timed | video_estimated | manual | scorebook_derived
    publishes_to       TEXT NOT NULL DEFAULT '[]',-- JSON array of public metricCatalog keys
    capture_requirements TEXT NOT NULL DEFAULT '',
    dependencies       TEXT NOT NULL DEFAULT '[]',
    sellable           INTEGER NOT NULL DEFAULT 1,
    active             INTEGER NOT NULL DEFAULT 0,-- activated per delivery phase
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Orders select the metric modules for a job (package or custom).
  CREATE TABLE IF NOT EXISTS cmd_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    package_key TEXT NOT NULL,                  -- rookie | rookie_plus | pro | custom
    label       TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    created_by  INTEGER REFERENCES admins(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cmd_metric_requirements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            INTEGER NOT NULL REFERENCES cmd_orders(id) ON DELETE CASCADE,
    metric_code         TEXT NOT NULL REFERENCES cmd_metric_registry(metric_code),
    priority            INTEGER NOT NULL DEFAULT 100,
    capture_requirement TEXT DEFAULT '',
    enabled             INTEGER NOT NULL DEFAULT 1,
    UNIQUE (order_id, metric_code)
  );

  -- The analyst job: one game/event to produce. Metric release and game
  -- record advance independently (two-release model).
  CREATE TABLE IF NOT EXISTS cmd_jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    sport_id              INTEGER NOT NULL REFERENCES sports(id),
    ruleset_id            INTEGER REFERENCES rulesets(id),
    team_id               INTEGER NOT NULL REFERENCES teams(id),
    opponent_label        TEXT DEFAULT '',
    tournament_id         INTEGER REFERENCES tournaments(id),
    tournament_game_id    INTEGER REFERENCES tournament_games(id),
    event_label           TEXT DEFAULT '',
    game_date             TEXT NOT NULL,
    game_type             TEXT NOT NULL DEFAULT 'game',   -- game | pro_day
    order_id              INTEGER NOT NULL REFERENCES cmd_orders(id),
    assigned_to           INTEGER REFERENCES admins(id),
    due_date              TEXT,
    metric_release_status TEXT NOT NULL DEFAULT 'not_started',
    game_record_status    TEXT NOT NULL DEFAULT 'pending',
    blocker_reason        TEXT DEFAULT '',
    created_by            INTEGER REFERENCES admins(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_jobs_status ON cmd_jobs(metric_release_status, assigned_to);

  -- Order/job-level consent snapshot (auditable; legal language pending).
  CREATE TABLE IF NOT EXISTS cmd_consent (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL REFERENCES cmd_jobs(id) ON DELETE CASCADE,
    media_consent INTEGER NOT NULL DEFAULT 0,
    sharing_scope TEXT NOT NULL DEFAULT 'internal',   -- internal | customer | public
    recorded_by   INTEGER REFERENCES admins(id),
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Reusable capture profiles (expected eligible metrics + standard metadata).
  CREATE TABLE IF NOT EXISTS cmd_capture_profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    key              TEXT NOT NULL UNIQUE,
    label            TEXT NOT NULL,
    expected_metrics TEXT NOT NULL DEFAULT '[]',
    notes            TEXT DEFAULT ''
  );

  -- Append-only audit trail for every Command state change.
  CREATE TABLE IF NOT EXISTS cmd_review_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target_table TEXT NOT NULL,
    target_id    INTEGER NOT NULL,
    actor_id     INTEGER REFERENCES admins(id),
    action       TEXT NOT NULL,               -- created | assigned | status_changed | requirement_toggled | blocked | note
    note         TEXT DEFAULT '',
    prev_state   TEXT DEFAULT '',
    new_state    TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_audit_target ON cmd_review_actions(target_table, target_id);

  -- Auditable customer/internal notification events (owner directive: in
  -- Phase 1). Email dispatch rides the adapter; event rows are the audit.
  CREATE TABLE IF NOT EXISTS cmd_notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES cmd_jobs(id) ON DELETE CASCADE,
    event_key    TEXT NOT NULL,          -- footage_received | review_started | metrics_ready | full_review_pending | full_review_complete | paid_metric_unavailable
    audience     TEXT NOT NULL DEFAULT 'customer',   -- customer | internal
    payload      TEXT NOT NULL DEFAULT '{}',
    email_status TEXT NOT NULL DEFAULT 'skipped',    -- skipped | queued | sent | failed
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_notifications_job ON cmd_notifications(job_id, created_at);

  -- Game-record sources (GameChanger scorecard import, live internal entry,
  -- postgame manual score). Non-blocking for Rookie; raw import preserved
  -- for later validation and box-score completion.
  -- Video feeds: one row per independent camera source on a job. Multiple
  -- unaligned feeds allowed; original metadata retained; VFR flagged.
  CREATE TABLE IF NOT EXISTS cmd_video_feeds (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id         INTEGER NOT NULL REFERENCES cmd_jobs(id) ON DELETE CASCADE,
    label          TEXT NOT NULL DEFAULT 'Behind Home',
    capture_profile_key TEXT DEFAULT '',
    storage_key    TEXT NOT NULL,            -- original object key
    original_name  TEXT DEFAULT '',
    size_bytes     INTEGER,
    content_hash   TEXT DEFAULT '',          -- idempotency: same hash+size = same feed
    status         TEXT NOT NULL DEFAULT 'uploading',  -- uploading | uploaded | queued | processing | ready | failed | retrying
    error          TEXT DEFAULT '',
    duration_s     REAL,
    codec          TEXT DEFAULT '',
    width          INTEGER, height INTEGER, rotation INTEGER DEFAULT 0,
    nominal_fps    REAL, effective_fps REAL,
    vfr            INTEGER NOT NULL DEFAULT 0,
    manual_offset_s REAL DEFAULT 0,
    recording_notes TEXT DEFAULT '',
    quality_notes  TEXT DEFAULT '',
    created_by     INTEGER REFERENCES admins(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_feeds_job ON cmd_video_feeds(job_id);

  CREATE TABLE IF NOT EXISTS cmd_media_renditions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id     INTEGER NOT NULL REFERENCES cmd_video_feeds(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,               -- proxy | thumbnails | clip
    storage_key TEXT NOT NULL,
    fps         REAL, width INTEGER, height INTEGER, duration_s REAL,
    params      TEXT NOT NULL DEFAULT '{}',  -- clip bounds / encode settings
    status      TEXT NOT NULL DEFAULT 'ready',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Background work queue for the media worker (probe | proxy | clip).
  CREATE TABLE IF NOT EXISTS cmd_media_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id     INTEGER NOT NULL REFERENCES cmd_video_feeds(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    params_hash TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (feed_id, kind, params_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_media_jobs_status ON cmd_media_jobs(status, id);

  CREATE TABLE IF NOT EXISTS cmd_game_record_sources (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id            INTEGER NOT NULL REFERENCES cmd_jobs(id) ON DELETE CASCADE,
    source_kind       TEXT NOT NULL,     -- gamechanger_export | live_internal | postgame_manual
    label             TEXT DEFAULT '',
    storage_key       TEXT DEFAULT '',   -- raw file reference once media storage lands (M2)
    raw_import        TEXT DEFAULT '',   -- raw parsed payload when supplied inline
    validation_status TEXT NOT NULL DEFAULT 'pending_validation',  -- pending_validation | validating | validated | rejected
    note              TEXT DEFAULT '',
    created_by        INTEGER REFERENCES admins(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
addColumnIfMissing('cmd_orders', 'contact_email', 'contact_email TEXT DEFAULT \'\'');

// ── Seed Command reference data (idempotent; active flags follow code) ──
{
  const insSport = db.prepare('INSERT OR IGNORE INTO sports (key, name) VALUES (?, ?)');
  insSport.run('baseball', 'Baseball');
  const baseball = db.prepare("SELECT id FROM sports WHERE key = 'baseball'").get().id;
  db.prepare('INSERT OR IGNORE INTO rulesets (sport_id, key, name, config) VALUES (?, ?, ?, ?)')
    .run(baseball, 'baseball_default', 'Baseball — default', JSON.stringify({ innings: 7, extra_innings: true }));

  const insMetric = db.prepare(
    `INSERT OR IGNORE INTO cmd_metric_registry
       (metric_code, label, category, availability_tier, recipe_version, unit, decimals, method, publishes_to, capture_requirements, dependencies, sellable, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const setActive = db.prepare('UPDATE cmd_metric_registry SET active = ?, recipe_version = ? WHERE metric_code = ?');
  for (const r of REGISTRY_SEED) {
    insMetric.run(r.metric_code, r.label, r.category, r.availability_tier, r.recipe_version, r.unit, r.decimals,
      r.method, JSON.stringify(r.publishes_to || []), r.capture_requirements || '', JSON.stringify(r.dependencies || []), r.active);
    setActive.run(r.active, r.recipe_version, r.metric_code);   // phase activation is code-driven
  }
  const insProfile = db.prepare('INSERT OR IGNORE INTO cmd_capture_profiles (key, label, expected_metrics, notes) VALUES (?, ?, ?, ?)');
  for (const cp of CAPTURE_PROFILE_SEED) insProfile.run(cp.key, cp.label, JSON.stringify(cp.expected_metrics), cp.notes);
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
