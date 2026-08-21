import express from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, hashPassword, verifyPassword, newSlug, UPLOADS_DIR } from './db.js';
import {
  METRICS, CATEGORIES, ATTRIBUTES, GAME_TYPES,
  VALID_METRIC_KEYS, ZERO_UNMEASURED_KEYS, heroSetForPosition, positionGroup,
} from './metricCatalog.js';
import { computeRatings } from './ratingEngine.js';
import { resolveEventRoster, slugify } from './rosterLogic.js';
import { IMPORT_KINDS, planImport, applyImport } from './importEngine.js';
import { deletePlayers } from './playerDelete.js';
import { findInvalidZeroEntries, excludeInvalidZeroEntries, summarizeZeroReport } from './zeroCleanup.js';
import { mountCommandRoutes } from './commandRoutes.js';
import { mountCommandMediaRoutes } from './commandMediaRoutes.js';
import { mountCommandRadarRoutes } from './commandRadarRoutes.js';
import { mountCommandMeasureRoutes } from './commandMeasureRoutes.js';
import { mountCommandReviewRoutes } from './commandReviewRoutes.js';
import { startInlineWorker } from './mediaWorker.js';
import { mountCommandOpsRoutes } from './commandOpsRoutes.js';
import { startBackupScheduler } from './backup.js';
import { requestLogger, errorHandler, installProcessHandlers, log, ENV } from './observability.js';
import {
  attributedGames, aggregateByPlayer, teamCategoryBlocks, standings,
  leaderboard, overallLeaderboard, trendSeries, calcStamp, DEFAULT_MINS,
} from './aggregates.js';

const app = express();
// Render (and most hosts) inject PORT; DM_API_PORT is the local-dev override.
const PORT = process.env.PORT || process.env.DM_API_PORT || 3001;
const SESSION_TTL_DAYS = 30;

// Structured request logging (M6) sits ahead of every route.
installProcessHandlers();
app.use(requestLogger);

// Limit sized for base64 photo uploads (clients downscale before sending).
app.use(express.json({ limit: '8mb' }));

// Player photos uploaded through the portal.
app.use('/api/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', immutable: true }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Auth ─────────────────────────────────────────────────────────────────

function createSession(adminId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, admin_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_DAYS} days'))`
  ).run(token, adminId);
  return token;
}

function internalFromToken(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT s.token, a.id, a.email, a.name, a.role FROM sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token) || null;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const row = internalFromToken(token);
  if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
  // Analysts/reviewers are internal but do not manage the admin surface.
  if (row.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });

  req.admin = { id: row.id, email: row.email, name: row.name, role: row.role };
  req.sessionToken = token;
  next();
}

// Command workspace access: any internal role (admin | analyst | reviewer).
function requireInternal(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const row = internalFromToken(token);
  if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
  req.internal = { id: row.id, email: row.email, name: row.name, role: row.role };
  req.sessionToken = token;
  next();
}

// Player (claimed-account) sessions are stored separately from admin sessions
// so a portal token can never reach admin routes.
function createPlayerSession(playerUserId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO player_sessions (token, player_user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_DAYS} days'))`
  ).run(token, playerUserId);
  return token;
}

function playerFromToken(token) {
  return db.prepare(
    `SELECT ps.token, pu.id AS player_user_id, pu.email, p.*
     FROM player_sessions ps
     JOIN player_users pu ON pu.id = ps.player_user_id
     JOIN players p ON p.id = pu.player_id
     WHERE ps.token = ? AND ps.expires_at > datetime('now')`
  ).get(token);
}

function requirePlayer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const row = playerFromToken(token);
  if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
  req.player = row;
  req.sessionToken = token;
  next();
}

// Coach/director (staff) sessions — separate table, same pattern as players.
function createStaffSession(staffUserId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO staff_sessions (token, staff_user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_DAYS} days'))`
  ).run(token, staffUserId);
  return token;
}

function staffFromToken(token) {
  return db.prepare(
    `SELECT ss.token, su.id AS staff_user_id, su.email, su.name
     FROM staff_sessions ss JOIN staff_users su ON su.id = ss.staff_user_id
     WHERE ss.token = ? AND ss.expires_at > datetime('now')`
  ).get(token);
}

function requireStaff(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const row = staffFromToken(token);
  if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
  req.staff = row;
  req.sessionToken = token;
  next();
}

// Permission rule (requirements §2): assignment-scoped access, enforced at
// the API layer. Assignments are email-keyed rows in team_users /
// tournament_users; being on neither list means 404 on direct URL access.
function staffCanViewTeam(staff, teamId) {
  return !!db.prepare('SELECT 1 FROM team_users WHERE team_id = ? AND email = ?').get(teamId, staff.email);
}

function staffCanViewTournament(staff, tournamentId) {
  return !!db.prepare('SELECT 1 FROM tournament_users WHERE tournament_id = ? AND email = ?').get(tournamentId, staff.email);
}

// One login endpoint for all roles: admins, then players, then staff.
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normEmail = String(email).toLowerCase().trim();

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(normEmail);
  if (admin && verifyPassword(password, admin.password_hash)) {
    const token = createSession(admin.id);
    return res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role || 'admin' } });
  }

  const pu = db.prepare(
    `SELECT pu.*, p.first_name, p.last_name, p.slug FROM player_users pu
     JOIN players p ON p.id = pu.player_id WHERE pu.email = ?`
  ).get(normEmail);
  if (pu && verifyPassword(password, pu.password_hash)) {
    const token = createPlayerSession(pu.id);
    return res.json({
      token,
      admin: { email: pu.email, name: `${pu.first_name} ${pu.last_name}`, role: 'player', slug: pu.slug },
    });
  }

  const su = db.prepare('SELECT * FROM staff_users WHERE email = ?').get(normEmail);
  if (su && verifyPassword(password, su.password_hash)) {
    const token = createStaffSession(su.id);
    return res.json({ token, admin: { email: su.email, name: su.name, role: 'staff' } });
  }

  res.status(401).json({ error: 'Invalid email or password' });
});

app.get('/api/auth/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const adminRow = db.prepare(
    `SELECT a.id, a.email, a.name, a.role FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (adminRow) return res.json({ admin: { ...adminRow, role: adminRow.role || 'admin' } });

  const playerRow = playerFromToken(token);
  if (playerRow) {
    return res.json({
      admin: { email: playerRow.email, name: `${playerRow.first_name} ${playerRow.last_name}`, role: 'player', slug: playerRow.slug },
    });
  }

  const staffRow = staffFromToken(token);
  if (staffRow) {
    return res.json({ admin: { email: staffRow.email, name: staffRow.name, role: 'staff' } });
  }
  res.status(401).json({ error: 'Session expired or invalid' });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    db.prepare('DELETE FROM player_sessions WHERE token = ?').run(token);
    db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

// ── Metric catalog (public — the profile renderer needs it too) ─────────

app.get('/api/metrics/catalog', (_req, res) => {
  res.json({ metrics: METRICS, categories: CATEGORIES, attributes: ATTRIBUTES, gameTypes: GAME_TYPES });
});

// ── Players (admin) ──────────────────────────────────────────────────────

// Overall and attribute ratings are engine-calculated (requirements §10) and
// no longer writable — the legacy columns remain only as display fallback for
// players without Pro Day data.
const PLAYER_FIELDS = [
  'first_name', 'last_name', 'school', 'city', 'state', 'grad_year',
  'date_of_birth', 'primary_position', 'secondary_position', 'height',
  'weight_lbs', 'bats', 'throws', 'committed_to', 'college_projection',
  'photo_url', 'is_public',
];

function playerFromBody(body) {
  const out = {};
  for (const f of PLAYER_FIELDS) {
    if (f in body) out[f] = body[f] === '' ? null : body[f];
  }
  return out;
}

app.get('/api/players', requireAdmin, (_req, res) => {
  const players = db.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM games g WHERE g.player_id = p.id) AS game_count
     FROM players p ORDER BY p.last_name, p.first_name`
  ).all();
  res.json({ players });
});

app.post('/api/players', requireAdmin, (req, res) => {
  const data = playerFromBody(req.body || {});
  if (!data.first_name || !data.last_name) {
    return res.status(400).json({ error: 'first_name and last_name are required' });
  }
  data.slug = newSlug(data.first_name, data.last_name);
  const cols = Object.keys(data);
  const info = db.prepare(
    `INSERT INTO players (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`
  ).run(data);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ player });
});

app.get('/api/players/:id', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const games = db.prepare(
    'SELECT * FROM games WHERE player_id = ? ORDER BY game_date DESC, id DESC'
  ).all(player.id);
  const stats = db.prepare(
    `SELECT s.game_id, s.metric_key, s.value FROM stat_entries s
     JOIN games g ON g.id = s.game_id WHERE g.player_id = ?`
  ).all(player.id);
  res.json({ player, games, stats, ratings: ratePlayer(player) });
});

app.put('/api/players/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM players WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Player not found' });

  const data = playerFromBody(req.body || {});
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No fields to update' });

  const sets = Object.keys(data).map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE players SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...data, id: existing.id });
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(existing.id);
  res.json({ player });
});

