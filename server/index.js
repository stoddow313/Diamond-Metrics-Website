import express from 'express';
import { randomBytes } from 'node:crypto';
import { db, verifyPassword, newSlug } from './db.js';
import {
  METRICS, CATEGORIES, ATTRIBUTES, GAME_TYPES,
  VALID_METRIC_KEYS, heroSetForPosition,
} from './metricCatalog.js';

const app = express();
// Render (and most hosts) inject PORT; DM_API_PORT is the local-dev override.
const PORT = process.env.PORT || process.env.DM_API_PORT || 3001;
const SESSION_TTL_DAYS = 30;

app.use(express.json());

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

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(email).toLowerCase().trim());
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = createSession(admin.id);
  res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: 'admin' } });
});

app.get('/api/auth/me', requireAdmin, (req, res) => {
  res.json({ admin: { ...req.admin, role: 'admin' } });
});

app.post('/api/auth/logout', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
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

app.get('/api/public/players/:slug', (req, res) => {
  const player = db.prepare(
    `SELECT id, ${PUBLIC_PLAYER_COLS} FROM players WHERE slug = ? AND is_public = 1`
  ).get(req.params.slug);
  if (!player) return res.status(404).json({ error: 'Player not found' });

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
  res.json({
    player: publicPlayer,
    games,
    metrics,
    heroKeys: heroSetForPosition(player.primary_position),
    catalog: { metrics: METRICS, categories: CATEGORIES },
  });
});

app.listen(PORT, () => {
  console.log(`[api] Diamond Metrics API listening on http://localhost:${PORT}`);
});
