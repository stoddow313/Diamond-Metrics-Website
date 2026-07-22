import express from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, hashPassword, verifyPassword, newSlug, UPLOADS_DIR } from './db.js';
import {
  METRICS, CATEGORIES, ATTRIBUTES, GAME_TYPES,
  VALID_METRIC_KEYS, heroSetForPosition, positionGroup,
} from './metricCatalog.js';

const app = express();
// Render (and most hosts) inject PORT; DM_API_PORT is the local-dev override.
const PORT = process.env.PORT || process.env.DM_API_PORT || 3001;
const SESSION_TTL_DAYS = 30;

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

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const row = db.prepare(
    `SELECT s.token, a.id, a.email, a.name FROM sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (!row) return res.status(401).json({ error: 'Session expired or invalid' });

  req.admin = { id: row.id, email: row.email, name: row.name };
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

// One login endpoint for both roles: admins first, then claimed player accounts.
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normEmail = String(email).toLowerCase().trim();

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(normEmail);
  if (admin && verifyPassword(password, admin.password_hash)) {
    const token = createSession(admin.id);
    return res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: 'admin' } });
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

  res.status(401).json({ error: 'Invalid email or password' });
});

app.get('/api/auth/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const adminRow = db.prepare(
    `SELECT a.id, a.email, a.name FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (adminRow) return res.json({ admin: { ...adminRow, role: 'admin' } });

  const playerRow = playerFromToken(token);
  if (playerRow) {
    return res.json({
      admin: { email: playerRow.email, name: `${playerRow.first_name} ${playerRow.last_name}`, role: 'player', slug: playerRow.slug },
    });
  }
  res.status(401).json({ error: 'Session expired or invalid' });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    db.prepare('DELETE FROM player_sessions WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

// ── Metric catalog (public — the profile renderer needs it too) ─────────

app.get('/api/metrics/catalog', (_req, res) => {
  res.json({ metrics: METRICS, categories: CATEGORIES, attributes: ATTRIBUTES, gameTypes: GAME_TYPES });
});

// ── Players (admin) ──────────────────────────────────────────────────────

const PLAYER_FIELDS = [
  'first_name', 'last_name', 'school', 'city', 'state', 'grad_year',
  'primary_position', 'secondary_position', 'height', 'weight_lbs',
  'bats', 'throws', 'committed_to', 'college_projection',
  'overall_rating', 'photo_url', 'is_public',
  ...ATTRIBUTES.map(a => `attr_${a}`),
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
  res.json({ player, games, stats });
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
  const info = db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Player not found' });
  res.json({ ok: true });
});

// ── Games + stats (admin) ────────────────────────────────────────────────

app.post('/api/players/:id/games', requireAdmin, (req, res) => {
  const player = db.prepare('SELECT id FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { game_date, game_type = 'game', opponent = '', location = '', notes = '' } = req.body || {};
  if (!game_date) return res.status(400).json({ error: 'game_date is required' });
  if (!GAME_TYPES.includes(game_type)) return res.status(400).json({ error: `game_type must be one of: ${GAME_TYPES.join(', ')}` });

  const info = db.prepare(
    'INSERT INTO games (player_id, game_date, game_type, opponent, location, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(player.id, game_date, game_type, opponent, location, notes);
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

  const apply = db.transaction(() => {
    for (const [key, raw] of Object.entries(stats)) {
      if (raw === null || raw === '') { clear.run(game.id, key); continue; }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw Object.assign(new Error(`Invalid value for ${key}`), { status: 400 });
      upsert.run(game.id, key, value);
    }
  });

  try {
    apply();
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const saved = db.prepare('SELECT metric_key, value FROM stat_entries WHERE game_id = ?').all(game.id);
  res.json({ stats: Object.fromEntries(saved.map(r => [r.metric_key, r.value])) });
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

  const { id: _id, ...publicPlayer } = player;
  return {
    player: publicPlayer,
    games,
    metrics,
    heroKeys: heroSetForPosition(player.primary_position),
    catalog: { metrics: METRICS, categories: CATEGORIES },
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

function buildCardPayload(player) {
  const proDay = db.prepare(
    `SELECT * FROM games WHERE player_id = ? AND game_type = 'pro_day'
     ORDER BY game_date DESC, id DESC LIMIT 1`
  ).get(player.id);
  if (!proDay) return null;

  const ownStats = {};
  for (const row of db.prepare('SELECT metric_key, value FROM stat_entries WHERE game_id = ?').all(proDay.id)) {
    ownStats[row.metric_key] = row.value;
  }

  // Card shows measured testing results — box-score counting stats stay off it.
  const results = METRICS
    .filter(m => m.category !== 'box' && ownStats[m.key] !== undefined)
    .map(m => ({ key: m.key, label: m.label, unit: m.unit, decimals: m.decimals, value: ownStats[m.key] }));

  // Front headline chips: position-adaptive hero metrics measured at this event.
  const chips = heroSetForPosition(player.primary_position)
    .filter(k => ownStats[k] !== undefined)
    .slice(0, 4)
    .map(k => {
      const m = METRIC_BY_KEY.get(k);
      return { key: k, label: m.label, unit: m.unit, decimals: m.decimals, value: ownStats[k] };
    });

  // ── Rankings among participants of the same event (name + date) ──
  // Every athlete who attended counts toward rankings — including those whose
  // own profiles are private. Only aggregate ranks are exposed, never their
  // names or values, so nothing private leaks.
  const participants = db.prepare(
    `SELECT g.id AS game_id, p.id AS player_id, p.primary_position, p.overall_rating
     FROM games g JOIN players p ON p.id = g.player_id
     WHERE g.game_type = 'pro_day' AND g.game_date = ? AND LOWER(TRIM(g.opponent)) = ?`
  ).all(proDay.game_date, (proDay.opponent || '').trim().toLowerCase());

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
      date: proDay.game_date,
      name: proDay.opponent || 'Pro Day',
      location: proDay.location || '',
    },
    chips,
    results,
    rankings,
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
  res.json({ ...payload, is_public: !!req.player.is_public });
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
  'primary_position', 'secondary_position', 'height', 'weight_lbs',
  'bats', 'throws', 'committed_to',
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

app.listen(PORT, () => {
  console.log(`[api] Diamond Metrics API listening on http://localhost:${PORT}`);
});