app.delete('/api/players/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Player not found' });
  }
  try {
    deletePlayers(db, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Delete failed: ${err.message}` });
  }
});

app.post('/api/players/bulk-delete', requireAdmin, (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(n => Number.isInteger(n) && n > 0)) {
    return res.status(400).json({ error: 'Body must include ids: a non-empty array of player ids' });
  }
  const missing = ids.filter(id => !db.prepare('SELECT 1 FROM players WHERE id = ?').get(id));
  if (missing.length) return res.status(404).json({ error: `Unknown player ids: ${missing.join(', ')}` });
  try {
    const deleted = deletePlayers(db, ids); // one transaction — all or nothing
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: `Delete failed: ${err.message}` });
  }
});

// ── Games + stats (admin) ────────────────────────────────────────────────

// Pro day games link to a shared event row (find-or-create on name + date) so
// rating comparisons join on event id, not name text (requirements §8).
function linkEventForGame(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) return;
  if (game.game_type !== 'pro_day') {
    if (game.event_id) db.prepare('UPDATE games SET event_id = NULL WHERE id = ?').run(game.id);
    return;
  }
  const name = (game.opponent || '').trim() || 'Pro Day';
  const existing = db.prepare('SELECT id FROM events WHERE LOWER(name) = LOWER(?) AND event_date = ?').get(name, game.game_date);
  const eventId = existing
    ? existing.id
    : db.prepare('INSERT INTO events (name, event_date, location) VALUES (?, ?, ?)').run(name, game.game_date, game.location || '').lastInsertRowid;
  if (game.event_id !== eventId) db.prepare('UPDATE games SET event_id = ? WHERE id = ?').run(eventId, game.id);
}

app.post('/api/players/:id/games', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT id FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { game_date, game_type = 'game', opponent = '', location = '', notes = '' } = req.body || {};
  if (!game_date) return res.status(400).json({ error: 'game_date is required' });
  if (!GAME_TYPES.includes(game_type)) return res.status(400).json({ error: `game_type must be one of: ${GAME_TYPES.join(', ')}` });

  const info = db.prepare(
    'INSERT INTO games (player_id, game_date, game_type, opponent, location, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(player.id, game_date, game_type, opponent, location, notes);
  linkEventForGame(info.lastInsertRowid);
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ game });
});

app.put('/api/games/:id', requireAdmin, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const { game_date, game_type, opponent, location, notes } = req.body || {};
  if (game_type && !GAME_TYPES.includes(game_type)) {
    return res.status(400).json({ error: `game_type must be one of: ${GAME_TYPES.join(', ')}` });
  }
  db.prepare(
    `UPDATE games SET game_date = ?, game_type = ?, opponent = ?, location = ?, notes = ? WHERE id = ?`
  ).run(
    game_date ?? game.game_date,
    game_type ?? game.game_type,
    opponent ?? game.opponent,
    location ?? game.location,
    notes ?? game.notes,
    game.id
  );
  linkEventForGame(game.id);
  res.json({ game: db.prepare('SELECT * FROM games WHERE id = ?').get(game.id) });
});

app.delete('/api/games/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Game not found' });
  res.json({ ok: true });
});

// Upsert the full stat sheet for a game: { stats: { metric_key: number|null } }
// null/'' clears the entry; numbers upsert.
app.put('/api/games/:id/stats', requireAdmin, (req, res) => {
  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const stats = (req.body || {}).stats;
  if (!stats || typeof stats !== 'object') return res.status(400).json({ error: 'Body must include a stats object' });

  const badKeys = Object.keys(stats).filter(k => !VALID_METRIC_KEYS.has(k));
  if (badKeys.length) return res.status(400).json({ error: `Unknown metric keys: ${badKeys.join(', ')}` });

  const upsert = db.prepare(
    `INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, ?, ?)
     ON CONFLICT (game_id, metric_key) DO UPDATE SET value = excluded.value`
  );
  const clear = db.prepare('DELETE FROM stat_entries WHERE game_id = ? AND metric_key = ?');

  const zeroTreatedAsUnmeasured = [];
  const apply = db.transaction(() => {
    for (const [key, raw] of Object.entries(stats)) {
      if (raw === null || raw === '') { clear.run(game.id, key); continue; }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw Object.assign(new Error(`Invalid value for ${key}`), { status: 400 });
      // 0 mph / 0 s / 0 % can't be real marks — treat as "not measured" and
      // clear any stored entry rather than dragging averages to zero.
      if (value === 0 && ZERO_UNMEASURED_KEYS.has(key)) {
        clear.run(game.id, key);
        zeroTreatedAsUnmeasured.push(key);
        continue;
      }
      upsert.run(game.id, key, value);
    }
  });

  try {
    apply();
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const saved = db.prepare('SELECT metric_key, value FROM stat_entries WHERE game_id = ?').all(game.id);
  res.json({
    stats: Object.fromEntries(saved.map(r => [r.metric_key, r.value])),
    zero_treated_as_unmeasured: zeroTreatedAsUnmeasured,
  });
});

// ── Public profile ───────────────────────────────────────────────────────

const PUBLIC_PLAYER_COLS = `
  slug, first_name, last_name, school, city, state, grad_year,
  primary_position, secondary_position, height, weight_lbs, bats, throws,
  committed_to, college_projection, overall_rating, photo_url,
  attr_power, attr_contact, attr_speed, attr_arm, attr_defense, attr_athleticism
`;

// Shared by the public route (by slug, public profiles only) and the player
// portal (own profile, regardless of visibility).
function buildProfilePayload(player) {
  const games = db.prepare(
    'SELECT id, game_date, game_type, opponent, location, notes FROM games WHERE player_id = ? ORDER BY game_date ASC, id ASC'
  ).all(player.id);
  const entries = db.prepare(
    `SELECT s.metric_key, s.value, g.game_date, g.id AS game_id FROM stat_entries s
     JOIN games g ON g.id = s.game_id
     WHERE g.player_id = ? ORDER BY g.game_date ASC, g.id ASC`
  ).all(player.id);

  // Roll up each metric: aggregate headline value + per-game series for trends.
  const byMetric = {};
  for (const e of entries) {
    (byMetric[e.metric_key] ??= []).push({ date: e.game_date, value: e.value, gameId: e.game_id });
  }

  const metrics = {};
  for (const def of METRICS) {
    const series = byMetric[def.key];
    if (!series || series.length === 0) continue;
    const values = series.map(s => s.value);
    let headline;
    if (def.aggregate === 'max') headline = def.lowerIsBetter ? Math.min(...values) : Math.max(...values);
    else if (def.aggregate === 'latest') headline = values[values.length - 1];
    else if (def.aggregate === 'sum') headline = values.reduce((a, b) => a + b, 0);
    else headline = values.reduce((a, b) => a + b, 0) / values.length;

    metrics[def.key] = {
      ...def,
      headline: Number(headline.toFixed(def.decimals)),
      latest: values[values.length - 1],
      best: def.lowerIsBetter ? Math.min(...values) : Math.max(...values),
      series,
    };
  }

  // §6: Teams and Events/Tournaments sections on the player profile.
  // Public-safe fields only; team/tournament pages enforce their own access.
  const teams = db.prepare(
    `SELECT rm.jersey, rm.positions, rm.start_date, rm.end_date, rm.status,
            t.name AS team_name, t.slug AS team_slug, t.age_group, t.level,
            o.name AS organization_name, s.label AS season_label
     FROM roster_memberships rm
     JOIN teams t ON t.id = rm.team_id
     JOIN organizations o ON o.id = t.organization_id
     LEFT JOIN seasons s ON s.id = rm.season_id
     WHERE rm.player_id = ? ORDER BY rm.start_date DESC`
  ).all(player.id);
  const tournamentsPlayed = db.prepare(
    `SELECT tr.name AS tournament_name, tr.slug AS tournament_slug, tr.start_date, tr.published, tr.visibility,
            d.name AS division_name, t.name AS team_name, t.slug AS team_slug, er.is_guest
     FROM event_rosters er
     JOIN tournament_entries te ON te.id = er.entry_id
     JOIN tournaments tr ON tr.id = te.tournament_id
     JOIN divisions d ON d.id = te.division_id
     JOIN teams t ON t.id = te.team_id
     WHERE er.player_id = ? ORDER BY tr.start_date DESC`
  ).all(player.id);

  const { id: _id, ...publicPlayer } = player;
  return {
    player: publicPlayer,
    games,
    metrics,
    heroKeys: heroSetForPosition(player.primary_position),
    catalog: { metrics: METRICS, categories: CATEGORIES },
    teams,
    tournaments: tournamentsPlayed,
    // Engine-calculated skills/overall (null when no Pro Day data exists;
    // clients fall back to the legacy stored ratings in that case).
    ratings: ratePlayer(player),
  };
}

app.get('/api/public/players/:slug', (req, res) => {
  const player = db.prepare(
    `SELECT id, ${PUBLIC_PLAYER_COLS} FROM players WHERE slug = ? AND is_public = 1`
  ).get(req.params.slug);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json(buildProfilePayload(player));
});

// ── Pro Day card ─────────────────────────────────────────────────────────
// Powers the shareable two-sided player card: the player's most recent
// pro_day event, its measured results, and rankings among every player who
// attended the same event (matched on event name + date).

const METRIC_BY_KEY = new Map(METRICS.map(m => [m.key, m]));
const MEASURABLE_KEYS = new Set(METRICS.filter(m => m.category !== 'box').map(m => m.key));

function latestProDay(playerId) {
  return db.prepare(
    `SELECT * FROM games WHERE player_id = ? AND game_type = 'pro_day'
     ORDER BY game_date DESC, id DESC LIMIT 1`
  ).get(playerId) || null;
}

function statsForGame(gameId) {
  const stats = {};
  for (const row of db.prepare('SELECT metric_key, value FROM stat_entries WHERE game_id = ?').all(gameId)) {
    if (MEASURABLE_KEYS.has(row.metric_key)) stats[row.metric_key] = row.value;
  }
  return stats;
}

// Participants are linked by event id, never by event-name text (§8).
function eventParticipants(eventId) {
  if (!eventId) return [];
  return db.prepare(
    `SELECT g.id AS game_id, p.id AS player_id, p.primary_position, p.overall_rating
     FROM games g JOIN players p ON p.id = g.player_id
     WHERE g.game_type = 'pro_day' AND g.event_id = ?`
  ).all(eventId);
}

// Run the rating engine for a player's latest Pro Day, persist the snapshot
// with provenance (§10), and return the ratings payload (null = no pro day).
function ratePlayer(player) {
  const proDay = latestProDay(player.id);
  if (!proDay) return null;

  const row = db.prepare('SELECT date_of_birth, grad_year, primary_position, secondary_position FROM players WHERE id = ?').get(player.id);
  const stats = statsForGame(proDay.id);
  const participants = eventParticipants(proDay.event_id).map(p => statsForGame(p.game_id));

  const ratings = computeRatings({
    stats,
    participants,
    dateOfBirth: row.date_of_birth,
    gradYear: row.grad_year,
    eventDate: proDay.game_date,
    primaryPosition: row.primary_position,
    secondaryPosition: row.secondary_position,
  });

  db.prepare(
    `INSERT INTO player_ratings (player_id, game_id, benchmark_group, benchmark_source, benchmark_version, calculation_version, calculated_at, payload)
     VALUES (@player_id, @game_id, @benchmark_group, @benchmark_source, @benchmark_version, @calculation_version, @calculated_at, @payload)
     ON CONFLICT(player_id) DO UPDATE SET
       game_id = excluded.game_id, benchmark_group = excluded.benchmark_group,
       benchmark_source = excluded.benchmark_source, benchmark_version = excluded.benchmark_version,
       calculation_version = excluded.calculation_version, calculated_at = excluded.calculated_at,
       payload = excluded.payload`
  ).run({
    player_id: player.id,
    game_id: proDay.id,
    benchmark_group: ratings.benchmark.group,
    benchmark_source: ratings.benchmark.source,
    benchmark_version: ratings.benchmark.version,
    calculation_version: ratings.calculationVersion,
    calculated_at: ratings.calculatedAt,
    payload: JSON.stringify(ratings),
  });

  return ratings;
}

function buildCardPayload(player) {
  const proDay = latestProDay(player.id);
  if (!proDay) return null;

  const ownStats = {};
  for (const row of db.prepare('SELECT metric_key, value FROM stat_entries WHERE game_id = ?').all(proDay.id)) {
    ownStats[row.metric_key] = row.value;
  }

  // Card shows measured testing results — box-score counting stats stay off it.
  const results = METRICS
    .filter(m => m.category !== 'box' && ownStats[m.key] !== undefined)
    .map(m => ({ key: m.key, label: m.label, unit: m.unit, decimals: m.decimals, value: ownStats[m.key] }));

  // Front headline chips: position-adaptive hero metrics measured at this
  // event, falling back to whatever was measured when none of the hero set
  // was — same reason as the profile Overview, so a card never headlines blank.
  const chipKeys = heroSetForPosition(player.primary_position).filter(k => ownStats[k] !== undefined);
  const chips = (chipKeys.length > 0 ? chipKeys : results.map(r => r.key))
    .slice(0, 4)
    .map(k => {
      const m = METRIC_BY_KEY.get(k);
      return { key: k, label: m.label, unit: m.unit, decimals: m.decimals, value: ownStats[k] };
    });

  // ── Rankings among participants linked to the same event id (§8) ──
  // Every athlete who attended counts toward rankings — including those whose
  // own profiles are private. Only aggregate ranks are exposed, never their
  // names or values, so nothing private leaks.
  const participants = eventParticipants(proDay.event_id);

  let rankings = null;
  if (participants.length >= 2) {
    const gameIds = participants.map(p => p.game_id);
    const allStats = db.prepare(
      `SELECT game_id, metric_key, value FROM stat_entries
       WHERE game_id IN (${gameIds.map(() => '?').join(',')})`
    ).all(...gameIds);

    const valuesByMetric = {};
    for (const s of allStats) (valuesByMetric[s.metric_key] ??= []).push({ gameId: s.game_id, value: s.value });

    const metricRanks = [];
    for (const r of results) {
      const def = METRIC_BY_KEY.get(r.key);
      const values = valuesByMetric[r.key] || [];
      if (values.length < 2) continue;
      const better = values.filter(v =>
        def.lowerIsBetter ? v.value < r.value : v.value > r.value
      ).length;
      metricRanks.push({ key: r.key, label: def.label, rank: better + 1, of: values.length });
    }

    // Overall rank within the player's position cohort, by overall rating.
    const group = positionGroup(player.primary_position);
    const cohort = participants.filter(p => positionGroup(p.primary_position) === group && p.overall_rating != null);
    let overall = null;
    if (player.overall_rating != null && cohort.length >= 2) {
      const better = cohort.filter(p => p.overall_rating > player.overall_rating).length;
      overall = { group, rank: better + 1, of: cohort.length };
    }

    rankings = { participantCount: participants.length, overall, metrics: metricRanks };
  }

  // Deterministic card ID from the event name initials + player id.
  const initials = (proDay.opponent || 'Pro Day').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 3) || 'PD';
  const { id: _id, ...publicPlayer } = player;

  return {
    player: publicPlayer,
    positionGroup: positionGroup(player.primary_position),
    cardId: `DM-${initials}-${String(player.id).padStart(3, '0')}`,
    event: {
      id: proDay.event_id,
      date: proDay.game_date,
      name: proDay.opponent || 'Pro Day',
      location: proDay.location || '',
    },
    chips,
    results,
    rankings,
    ratings: ratePlayer(player),
  };
}

app.get('/api/public/players/:slug/card', (req, res) => {
  const player = db.prepare(
    `SELECT id, ${PUBLIC_PLAYER_COLS} FROM players WHERE slug = ? AND is_public = 1`
  ).get(req.params.slug);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const payload = buildCardPayload(player);
  if (!payload) return res.status(404).json({ error: 'No Pro Day event logged for this player' });
  res.json(payload);
});

// ── Invites & player portal ──────────────────────────────────────────────
// Admin generates a per-player invite link; the recipient claims it with an
// email + password, then signs in to see their own profile in isolation
// (their portal works even when the public profile is disabled).

app.post('/api/players/:id/invite', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT id FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const account = db.prepare('SELECT email FROM player_users WHERE player_id = ?').get(player.id);
  if (account) return res.status(409).json({ error: `Account already claimed by ${account.email}` });

  db.prepare('DELETE FROM invites WHERE player_id = ?').run(player.id);
  const token = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO invites (token, player_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`
  ).run(token, player.id);
  const invite = db.prepare('SELECT token, expires_at, claimed_at FROM invites WHERE player_id = ?').get(player.id);
  res.status(201).json({ invite });
});

app.get('/api/players/:id/invite', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT id FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const invite = db.prepare(
    `SELECT token, expires_at, claimed_at FROM invites WHERE player_id = ? AND expires_at > datetime('now')`
  ).get(player.id) || null;
  const account = db.prepare('SELECT email, created_at FROM player_users WHERE player_id = ?').get(player.id) || null;
  res.json({ invite, account });
});

// Public: the claim page looks the invite up before showing the form.
app.get('/api/invites/:token', (req, res) => {
  const invite = db.prepare(
    `SELECT i.token, i.expires_at, i.claimed_at, p.first_name, p.last_name
     FROM invites i JOIN players p ON p.id = i.player_id WHERE i.token = ?`
  ).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  res.json({
    player: { first_name: invite.first_name, last_name: invite.last_name },
    claimed: !!invite.claimed_at,
    expired: db.prepare(`SELECT 1 FROM invites WHERE token = ? AND expires_at <= datetime('now')`).get(req.params.token) != null,
  });
});

app.post('/api/invites/:token/claim', (req, res) => {
  const invite = db.prepare(
    `SELECT * FROM invites WHERE token = ? AND expires_at > datetime('now')`
  ).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite link is invalid or has expired' });
  if (invite.claimed_at) return res.status(409).json({ error: 'This invite has already been claimed' });

  const email = String((req.body || {}).email || '').toLowerCase().trim();
  const password = String((req.body || {}).password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM player_users WHERE email = ?').get(email) || db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const info = db.prepare(
    'INSERT INTO player_users (player_id, email, password_hash) VALUES (?, ?, ?)'
  ).run(invite.player_id, email, hashPassword(password));
  db.prepare(`UPDATE invites SET claimed_at = datetime('now') WHERE token = ?`).run(invite.token);

  const player = db.prepare('SELECT first_name, last_name, slug FROM players WHERE id = ?').get(invite.player_id);
  const token = createPlayerSession(info.lastInsertRowid);
  res.status(201).json({
    token,
    admin: { email, name: `${player.first_name} ${player.last_name}`, role: 'player', slug: player.slug },
  });
});

// Portal: the claimed account's own data, visibility-independent.
// Re-select clean columns — req.player carries session-join fields that must
// not spread into the payload.
function portalPlayer(req) {
  return db.prepare(`SELECT id, ${PUBLIC_PLAYER_COLS} FROM players WHERE id = ?`).get(req.player.id);
}

app.get('/api/portal/profile', requirePlayer, (req, res) => {
  const payload = buildProfilePayload(portalPlayer(req));
  // DOB stays out of public payloads; the player sees their own for editing.
  const dob = db.prepare('SELECT date_of_birth FROM players WHERE id = ?').get(req.player.id)?.date_of_birth || null;
  res.json({ ...payload, player: { ...payload.player, date_of_birth: dob }, is_public: !!req.player.is_public });
});

app.get('/api/portal/card', requirePlayer, (req, res) => {
  const payload = buildCardPayload(portalPlayer(req));
  if (!payload) return res.status(404).json({ error: 'No Pro Day event logged for this player' });
  res.json(payload);
});

// Players own their demographics; measurements, ratings, and projections
// stay admin-only (they're scouting output, not identity).
const PLAYER_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'school', 'city', 'state', 'grad_year',
  'date_of_birth', 'primary_position', 'secondary_position', 'height',
  'weight_lbs', 'bats', 'throws', 'committed_to',
];

app.put('/api/portal/profile', requirePlayer, (req, res) => {
  const data = {};
  for (const f of PLAYER_EDITABLE_FIELDS) {
    if (f in (req.body || {})) data[f] = req.body[f] === '' ? null : req.body[f];
  }
  if (!data.first_name || !data.last_name) {
    if ('first_name' in data || 'last_name' in data) {
      return res.status(400).json({ error: 'First and last name cannot be empty' });
    }
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No editable fields provided' });

  const sets = Object.keys(data).map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE players SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...data, id: req.player.id });
  res.json({ ...buildProfilePayload(portalPlayer(req)), is_public: !!req.player.is_public });
});

const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/portal/photo', requirePlayer, (req, res) => {
  const image = String((req.body || {}).image || '');
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Send a JPEG, PNG, or WebP image' });

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (5 MB max)' });

  const filename = `player-${req.player.id}-${randomBytes(6).toString('hex')}.${PHOTO_TYPES[match[1]]}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

  // Clean up the previous upload if it was one of ours.
  const old = db.prepare('SELECT photo_url FROM players WHERE id = ?').get(req.player.id)?.photo_url || '';
  if (old.startsWith('/api/uploads/')) {
    const oldPath = path.join(UPLOADS_DIR, path.basename(old));
    fs.rm(oldPath, { force: true }, () => {});
  }

  const photoUrl = `/api/uploads/${filename}`;
  db.prepare(`UPDATE players SET photo_url = ?, updated_at = datetime('now') WHERE id = ?`).run(photoUrl, req.player.id);
  res.status(201).json({ photo_url: photoUrl });
});

app.delete('/api/portal/photo', requirePlayer, (req, res) => {
  const old = db.prepare('SELECT photo_url FROM players WHERE id = ?').get(req.player.id)?.photo_url || '';
  if (old.startsWith('/api/uploads/')) {
    fs.rm(path.join(UPLOADS_DIR, path.basename(old)), { force: true }, () => {});
  }
  db.prepare(`UPDATE players SET photo_url = '', updated_at = datetime('now') WHERE id = ?`).run(req.player.id);
  res.json({ ok: true });
});

// ═══ Team & Tournament platform — admin CRUD (roadmap Phases 1–2) ═════════
// All management is Diamond Metrics-admin only in this phase; coach/director
// read access arrives with the connected-views phase, which is why writes
// below never delete history — they archive it.

function uniqueSlug(table, name) {
  const base = slugify(name) || 'item';
  let slug = base;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).get(slug)) {
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}

function pickFields(body, fields) {
  const out = {};
  for (const f of fields) if (f in (body || {})) out[f] = body[f] === '' ? null : body[f];
  return out;
}

function crudUpdate(table, id, data) {
  const sets = Object.keys(data).map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run({ ...data, id });
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// ── Organizations ────────────────────────────────────────────────────────
const ORG_FIELDS = ['name', 'org_type', 'city', 'state', 'logo_url', 'archived'];

app.get('/api/organizations', requireAdmin, (_req, res) => {
  res.json({ organizations: db.prepare('SELECT * FROM organizations ORDER BY name').all() });
});

app.post('/api/organizations', requireAdmin, (req, res) => {
  const data = pickFields(req.body, ORG_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name is required' });
  const cols = Object.keys(data);
  const info = db.prepare(`INSERT INTO organizations (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(data);
  res.status(201).json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/organizations/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Organization not found' });
  const data = pickFields(req.body, ORG_FIELDS);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  res.json({ organization: crudUpdate('organizations', req.params.id, data) });
});

// ── Teams ────────────────────────────────────────────────────────────────
const TEAM_FIELDS = ['organization_id', 'name', 'age_group', 'level', 'logo_url', 'active'];

app.get('/api/teams', requireAdmin, (_req, res) => {
  res.json({
    teams: db.prepare(
      `SELECT t.*, o.name AS organization_name,
              (SELECT COUNT(*) FROM roster_memberships rm WHERE rm.team_id = t.id AND rm.status = 'active') AS roster_count
       FROM teams t JOIN organizations o ON o.id = t.organization_id
       ORDER BY t.name`
    ).all(),
  });
});

app.post('/api/teams', requireAdmin, (req, res) => {
  const data = pickFields(req.body, TEAM_FIELDS);
  if (!data.name || !data.organization_id) return res.status(400).json({ error: 'name and organization_id are required' });
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(data.organization_id)) return res.status(400).json({ error: 'Unknown organization' });
  data.slug = uniqueSlug('teams', `${data.name} ${data.age_group || ''}`);
  const cols = Object.keys(data);
  const info = db.prepare(`INSERT INTO teams (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(data);
  res.status(201).json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid) });
});

app.get('/api/teams/:id', requireAdmin, (req, res) => {
  const team = db.prepare(
    'SELECT t.*, o.name AS organization_name FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.id = ?'
  ).get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const roster = db.prepare(
    `SELECT rm.*, p.first_name, p.last_name, p.slug AS player_slug, p.grad_year, s.label AS season_label
     FROM roster_memberships rm
     JOIN players p ON p.id = rm.player_id
     LEFT JOIN seasons s ON s.id = rm.season_id
     WHERE rm.team_id = ? ORDER BY rm.status, p.last_name, p.first_name`
  ).all(team.id);
  const entries = db.prepare(
    `SELECT te.*, tr.name AS tournament_name, tr.slug AS tournament_slug, tr.start_date, d.name AS division_name
     FROM tournament_entries te
     JOIN tournaments tr ON tr.id = te.tournament_id
     JOIN divisions d ON d.id = te.division_id
     WHERE te.team_id = ? ORDER BY tr.start_date DESC`
  ).all(team.id);
  res.json({ team, roster, entries });
});

app.put('/api/teams/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Team not found' });
  const data = pickFields(req.body, TEAM_FIELDS);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  data.updated_at = new Date().toISOString();
  res.json({ team: crudUpdate('teams', req.params.id, data) });
});

// ── Seasons ──────────────────────────────────────────────────────────────
app.get('/api/seasons', requireAdmin, (_req, res) => {
  res.json({ seasons: db.prepare('SELECT * FROM seasons ORDER BY start_date DESC').all() });
});

app.post('/api/seasons', requireAdmin, (req, res) => {
  const { label, start_date, end_date, status = 'active' } = req.body || {};
  if (!label || !start_date || !end_date) return res.status(400).json({ error: 'label, start_date, end_date are required' });
  if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: "status must be 'active' or 'archived'" });
  try {
    const info = db.prepare('INSERT INTO seasons (label, start_date, end_date, status) VALUES (?, ?, ?, ?)').run(label, start_date, end_date, status);
    res.status(201).json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'A season with that label already exists' });
  }
});

app.put('/api/seasons/:id', requireAdmin, (req, res) => {
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(req.params.id);
  if (!season) return res.status(404).json({ error: 'Season not found' });
  const data = pickFields(req.body, ['label', 'start_date', 'end_date', 'status']);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  if (data.status && !['active', 'archived'].includes(data.status)) {
    return res.status(400).json({ error: "status must be 'active' or 'archived'" });
  }
  if ('label' in data && !String(data.label).trim()) return res.status(400).json({ error: 'label cannot be empty' });
  try {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE seasons SET ${sets} WHERE id = ?`).run(...Object.values(data), season.id);
    res.json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(season.id) });
  } catch {
    res.status(409).json({ error: 'A season with that label already exists' });
  }
});

// ── Roster memberships (dated; archive, never delete) ───────────────────
app.post('/api/teams/:id/roster', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const { player_id, season_id = null, start_date, end_date = null, jersey = '', positions = '', roster_role = 'player' } = req.body || {};
  if (!player_id || !start_date) return res.status(400).json({ error: 'player_id and start_date are required' });
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) return res.status(400).json({ error: 'Unknown player' });

  const info = db.prepare(
    `INSERT INTO roster_memberships (player_id, team_id, season_id, start_date, end_date, jersey, positions, roster_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(player_id, team.id, season_id, start_date, end_date, jersey, positions, roster_role);
  res.status(201).json({ membership: db.prepare('SELECT * FROM roster_memberships WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/roster/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM roster_memberships WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Membership not found' });
  const data = pickFields(req.body, ['season_id', 'start_date', 'end_date', 'jersey', 'positions', 'roster_role', 'status']);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  // Archiving closes the membership window (if still open) but keeps history.
  if (data.status === 'archived' && !row.end_date && !data.end_date) {
    data.end_date = new Date().toISOString().slice(0, 10);
  }
  data.updated_at = new Date().toISOString();
  res.json({ membership: crudUpdate('roster_memberships', req.params.id, data) });
});

// ── Tournaments ──────────────────────────────────────────────────────────
const TOURNAMENT_FIELDS = ['name', 'start_date', 'end_date', 'location', 'organizer', 'logo_url', 'visibility', 'published', 'archived'];

app.get('/api/tournaments', requireAdmin, (_req, res) => {
  res.json({
    tournaments: db.prepare(
      `SELECT tr.*,
              (SELECT COUNT(*) FROM divisions d WHERE d.tournament_id = tr.id) AS division_count,
              (SELECT COUNT(*) FROM tournament_entries te WHERE te.tournament_id = tr.id AND te.status = 'active') AS entry_count,
              (SELECT COUNT(*) FROM tournament_games tg WHERE tg.tournament_id = tr.id) AS game_count
       FROM tournaments tr ORDER BY tr.start_date DESC`
    ).all(),
  });
});

app.post('/api/tournaments', requireAdmin, (req, res) => {
  const data = pickFields(req.body, TOURNAMENT_FIELDS);
  if (!data.name || !data.start_date || !data.end_date) return res.status(400).json({ error: 'name, start_date, end_date are required' });
  data.slug = uniqueSlug('tournaments', data.name);
  const cols = Object.keys(data);
  const info = db.prepare(`INSERT INTO tournaments (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(data);
  res.status(201).json({ tournament: db.prepare('SELECT * FROM tournaments WHERE id = ?').get(info.lastInsertRowid) });
});

app.get('/api/tournaments/:id', requireAdmin, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  const divisions = db.prepare('SELECT * FROM divisions WHERE tournament_id = ? ORDER BY name').all(tournament.id);
  const entries = db.prepare(
    `SELECT te.*, t.name AS team_name, t.slug AS team_slug, d.name AS division_name,
            (SELECT COUNT(*) FROM event_rosters er WHERE er.entry_id = te.id) AS event_roster_count
     FROM tournament_entries te
     JOIN teams t ON t.id = te.team_id
     JOIN divisions d ON d.id = te.division_id
     WHERE te.tournament_id = ? ORDER BY d.name, t.name`
  ).all(tournament.id);
  const games = db.prepare(
    `SELECT tg.*, d.name AS division_name,
            ht.name AS home_team_name, at.name AS away_team_name
     FROM tournament_games tg
     JOIN divisions d ON d.id = tg.division_id
     JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
     JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
     WHERE tg.tournament_id = ? ORDER BY tg.game_date, tg.game_time`
  ).all(tournament.id);
  res.json({ tournament, divisions, entries, games });
});

app.put('/api/tournaments/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Tournament not found' });
  const data = pickFields(req.body, TOURNAMENT_FIELDS);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  data.updated_at = new Date().toISOString();
  res.json({ tournament: crudUpdate('tournaments', req.params.id, data) });
});

// ── Divisions ────────────────────────────────────────────────────────────
app.post('/api/tournaments/:id/divisions', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Tournament not found' });
  const { name, age_group = '', level = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO divisions (tournament_id, name, age_group, level) VALUES (?, ?, ?, ?)')
    .run(req.params.id, name, age_group, level);
  res.status(201).json({ division: db.prepare('SELECT * FROM divisions WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/divisions/:id', requireAdmin, (req, res) => {
  const hasEntries = db.prepare('SELECT 1 FROM tournament_entries WHERE division_id = ? LIMIT 1').get(req.params.id);
  if (hasEntries) return res.status(409).json({ error: 'Division has entries — withdraw or move them first' });
  const info = db.prepare('DELETE FROM divisions WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Division not found' });
  res.json({ ok: true });
});

// ── Tournament entries ───────────────────────────────────────────────────
app.post('/api/tournaments/:id/entries', requireAdmin, (req, res) => {
  const { division_id, team_id, seed = null, pool = '' } = req.body || {};
  const division = db.prepare('SELECT * FROM divisions WHERE id = ? AND tournament_id = ?').get(division_id, req.params.id);
  if (!division) return res.status(400).json({ error: 'Division does not belong to this tournament' });
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(team_id)) return res.status(400).json({ error: 'Unknown team' });
  try {
    const info = db.prepare(
      'INSERT INTO tournament_entries (tournament_id, division_id, team_id, seed, pool) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, division_id, team_id, seed, pool);
    res.status(201).json({ entry: db.prepare('SELECT * FROM tournament_entries WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'That team is already entered in this division' });
  }
});

app.put('/api/entries/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tournament_entries WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Entry not found' });
  const data = pickFields(req.body, ['seed', 'pool', 'placement', 'wins', 'losses', 'status']);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  res.json({ entry: crudUpdate('tournament_entries', req.params.id, data) });
});

// ── Event rosters (override season roster; guests welcome) ──────────────
app.get('/api/entries/:id/roster', requireAdmin, (req, res) => {
  const entry = db.prepare(
    `SELECT te.*, tr.start_date AS event_date FROM tournament_entries te
     JOIN tournaments tr ON tr.id = te.tournament_id WHERE te.id = ?`
  ).get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const eventRosterRows = db.prepare('SELECT * FROM event_rosters WHERE entry_id = ?').all(entry.id);
  const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(entry.team_id);
  const resolved = resolveEventRoster({ eventRosterRows, memberships, teamId: entry.team_id, eventDate: entry.event_date });

  const names = new Map(
    db.prepare(`SELECT id, first_name, last_name, slug, grad_year FROM players`).all().map(p => [p.id, p])
  );
  res.json({
    entry,
    source: eventRosterRows.length ? 'event' : 'season',
    roster: resolved.map(r => ({
      ...r,
      event_roster_id: eventRosterRows.find(e => e.player_id === r.player_id)?.id ?? null,
      player: names.get(r.player_id) || null,
    })),
  });
});

app.post('/api/entries/:id/roster', requireAdmin, (req, res) => {
  const entry = db.prepare('SELECT * FROM tournament_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const { player_id, is_guest = 0, jersey = '' } = req.body || {};
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) return res.status(400).json({ error: 'Unknown player' });
  try {
    const info = db.prepare('INSERT INTO event_rosters (entry_id, player_id, is_guest, jersey) VALUES (?, ?, ?, ?)')
      .run(entry.id, player_id, is_guest ? 1 : 0, jersey);
    res.status(201).json({ row: db.prepare('SELECT * FROM event_rosters WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Player is already on this event roster' });
  }
});

app.delete('/api/event-roster/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM event_rosters WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Event roster row not found' });
  res.json({ ok: true });
});

// ── Shared tournament games + appearances ────────────────────────────────
app.post('/api/tournaments/:id/games', requireAdmin, (req, res) => {
  const { division_id, home_entry_id, away_entry_id, game_date, game_time = '', field = '' } = req.body || {};
  if (!game_date) return res.status(400).json({ error: 'game_date is required' });
  if (home_entry_id === away_entry_id) return res.status(400).json({ error: 'Home and away entries must differ' });
  const home = db.prepare('SELECT * FROM tournament_entries WHERE id = ? AND tournament_id = ?').get(home_entry_id, req.params.id);
  const away = db.prepare('SELECT * FROM tournament_entries WHERE id = ? AND tournament_id = ?').get(away_entry_id, req.params.id);
  if (!home || !away) return res.status(400).json({ error: 'Both entries must belong to this tournament' });
  if (!db.prepare('SELECT 1 FROM divisions WHERE id = ? AND tournament_id = ?').get(division_id, req.params.id)) {
    return res.status(400).json({ error: 'Division does not belong to this tournament' });
  }
  const info = db.prepare(
    `INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, game_time, field)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, division_id, home_entry_id, away_entry_id, game_date, game_time, field);
  res.status(201).json({ game: db.prepare('SELECT * FROM tournament_games WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/tournament-games/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tournament_games WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Game not found' });
  const data = pickFields(req.body, ['game_date', 'game_time', 'field', 'home_score', 'away_score', 'status']);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No fields to update' });
  res.json({ game: crudUpdate('tournament_games', req.params.id, data) });
});

app.get('/api/tournament-games/:id/appearances', requireAdmin, (req, res) => {
  res.json({
    appearances: db.prepare(
      `SELECT a.*, p.first_name, p.last_name, t.name AS team_name
       FROM player_game_appearances a
       JOIN players p ON p.id = a.player_id
       JOIN tournament_entries te ON te.id = a.entry_id JOIN teams t ON t.id = te.team_id
       WHERE a.tournament_game_id = ? ORDER BY a.entry_id, a.lineup_slot`
    ).all(req.params.id),
  });
});

app.post('/api/tournament-games/:id/appearances', requireAdmin, (req, res) => {
  const game = db.prepare('SELECT * FROM tournament_games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { player_id, entry_id, starter = 0, position = '', lineup_slot = null } = req.body || {};
  if (entry_id !== game.home_entry_id && entry_id !== game.away_entry_id) {
    return res.status(400).json({ error: 'Entry is not part of this game' });
  }
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) return res.status(400).json({ error: 'Unknown player' });
  try {
    const info = db.prepare(
      `INSERT INTO player_game_appearances (tournament_game_id, player_id, entry_id, starter, position, lineup_slot)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(game.id, player_id, entry_id, starter ? 1 : 0, position, lineup_slot);
    res.status(201).json({ appearance: db.prepare('SELECT * FROM player_game_appearances WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Player already has an appearance in this game' });
  }
});

app.delete('/api/appearances/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM player_game_appearances WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Appearance not found' });
  res.json({ ok: true });
});

// ── Server-side imports (requirements §8) ────────────────────────────────
// Dry-run preview → duplicate resolution → transactional apply + audit.

const MAX_IMPORT_ROWS = 2000;

app.get('/api/imports/kinds', requireAdmin, (_req, res) => {
  res.json({ kinds: Object.entries(IMPORT_KINDS).map(([key, k]) => ({ key, ...k })) });
});

app.post('/api/imports/preview', requireAdmin, (req, res) => {
  const { kind, rows, resolutions = {} } = req.body || {};
  if (!IMPORT_KINDS[kind]) return res.status(400).json({ error: 'Unknown import kind' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(413).json({ error: `Too many rows (max ${MAX_IMPORT_ROWS})` });
  res.json({ plan: planImport(db, kind, rows, resolutions) });
});

app.post('/api/imports/apply', requireAdmin, (req, res) => {
  const { kind, rows, resolutions = {}, filename = '' } = req.body || {};
  if (!IMPORT_KINDS[kind]) return res.status(400).json({ error: 'Unknown import kind' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(413).json({ error: `Too many rows (max ${MAX_IMPORT_ROWS})` });
  const result = applyImport(db, kind, rows, resolutions, { filename, uploader: req.admin.email });
  res.status(result.blocked ? 409 : 200).json(result);
});

app.get('/api/imports/audits', requireAdmin, (_req, res) => {
  res.json({
    audits: db.prepare(
      'SELECT id, kind, filename, uploader_email, created_count, updated_count, skipped_count, error_count, created_at FROM import_audits ORDER BY id DESC LIMIT 50'
    ).all(),
  });
});

// One-time hygiene for impossible zeros imported before the
// zero-means-unmeasured guard. Dry-run by default; { apply: true } marks the
// entries excluded (reversible — the engine ignores excluded rows).
app.post('/api/admin/metrics/zero-cleanup', requireAdmin, (req, res) => {
  if ((req.body || {}).apply === true) {
    const { excluded, rows } = excludeInvalidZeroEntries(db);
    return res.json({ applied: true, excluded, summary: summarizeZeroReport(rows) });
  }
  const rows = findInvalidZeroEntries(db);
  res.json({
    applied: false,
    would_exclude: rows.length,
    summary: summarizeZeroReport(rows),
    entries: rows.slice(0, 200).map(r => ({
      player: `${r.first_name} ${r.last_name}`, metric: r.metric_key, game_date: r.game_date, game_type: r.game_type,
    })),
  });
});

// ── Staff access: admin assignment + invite, claim, scoped reads ─────────

function upsertStaffInvite(email) {
  // Existing account → no invite needed, assignment alone grants access.
  if (db.prepare('SELECT 1 FROM staff_users WHERE email = ?').get(email)) return null;
  const existing = db.prepare(
    `SELECT token FROM staff_invites WHERE email = ? AND claimed_at IS NULL AND expires_at > datetime('now')`
  ).get(email);
  if (existing) return existing.token;
  const token = randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO staff_invites (token, email, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`).run(token, email);
  return token;
}

function accessListFor(kind, id) {
  const table = kind === 'team' ? 'team_users' : 'tournament_users';
  const col = kind === 'team' ? 'team_id' : 'tournament_id';
  return db.prepare(
    `SELECT au.*, su.name AS claimed_name,
            CASE WHEN su.id IS NULL THEN 0 ELSE 1 END AS claimed,
            (SELECT token FROM staff_invites si WHERE si.email = au.email AND si.claimed_at IS NULL AND si.expires_at > datetime('now')) AS invite_token
     FROM ${table} au LEFT JOIN staff_users su ON su.email = au.email
     WHERE au.${col} = ? ORDER BY au.email`
  ).all(id);
}

for (const kind of ['team', 'tournament']) {
  const table = kind === 'team' ? 'team_users' : 'tournament_users';
  const col = kind === 'team' ? 'team_id' : 'tournament_id';
  const parent = kind === 'team' ? 'teams' : 'tournaments';
  const defaultRole = kind === 'team' ? 'coach' : 'director';

  app.get(`/api/${parent}/:id/access`, requireAdmin, (req, res) => {
    if (!db.prepare(`SELECT 1 FROM ${parent} WHERE id = ?`).get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ access: accessListFor(kind, req.params.id) });
  });

  app.post(`/api/${parent}/:id/access`, requireAdmin, (req, res) => {
    if (!db.prepare(`SELECT 1 FROM ${parent} WHERE id = ?`).get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const email = String((req.body || {}).email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    try {
      db.prepare(`INSERT INTO ${table} (${col}, email, role) VALUES (?, ?, ?)`).run(req.params.id, email, defaultRole);
    } catch {
      return res.status(409).json({ error: 'That email already has access' });
    }
    const inviteToken = upsertStaffInvite(email);
    res.status(201).json({ access: accessListFor(kind, req.params.id), invite_token: inviteToken });
  });

  app.delete(`/api/${kind}-access/:id`, requireAdmin, (req, res) => {
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ ok: true });
  });
}

// Public: staff claim (mirrors the player claim flow).
app.get('/api/staff-invites/:token', (req, res) => {
  const invite = db.prepare('SELECT * FROM staff_invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  const teams = db.prepare('SELECT t.name FROM team_users tu JOIN teams t ON t.id = tu.team_id WHERE tu.email = ?').all(invite.email).map(r => r.name);
  const tournaments = db.prepare('SELECT tr.name FROM tournament_users tu JOIN tournaments tr ON tr.id = tu.tournament_id WHERE tu.email = ?').all(invite.email).map(r => r.name);
  res.json({
    email: invite.email,
    claimed: !!invite.claimed_at,
    expired: db.prepare(`SELECT 1 FROM staff_invites WHERE token = ? AND expires_at <= datetime('now')`).get(req.params.token) != null,
    teams, tournaments,
  });
});

app.post('/api/staff-invites/:token/claim', (req, res) => {
  const invite = db.prepare(`SELECT * FROM staff_invites WHERE token = ? AND expires_at > datetime('now')`).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite link is invalid or has expired' });
  if (invite.claimed_at) return res.status(409).json({ error: 'This invite has already been claimed' });

  const name = String((req.body || {}).name || '').trim();
  const password = String((req.body || {}).password || '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM staff_users WHERE email = ?').get(invite.email)) {
    return res.status(409).json({ error: 'An account with this email already exists — sign in instead' });
  }

  const info = db.prepare('INSERT INTO staff_users (email, name, password_hash) VALUES (?, ?, ?)')
    .run(invite.email, name, hashPassword(password));
  db.prepare(`UPDATE staff_invites SET claimed_at = datetime('now') WHERE token = ?`).run(invite.token);
  const token = createStaffSession(info.lastInsertRowid);
  res.status(201).json({ token, admin: { email: invite.email, name, role: 'staff' } });
});

// Staff reads — assignment-scoped, limited fields (requirements §2 rule:
// roster access does not expose the full player profile).
app.get('/api/staff/overview', requireStaff, (req, res) => {
  const teams = db.prepare(
    `SELECT t.id, t.name, t.slug, t.age_group, t.level, o.name AS organization_name, tu.role
     FROM team_users tu JOIN teams t ON t.id = tu.team_id JOIN organizations o ON o.id = t.organization_id
     WHERE tu.email = ? ORDER BY t.name`
  ).all(req.staff.email);
  const tournaments = db.prepare(
    `SELECT tr.id, tr.name, tr.slug, tr.start_date, tr.end_date, tr.location, tr.published, tu.role
     FROM tournament_users tu JOIN tournaments tr ON tr.id = tu.tournament_id
     WHERE tu.email = ? ORDER BY tr.start_date DESC`
  ).all(req.staff.email);
  res.json({ staff: { email: req.staff.email, name: req.staff.name }, teams, tournaments });
});

app.get('/api/staff/teams/:id', requireStaff, (req, res) => {
  if (!staffCanViewTeam(req.staff, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const team = db.prepare(
    'SELECT t.*, o.name AS organization_name FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.id = ?'
  ).get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Not found' });
  // Limited roster fields only — no DOB, no contact, no private profile data.
  const roster = db.prepare(
    `SELECT rm.jersey, rm.positions, rm.start_date, rm.end_date, rm.status, rm.season_id,
            s.label AS season_label, p.first_name, p.last_name, p.grad_year,
            CASE WHEN p.is_public = 1 THEN p.slug ELSE NULL END AS public_slug
     FROM roster_memberships rm
     JOIN players p ON p.id = rm.player_id
     LEFT JOIN seasons s ON s.id = rm.season_id
     WHERE rm.team_id = ? AND rm.status = 'active'
     ORDER BY p.last_name, p.first_name`
  ).all(team.id);
  const entries = db.prepare(
    `SELECT te.*, tr.name AS tournament_name, tr.start_date, d.name AS division_name
     FROM tournament_entries te JOIN tournaments tr ON tr.id = te.tournament_id JOIN divisions d ON d.id = te.division_id
     WHERE te.team_id = ? ORDER BY tr.start_date DESC`
  ).all(team.id);
  res.json({ team, roster, entries });
});

app.get('/api/staff/tournaments/:id', requireStaff, (req, res) => {
  if (!staffCanViewTournament(req.staff, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Not found' });
  const divisions = db.prepare('SELECT * FROM divisions WHERE tournament_id = ? ORDER BY name').all(tournament.id);
  const entries = db.prepare(
    `SELECT te.*, t.name AS team_name, d.name AS division_name
     FROM tournament_entries te JOIN teams t ON t.id = te.team_id JOIN divisions d ON d.id = te.division_id
     WHERE te.tournament_id = ? ORDER BY d.name, t.name`
  ).all(tournament.id);
  const games = db.prepare(
    `SELECT tg.*, d.name AS division_name, ht.name AS home_team_name, at.name AS away_team_name
     FROM tournament_games tg JOIN divisions d ON d.id = tg.division_id
     JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
     JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
     WHERE tg.tournament_id = ? ORDER BY tg.game_date, tg.game_time`
  ).all(tournament.id);
  res.json({ tournament, divisions, entries, games });
});

// ── Connected views (roadmap Phase 3, requirements §4–§6, §9) ────────────
// Permission-aware read endpoints behind the /teams/{slug} and
// /tournaments/{slug} dashboards. Visibility defaults per §9: team
// dashboards are private (admins, assigned staff, and players on the team);
// tournament dashboards are private until published.

function resolveViewer(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { kind: 'anon' };
  const adminRow = db.prepare(
    `SELECT a.email FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (adminRow) return { kind: 'admin', email: adminRow.email };
  const staffRow = staffFromToken(token);
  if (staffRow) return { kind: 'staff', email: staffRow.email };
  const playerRow = playerFromToken(token);
  if (playerRow) return { kind: 'player', playerId: playerRow.id, email: playerRow.email };
  return { kind: 'anon' };
}

function teamGames(teamId) {
  return db.prepare(
    `SELECT tg.*, tr.name AS tournament_name, tr.slug AS tournament_slug, d.name AS division_name,
            he.team_id AS home_team_id, ae.team_id AS away_team_id,
            ht.name AS home_team_name, at.name AS away_team_name
     FROM tournament_games tg
     JOIN tournaments tr ON tr.id = tg.tournament_id
     JOIN divisions d ON d.id = tg.division_id
     JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
     JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
     WHERE he.team_id = ? OR ae.team_id = ?
     ORDER BY tg.game_date DESC, tg.game_time DESC`
  ).all(teamId, teamId);
}

// Qualification minimums are configurable per request (?min_pa=&min_ip=&min_samples=).
function minsFromQuery(q) {
  const n = v => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
  return {
    pa: n(q.min_pa) ?? DEFAULT_MINS.pa,
    ip: n(q.min_ip) ?? DEFAULT_MINS.ip,
    samples: n(q.min_samples) ?? DEFAULT_MINS.samples,
  };
}

function boardsFor(playerAggs, mins, teamNameFor) {
  return {
    hitting: leaderboard(playerAggs, 'hitting', mins, teamNameFor),
    pitching: leaderboard(playerAggs, 'pitching', mins, teamNameFor),
    defense: leaderboard(playerAggs, 'defense', mins, teamNameFor),
    speed: leaderboard(playerAggs, 'speed', mins, teamNameFor),
    overall: overallLeaderboard(playerAggs, mins, teamNameFor),
  };
}

// Top qualified row of each board — feeds the Pro-Day-styled performer cards.
function topPerformers(boards) {
  const out = {};
  for (const [cat, board] of Object.entries(boards)) {
    const top = board.rows.find(r => !r.limited) || board.rows[0] || null;
    out[cat] = top ? { ...top, metric: board.metric } : null;
  }
  return out;
}

app.get('/api/view/teams/:slug', (req, res) => {
  const team = db.prepare(
    'SELECT t.*, o.name AS organization_name FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.slug = ?'
  ).get(req.params.slug);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // §9 default: team dashboards are private.
  const viewer = resolveViewer(req);
  const allowed =
    viewer.kind === 'admin' ||
    (viewer.kind === 'staff' && staffCanViewTeam(viewer, team.id)) ||
    (viewer.kind === 'player' && !!db.prepare(
      'SELECT 1 FROM roster_memberships WHERE team_id = ? AND player_id = ?'
    ).get(team.id, viewer.playerId));
  if (!allowed) return res.status(viewer.kind === 'anon' ? 401 : 403).json({ error: 'This team dashboard is private', private: true });

  const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(team.id);
  const entries = db.prepare(
    `SELECT te.*, tr.name AS tournament_name, tr.slug AS tournament_slug, tr.start_date, tr.end_date, d.name AS division_name
     FROM tournament_entries te JOIN tournaments tr ON tr.id = te.tournament_id JOIN divisions d ON d.id = te.division_id
     WHERE te.team_id = ? ORDER BY tr.start_date DESC`
  ).all(team.id);
  const games = teamGames(team.id);

  // Optional event context: ?tournament=<slug> narrows roster + games (§4 filters).
  const tournamentSlug = String(req.query.tournament || '').trim();
  const contextEntry = tournamentSlug ? entries.find(e => e.tournament_slug === tournamentSlug) : null;

  let roster;
  if (contextEntry) {
    const eventRosterRows = db.prepare('SELECT * FROM event_rosters WHERE entry_id = ?').all(contextEntry.id);
    roster = resolveEventRoster({ eventRosterRows, memberships, teamId: team.id, eventDate: contextEntry.start_date });
  } else {
    const today = new Date().toISOString().slice(0, 10);
    roster = resolveEventRoster({ eventRosterRows: [], memberships, teamId: team.id, eventDate: today });
  }
  // Limited player fields (§2 rule), public slug only when the profile is public.
  const names = new Map(db.prepare('SELECT id, first_name, last_name, grad_year, is_public, slug FROM players').all().map(p => [p.id, p]));
  const rosterOut = roster.map(r => {
    const p = names.get(r.player_id) || {};
    return {
      first_name: p.first_name, last_name: p.last_name, grad_year: p.grad_year,
      jersey: r.jersey, isGuest: r.isGuest, source: r.source,
      public_slug: p.is_public ? p.slug : null,
    };
  }).sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));

  // ── Aggregate filters (Phase 4 §team/season dashboards) ────────────────
  const q = req.query;
  const seasonId = q.season && db.prepare('SELECT 1 FROM seasons WHERE id = ?').get(q.season) ? Number(q.season) : null;
  const seasonRow = seasonId ? db.prepare('SELECT * FROM seasons WHERE id = ?').get(seasonId) : null;
  const filters = {
    entry: contextEntry
      ? { ...contextEntry, start_date: contextEntry.start_date, end_date: contextEntry.end_date }
      : null,
    seasonId,
    from: String(q.from || '').trim() || null,
    to: String(q.to || '').trim() || null,
    gameTypes: String(q.game_type || '').trim() ? [String(q.game_type).trim()] : null,
    playerId: String(q.player || '').trim() || null,
    position: String(q.position || '').trim() || null,
    opponent: String(q.opponent || '').trim() || null,
  };
  const mins = minsFromQuery(q);
  const attributed = attributedGames(db, team, filters);
  const playerAggs = aggregateByPlayer(attributed);
  const boards = boardsFor(playerAggs, mins, () => team.name);

  // Shared-game record honors the same season/tournament/date scoping.
  const inScope = g =>
    (!contextEntry || g.tournament_slug === tournamentSlug) &&
    (!seasonRow || (g.game_date >= seasonRow.start_date && g.game_date <= seasonRow.end_date)) &&
    (!filters.from || g.game_date >= filters.from) &&
    (!filters.to || g.game_date <= filters.to);
  const scopedGames = games.filter(inScope);
  const finals = scopedGames.filter(g => g.status === 'final' && g.home_score != null && g.away_score != null);
  const forAgainst = finals.reduce((acc, g) => {
    const home = g.home_team_id === team.id;
    acc.rs += home ? g.home_score : g.away_score;
    acc.ra += home ? g.away_score : g.home_score;
    return acc;
  }, { rs: 0, ra: 0 });
  const wins = finals.filter(g => (g.home_team_id === team.id ? g.home_score > g.away_score : g.away_score > g.home_score)).length;
  const losses = finals.filter(g => (g.home_team_id === team.id ? g.home_score < g.away_score : g.away_score < g.home_score)).length;
  const ties = finals.length - wins - losses;

  // Roster comparison table rows (client-sortable), one per player with data.
  const comparison = playerAggs.map(a => ({
    player_id: a.player.id, name: `${a.player.first_name} ${a.player.last_name}`,
    slug: a.player.slug, position: a.player.position, isGuest: a.player.isGuest,
    games: a.games_played,
    pa: a.rates.pa, avg: a.rates.avg, obp: a.rates.obp, slg: a.rates.slg, ops: a.rates.ops,
    k_bb: a.rates.k_bb, sb: a.rates.stolen_bases, errors: a.rates.errors,
    avg_ev: a.measured.avg_exit_velo.value, max_ev: a.measured.max_exit_velo.value,
    hard_hit_pct: a.measured.hard_hit_pct.value,
    strike_pct: a.measured.strike_pct.value, max_velo: a.measured.max_velo.value,
    ip: a.rates.ip, k_bb_pitching: a.rates.k_bb_pitching,
    arm: a.measured.arm_strength.value, throw_acc: a.measured.throw_accuracy.value,
    fielding: a.measured.fielding_success.value,
    h_to_first: a.measured.home_to_first.value, sprint: a.measured.sprint_speed.value,
  }));

  // Trends (season dashboard): per-date series for headline metrics.
  const TREND_KEYS = ['avg_exit_velo', 'max_velo', 'strike_pct', 'bs_h', 'bs_r'];
  const trends = (seasonId || q.trends === '1')
    ? TREND_KEYS.map(key => ({ key, series: trendSeries(attributed, key) })).filter(t => t.series.length > 1)
    : null;

  const visibleGames = scopedGames;

  const { external_id: _x, ...publicTeam } = team;
  res.json({
    seasons: db.prepare('SELECT id, label, start_date, end_date, status FROM seasons ORDER BY start_date DESC').all(),
    season: seasonRow ? { id: seasonRow.id, label: seasonRow.label, start_date: seasonRow.start_date, end_date: seasonRow.end_date } : null,
    filters: {
      season: seasonId, tournament: tournamentSlug || null, from: filters.from, to: filters.to,
      game_type: filters.gameTypes?.[0] || null, player: filters.playerId, position: filters.position,
    },
    aggregates: {
      record: { wins, losses, ties },
      runs_scored: finals.length ? forAgainst.rs : null,
      runs_allowed: finals.length ? forAgainst.ra : null,
      run_diff: finals.length ? forAgainst.rs - forAgainst.ra : null,
      // scheduled/linked team games in scope — player performance records
      // are a separate count (feedback: don't conflate the two)
      games_tracked: scopedGames.length,
      player_games: attributed.length,
      players_with_data: playerAggs.length,
      blocks: teamCategoryBlocks(attributed),
    },
    comparison,
    leaderboards: boards,
    top_performers: topPerformers(boards),
    trends,
    calc: calcStamp(mins),
    viewer: viewer.kind,
    team: publicTeam,
    summary: {
      wins, losses,
      tournaments_played: entries.length,
      games_total: games.length,
      games_final: finals.length,
      roster_count: rosterOut.length,
      latest_event: entries[0] ? { name: entries[0].tournament_name, slug: entries[0].tournament_slug, date: entries[0].start_date, placement: entries[0].placement } : null,
    },
    context: contextEntry ? { tournament: contextEntry.tournament_name, tournament_slug: tournamentSlug, division: contextEntry.division_name, roster_source: 'event' } : null,
    roster: rosterOut,
    events: entries.map(e => ({
      tournament_name: e.tournament_name, tournament_slug: e.tournament_slug,
      division_name: e.division_name, start_date: e.start_date, end_date: e.end_date,
      seed: e.seed, placement: e.placement, wins: e.wins, losses: e.losses, status: e.status,
    })),
    games: visibleGames.map(g => ({
      id: g.id, date: g.game_date, time: g.game_time, field: g.field, status: g.status,
      tournament_name: g.tournament_name, tournament_slug: g.tournament_slug, division_name: g.division_name,
      home_team_name: g.home_team_name, away_team_name: g.away_team_name,
      home_score: g.home_score, away_score: g.away_score,
      is_home: g.home_team_id === team.id,
    })),
  });
});

app.get('/api/view/tournaments/:slug', (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE slug = ?').get(req.params.slug);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  // §9: private during review; public once published with public visibility.
  const isPublic = tournament.published === 1 && tournament.visibility === 'public';
  if (!isPublic) {
    const viewer = resolveViewer(req);
    const allowed = viewer.kind === 'admin' || (viewer.kind === 'staff' && staffCanViewTournament(viewer, tournament.id));
    if (!allowed) {
      return res.status(viewer.kind === 'anon' ? 401 : 403).json({ error: 'This tournament has not been published', unpublished: true });
    }
  }

  const divisions = db.prepare('SELECT * FROM divisions WHERE tournament_id = ? ORDER BY name').all(tournament.id);
  const entries = db.prepare(
    `SELECT te.*, t.name AS team_name, t.slug AS team_slug, t.logo_url, o.name AS organization_name, d.name AS division_name,
            (SELECT COUNT(*) FROM event_rosters er WHERE er.entry_id = te.id) AS event_roster_count
     FROM tournament_entries te
     JOIN teams t ON t.id = te.team_id JOIN organizations o ON o.id = t.organization_id
     JOIN divisions d ON d.id = te.division_id
     WHERE te.tournament_id = ? AND te.status != 'archived' ORDER BY d.name, te.seed, t.name`
  ).all(tournament.id);
  const games = db.prepare(
    `SELECT tg.*, d.name AS division_name, ht.name AS home_team_name, ht.slug AS home_team_slug,
            at.name AS away_team_name, at.slug AS away_team_slug
     FROM tournament_games tg JOIN divisions d ON d.id = tg.division_id
     JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
     JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
     WHERE tg.tournament_id = ? ORDER BY tg.game_date, tg.game_time`
  ).all(tournament.id);

  const finals = games.filter(g => g.status === 'final').length;
  const playerCount = db.prepare(
    `SELECT COUNT(DISTINCT er.player_id) c FROM event_rosters er
     JOIN tournament_entries te ON te.id = er.entry_id WHERE te.tournament_id = ?`
  ).get(tournament.id).c;

  // ── Aggregates (Phase 4): standings + event-wide player leaderboards ───
  const mins = minsFromQuery(req.query);
  const standingsRows = standings(db, tournament.id);

  // Pool attributed games across every entry; the event roster names the
  // represented team. A game attributes once even if a guest appears on
  // two entries in the same event.
  const teamNameByPlayer = new Map();
  const seenGameIds = new Set();
  const pooled = [];
  for (const e of entries) {
    const rows = attributedGames(db, { id: e.team_id }, {
      entry: { id: e.id, start_date: tournament.start_date, end_date: tournament.end_date },
    });
    for (const r of rows) {
      if (!teamNameByPlayer.has(r.player_id)) teamNameByPlayer.set(r.player_id, e.team_name);
      if (seenGameIds.has(r.game_id)) continue;
      seenGameIds.add(r.game_id);
      pooled.push(r);
    }
  }
  const playerAggs = aggregateByPlayer(pooled);
  const boards = boardsFor(playerAggs, mins, id => teamNameByPlayer.get(id) || null);

  const { external_id: _x, ...publicTournament } = tournament;
  res.json({
    standings: standingsRows,
    leaderboards: boards,
    top_performers: topPerformers(boards),
    players_with_data: playerAggs.length,
    calc: calcStamp(mins),
    tournament: publicTournament,
    // §5: every tournament view states how much of the event is analyzed.
    coverage: { games_total: games.length, games_final: finals },
    counts: { divisions: divisions.length, teams: entries.length, players: playerCount },
    divisions: divisions.map(d => ({
      id: d.id, name: d.name, age_group: d.age_group, level: d.level,
      champion: entries.find(e => e.division_id === d.id && /^(1|1st|first|champion)/i.test(e.placement || ''))?.team_name || null,
    })),
    entries: entries.map(e => ({
      division_id: e.division_id, division_name: e.division_name,
      team_name: e.team_name, team_slug: e.team_slug, organization_name: e.organization_name,
      seed: e.seed, pool: e.pool, placement: e.placement, wins: e.wins, losses: e.losses,
      event_roster_count: e.event_roster_count,
    })),
    games: games.map(g => ({
      id: g.id, date: g.game_date, time: g.game_time, field: g.field, status: g.status,
      division_name: g.division_name,
      home_team_name: g.home_team_name, home_team_slug: g.home_team_slug, home_score: g.home_score,
      away_team_name: g.away_team_name, away_team_slug: g.away_team_slug, away_score: g.away_score,
    })),
  });
});

// ── Diamond Metrics Command (internal analyst platform) ─────────────────
const { createJob } = mountCommandRoutes(app, { db, requireInternal });
mountCommandMediaRoutes(app, { db, requireInternal });
mountCommandRadarRoutes(app, { db, requireInternal });
mountCommandMeasureRoutes(app, { db, requireInternal });
mountCommandReviewRoutes(app, { db, requireInternal });
mountCommandOpsRoutes(app, { db, requireInternal, createJob });
// Media processing: inline worker in dev / single-service deployments;
// DM_INLINE_WORKER=0 turns it off when the dedicated Render worker runs.
if (process.env.DM_INLINE_WORKER !== '0') startInlineWorker(db);

// Nightly SQLite snapshot to the storage adapter (DM_BACKUPS=0 disables).
startBackupScheduler(db);

// Terminal error handler — must be registered after every route.
app.use(errorHandler);

app.listen(PORT, () => {
  log('info', 'api_started', { port: Number(PORT), env: ENV, storage: process.env.DM_STORAGE || 'local' });
});
