// Server-side import engine (requirements doc §8).
//
// One pipeline for every import kind:
//   planImport(db, kind, rows)                  → dry-run: per-row action plan
//   applyImport(db, kind, rows, resolutions, m) → executes + audit record
//
// Guarantees:
// - Row-level validation with actionable messages; one bad row never blocks
//   the rest.
// - Idempotent re-import: rows resolve to update (or skip) via external ids
//   and natural keys, never silent duplicates.
// - Possible duplicate players are FLAGGED with candidates, not auto-created;
//   the admin resolves each (link to existing / create new) before apply.
// - Every apply writes an import_audits row (uploader, file, counts, report).

import { slugify } from './rosterLogic.js';
import { VALID_METRIC_KEYS, ZERO_UNMEASURED_KEYS, GAME_TYPES } from './metricCatalog.js';

export const IMPORT_KINDS = {
  teams: {
    label: 'Organizations & Teams',
    columns: ['organization', 'org_type', 'team_name', 'age_group', 'level', 'team_external_id'],
    required: ['organization', 'team_name'],
  },
  season_roster: {
    label: 'Season Roster',
    columns: ['team', 'season_label', 'first_name', 'last_name', 'grad_year', 'date_of_birth', 'jersey', 'positions', 'start_date', 'end_date', 'player_external_id'],
    required: ['team', 'first_name', 'last_name', 'start_date'],
  },
  tournament_entries: {
    label: 'Tournament Entries',
    columns: ['tournament', 'division', 'team', 'seed', 'pool'],
    required: ['tournament', 'division', 'team'],
  },
  event_rosters: {
    label: 'Event Rosters',
    columns: ['tournament', 'division', 'team', 'first_name', 'last_name', 'is_guest', 'jersey', 'player_external_id'],
    required: ['tournament', 'division', 'team', 'first_name', 'last_name'],
  },
  games: {
    label: 'Tournament Games',
    columns: ['tournament', 'division', 'home_team', 'away_team', 'game_date', 'game_time', 'field', 'home_score', 'away_score', 'game_external_id'],
    required: ['tournament', 'division', 'home_team', 'away_team', 'game_date'],
  },
  metrics: {
    label: 'Contextualized Metrics',
    columns: ['first_name', 'last_name', 'player_external_id', 'game_date', 'game_type', 'opponent', '…metric columns (keys or labels)'],
    required: ['game_date'],
  },
};

const norm = s => String(s ?? '').trim();
const normKey = s => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function isoDate(value) {
  const s = norm(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO datetimes (JSON-serialized Date cells): spreadsheet dates are
  // timezone-less, so the leading date component is the intended day —
  // never round-trip through local time, which shifts it near midnight.
  const isoPrefix = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoPrefix) return isoPrefix[1];
  const d = new Date(s);
  return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Reference resolvers ──────────────────────────────────────────────────

function findTeam(db, ref) {
  const r = norm(ref);
  if (!r) return { team: null };
  const byExternal = db.prepare('SELECT * FROM teams WHERE external_id = ?').get(r);
  if (byExternal) return { team: byExternal };
  const bySlug = db.prepare('SELECT * FROM teams WHERE slug = ?').get(slugify(r));
  if (bySlug) return { team: bySlug };
  const byName = db.prepare('SELECT * FROM teams WHERE LOWER(name) = LOWER(?)').all(r);
  if (byName.length === 1) return { team: byName[0] };
  if (byName.length > 1) return { team: null, ambiguous: byName };
  return { team: null };
}

function findTournament(db, ref) {
  const r = norm(ref);
  if (!r) return null;
  return db.prepare('SELECT * FROM tournaments WHERE external_id = ? OR slug = ? OR LOWER(name) = LOWER(?)')
    .get(r, slugify(r), r) || null;
}

// Duplicate rule (§8): external id wins; then name+DOB; then name+grad year.
// A bare name match is a flagged possible-duplicate, never a silent link or
// a silent create.
export function resolvePlayer(db, row) {
  const ext = norm(row.player_external_id);
  if (ext) {
    const p = db.prepare('SELECT * FROM players WHERE external_id = ?').get(ext);
    if (p) return { player: p, matchedBy: 'external_id' };
  }
  const first = norm(row.first_name), last = norm(row.last_name);
  if (!first || !last) return { player: null };
  const named = db.prepare('SELECT * FROM players WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)').all(first, last);
  if (named.length === 0) return { player: null };

  const dob = isoDate(row.date_of_birth);
  if (dob) {
    const exact = named.filter(p => p.date_of_birth === dob);
    if (exact.length === 1) return { player: exact[0], matchedBy: 'name+dob' };
  }
  const grad = Number(row.grad_year) || null;
  if (grad) {
    const exact = named.filter(p => p.grad_year === grad);
    if (exact.length === 1) return { player: exact[0], matchedBy: 'name+grad_year' };
  }
  return { player: null, candidates: named };
}

function playerCandidatePayload(candidates) {
  return candidates.map(p => ({
    id: p.id, name: `${p.first_name} ${p.last_name}`, grad_year: p.grad_year,
    date_of_birth: p.date_of_birth, slug: p.slug,
  }));
}

// ── Row processors (plan + apply share one code path) ────────────────────
// Each returns { action, message, candidates? } and performs writes only
// when ctx.apply is true. resolution: { player_id } | { create: true }.

const processors = {
  teams(db, row, ctx) {
    const orgName = norm(row.organization), teamName = norm(row.team_name);
    if (!orgName || !teamName) return { action: 'error', message: 'organization and team_name are required' };

    const ext = norm(row.team_external_id) || null;
    let existing = ext ? db.prepare('SELECT * FROM teams WHERE external_id = ?').get(ext) : null;
    if (!existing) {
      const { team, ambiguous } = findTeam(db, teamName);
      if (ambiguous) return { action: 'error', message: `Multiple teams named "${teamName}" — add team_external_id` };
      if (team && norm(row.age_group) && team.age_group && norm(row.age_group) !== team.age_group) existing = null;
      else existing = team;
    }

    if (existing) {
      if (ctx.apply) {
        db.prepare('UPDATE teams SET age_group = COALESCE(NULLIF(?, \'\'), age_group), level = COALESCE(NULLIF(?, \'\'), level), external_id = COALESCE(?, external_id) WHERE id = ?')
          .run(norm(row.age_group), norm(row.level), ext, existing.id);
      }
      return { action: 'update', message: `Updates team "${existing.name}"` };
    }

    if (ctx.apply) {
      let org = db.prepare('SELECT * FROM organizations WHERE LOWER(name) = LOWER(?)').get(orgName);
      if (!org) {
        const info = db.prepare('INSERT INTO organizations (name, org_type) VALUES (?, ?)').run(orgName, norm(row.org_type));
        org = { id: info.lastInsertRowid };
      }
      let slug = slugify(`${teamName} ${norm(row.age_group)}`), n = 1;
      while (db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) slug = `${slugify(teamName)}-${++n}`;
      db.prepare('INSERT INTO teams (organization_id, name, slug, age_group, level, external_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(org.id, teamName, slug, norm(row.age_group), norm(row.level), ext);
    }
    return { action: 'create', message: `Creates team "${teamName}" under "${orgName}"` };
  },

  season_roster(db, row, ctx) {
    const { team, ambiguous } = findTeam(db, row.team);
    if (ambiguous) return { action: 'error', message: `Multiple teams match "${norm(row.team)}" — use slug or external id` };
    if (!team) return { action: 'error', message: `Unknown team "${norm(row.team)}" — import teams first` };
    const start = isoDate(row.start_date);
    if (!start) return { action: 'error', message: 'missing or unrecognized start_date' };

    let seasonId = null;
    let seasonWarning = '';
    const seasonLabel = norm(row.season_label);
    if (seasonLabel) {
      const season = db.prepare('SELECT id, status FROM seasons WHERE LOWER(label) = LOWER(?)').get(seasonLabel);
      if (!season) return { action: 'error', message: `Unknown season "${seasonLabel}" — create it first` };
      seasonId = season.id;
      if (season.status === 'archived') seasonWarning = ` — warning: season "${seasonLabel}" is archived`;
    }

    // Resolve or create the player, honoring the duplicate rule.
    let resolved = resolvePlayer(db, row);
    if (resolved.candidates && !ctx.resolution) {
      return {
        action: 'needs_resolution',
        message: `Possible duplicate: ${norm(row.first_name)} ${norm(row.last_name)} matches ${resolved.candidates.length} existing player(s)`,
        candidates: playerCandidatePayload(resolved.candidates),
      };
    }
    let playerId = resolved.player?.id ?? null;
    if (ctx.resolution?.player_id) playerId = ctx.resolution.player_id;
    const willCreate = !playerId;

    // Idempotency: same player+team+season+start = update, not duplicate.
    const findMembership = pid => db.prepare(
      `SELECT id FROM roster_memberships WHERE player_id = ? AND team_id = ? AND start_date = ? AND (season_id IS ? OR season_id = ?)`
    ).get(pid, team.id, start, seasonId, seasonId);
    let membershipExists = playerId ? !!findMembership(playerId) : false;

    if (ctx.apply) {
      if (willCreate) {
        let slug = slugify(`${row.first_name}-${row.last_name}`), n = 1;
        while (db.prepare('SELECT 1 FROM players WHERE slug = ?').get(slug)) slug = `${slugify(`${row.first_name}-${row.last_name}`)}-${++n}`;
        const info = db.prepare(
          `INSERT INTO players (slug, first_name, last_name, grad_year, date_of_birth, external_id, is_public)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).run(slug, norm(row.first_name), norm(row.last_name), Number(row.grad_year) || null, isoDate(row.date_of_birth), norm(row.player_external_id) || null);
        playerId = info.lastInsertRowid;
      }
      const existing = findMembership(playerId);
      membershipExists = !!existing;
      if (existing) {
        db.prepare('UPDATE roster_memberships SET jersey = ?, positions = ?, end_date = ? WHERE id = ?')
          .run(norm(row.jersey), norm(row.positions), isoDate(row.end_date), existing.id);
      } else {
        db.prepare(
          `INSERT INTO roster_memberships (player_id, team_id, season_id, start_date, end_date, jersey, positions)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(playerId, team.id, seasonId, start, isoDate(row.end_date), norm(row.jersey), norm(row.positions));
      }
    }

    if (willCreate) return { action: 'create', message: `Creates player ${norm(row.first_name)} ${norm(row.last_name)} + membership on "${team.name}"${seasonWarning}` };
    return membershipExists
      ? { action: 'update', message: `Updates existing membership for ${norm(row.first_name)} ${norm(row.last_name)} on "${team.name}"${seasonWarning}` }
      : { action: 'create', message: `Adds ${norm(row.first_name)} ${norm(row.last_name)} (${resolved.matchedBy || 'resolved'}) to "${team.name}"${seasonWarning}` };
  },

  tournament_entries(db, row, ctx) {
    const tournament = findTournament(db, row.tournament);
    if (!tournament) return { action: 'error', message: `Unknown tournament "${norm(row.tournament)}"` };
    const division = db.prepare('SELECT * FROM divisions WHERE tournament_id = ? AND LOWER(name) = LOWER(?)').get(tournament.id, norm(row.division));
    const { team, ambiguous } = findTeam(db, row.team);
    if (ambiguous) return { action: 'error', message: `Multiple teams match "${norm(row.team)}"` };
    if (!team) return { action: 'error', message: `Unknown team "${norm(row.team)}"` };

    if (ctx.apply) {
      let divisionId = division?.id;
      if (!divisionId) {
        divisionId = db.prepare('INSERT INTO divisions (tournament_id, name) VALUES (?, ?)').run(tournament.id, norm(row.division)).lastInsertRowid;
      }
      const existing = db.prepare('SELECT id FROM tournament_entries WHERE division_id = ? AND team_id = ?').get(divisionId, team.id);
      if (existing) {
        db.prepare('UPDATE tournament_entries SET seed = ?, pool = ? WHERE id = ?').run(Number(row.seed) || null, norm(row.pool), existing.id);
        return { action: 'update', message: `Updates entry for "${team.name}"` };
      }
      db.prepare('INSERT INTO tournament_entries (tournament_id, division_id, team_id, seed, pool) VALUES (?, ?, ?, ?, ?)')
        .run(tournament.id, divisionId, team.id, Number(row.seed) || null, norm(row.pool));
      return { action: 'create', message: `Enters "${team.name}" in ${norm(row.division)}` };
    }

    if (division && db.prepare('SELECT 1 FROM tournament_entries WHERE division_id = ? AND team_id = ?').get(division.id, team.id)) {
      return { action: 'update', message: `Entry exists — updates seed/pool for "${team.name}"` };
    }
    return { action: 'create', message: `Enters "${team.name}" in "${norm(row.division)}"${division ? '' : ' (division will be created)'}` };
  },

  event_rosters(db, row, ctx) {
    const tournament = findTournament(db, row.tournament);
    if (!tournament) return { action: 'error', message: `Unknown tournament "${norm(row.tournament)}"` };
    const { team, ambiguous } = findTeam(db, row.team);
    if (ambiguous) return { action: 'error', message: `Multiple teams match "${norm(row.team)}"` };
    if (!team) return { action: 'error', message: `Unknown team "${norm(row.team)}"` };
    const entry = db.prepare(
      `SELECT te.id FROM tournament_entries te JOIN divisions d ON d.id = te.division_id
       WHERE te.tournament_id = ? AND te.team_id = ? AND LOWER(d.name) = LOWER(?)`
    ).get(tournament.id, team.id, norm(row.division));
    if (!entry) return { action: 'error', message: `"${team.name}" has no entry in division "${norm(row.division)}" — import entries first` };

    const resolved = resolvePlayer(db, row);
    if (resolved.candidates && !ctx.resolution) {
      return {
        action: 'needs_resolution',
        message: `Possible duplicate: ${norm(row.first_name)} ${norm(row.last_name)} matches ${resolved.candidates.length} existing player(s)`,
        candidates: playerCandidatePayload(resolved.candidates),
      };
    }
    const playerId = ctx.resolution?.player_id ?? resolved.player?.id;
    if (!playerId) return { action: 'error', message: `Unknown player ${norm(row.first_name)} ${norm(row.last_name)} — import the season roster first (event rosters never create players)` };

    const isGuest = /^(1|true|yes|y)$/i.test(norm(row.is_guest));
    const existing = db.prepare('SELECT id FROM event_rosters WHERE entry_id = ? AND player_id = ?').get(entry.id, playerId);
    if (ctx.apply) {
      if (existing) db.prepare('UPDATE event_rosters SET is_guest = ?, jersey = ? WHERE id = ?').run(isGuest ? 1 : 0, norm(row.jersey), existing.id);
      else db.prepare('INSERT INTO event_rosters (entry_id, player_id, is_guest, jersey) VALUES (?, ?, ?, ?)').run(entry.id, playerId, isGuest ? 1 : 0, norm(row.jersey));
    }
    return existing
      ? { action: 'update', message: `Updates event-roster row for "${team.name}"` }
      : { action: 'create', message: `Adds ${norm(row.first_name)} ${norm(row.last_name)}${isGuest ? ' (guest)' : ''} to "${team.name}" event roster` };
  },

  games(db, row, ctx) {
    const tournament = findTournament(db, row.tournament);
    if (!tournament) return { action: 'error', message: `Unknown tournament "${norm(row.tournament)}"` };
    const date = isoDate(row.game_date);
    if (!date) return { action: 'error', message: 'missing or unrecognized game_date' };

    const home = findTeam(db, row.home_team), away = findTeam(db, row.away_team);
    if (!home.team || !away.team) return { action: 'error', message: `Unknown team "${norm(!home.team ? row.home_team : row.away_team)}"` };
    if (home.team.id === away.team.id) return { action: 'error', message: 'Home and away teams must differ' };

    const entryFor = teamId => db.prepare(
      `SELECT te.id, te.division_id FROM tournament_entries te JOIN divisions d ON d.id = te.division_id
       WHERE te.tournament_id = ? AND te.team_id = ? AND LOWER(d.name) = LOWER(?)`
    ).get(tournament.id, teamId, norm(row.division));
    const homeEntry = entryFor(home.team.id), awayEntry = entryFor(away.team.id);
    if (!homeEntry || !awayEntry) return { action: 'error', message: 'Both teams need entries in that division — import entries first' };

    const ext = norm(row.game_external_id) || null;
    let existing = ext ? db.prepare('SELECT * FROM tournament_games WHERE external_id = ?').get(ext) : null;
    if (!existing) {
      existing = db.prepare(
        `SELECT * FROM tournament_games WHERE tournament_id = ? AND game_date = ? AND home_entry_id = ? AND away_entry_id = ?`
      ).get(tournament.id, date, homeEntry.id, awayEntry.id);
    }

    const scores = {
      home_score: norm(row.home_score) === '' ? null : Number(row.home_score),
      away_score: norm(row.away_score) === '' ? null : Number(row.away_score),
    };
    const status = scores.home_score != null && scores.away_score != null ? 'final' : 'scheduled';

    if (ctx.apply) {
      if (existing) {
        db.prepare(
          `UPDATE tournament_games SET game_date = ?, game_time = ?, field = ?, home_score = ?, away_score = ?, status = ?, external_id = COALESCE(?, external_id) WHERE id = ?`
        ).run(date, norm(row.game_time), norm(row.field), scores.home_score, scores.away_score, status, ext, existing.id);
      } else {
        db.prepare(
          `INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, game_time, field, home_score, away_score, status, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(tournament.id, homeEntry.division_id, homeEntry.id, awayEntry.id, date, norm(row.game_time), norm(row.field), scores.home_score, scores.away_score, status, ext);
      }
    }
    return existing
      ? { action: 'update', message: `Updates ${home.team.name} vs ${away.team.name} (${date})` }
      : { action: 'create', message: `Creates ${home.team.name} vs ${away.team.name} (${date})` };
  },

  metrics(db, row, ctx) {
    const date = isoDate(row.game_date);
    if (!date) return { action: 'error', message: 'missing or unrecognized game_date' };

    const resolved = resolvePlayer(db, row);
    if (resolved.candidates && !ctx.resolution) {
      return {
        action: 'needs_resolution',
        message: `Possible duplicate: ${norm(row.first_name)} ${norm(row.last_name)} matches ${resolved.candidates.length} existing player(s)`,
        candidates: playerCandidatePayload(resolved.candidates),
      };
    }
    const playerId = ctx.resolution?.player_id ?? resolved.player?.id;
    if (!playerId) return { action: 'error', message: `Unknown player ${norm(row.first_name)} ${norm(row.last_name)} — metrics never create players` };

    // Metric columns: anything matching a catalog key after normalization.
    // A literal 0 in a zero-impossible metric (0 mph, 0% strike, 0s time)
    // means "not measured" — spreadsheets often pre-fill zeros for players
    // who didn't participate. Skip with a visible warning, never store.
    const stats = {};
    const zeroSkipped = [];
    for (const [key, value] of Object.entries(row)) {
      const k = normKey(key);
      if (VALID_METRIC_KEYS.has(k) && norm(value) !== '') {
        const num = Number(value);
        if (!Number.isFinite(num)) return { action: 'error', message: `"${key}" is not a number (${value})` };
        if (num === 0 && ZERO_UNMEASURED_KEYS.has(k)) { zeroSkipped.push(k); continue; }
        stats[k] = num;
      }
    }
    const zeroWarning = zeroSkipped.length
      ? ` — warning: ${zeroSkipped.join(', ')} = 0 treated as not measured (leave blank to omit)`
      : '';
    if (Object.keys(stats).length === 0) {
      return { action: 'error', message: `no metric values in row${zeroWarning}` };
    }

    const rawType = normKey(row.game_type);
    const type = rawType ? (GAME_TYPES.includes(rawType) ? rawType : null) : 'game';
    if (!type) return { action: 'error', message: `unknown game_type "${norm(row.game_type)}" — valid: ${GAME_TYPES.join(', ')}` };

    const opponent = norm(row.opponent);
    const existing = db.prepare(
      'SELECT id FROM games WHERE player_id = ? AND game_date = ? AND LOWER(TRIM(opponent)) = LOWER(?)'
    ).get(playerId, date, opponent);

    if (ctx.apply) {
      let gameId = existing?.id;
      if (!gameId) {
        gameId = db.prepare('INSERT INTO games (player_id, game_date, game_type, opponent) VALUES (?, ?, ?, ?)')
          .run(playerId, date, type, opponent).lastInsertRowid;
      }
      const upsert = db.prepare(
        `INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, ?, ?)
         ON CONFLICT (game_id, metric_key) DO UPDATE SET value = excluded.value`
      );
      for (const [k, v] of Object.entries(stats)) upsert.run(gameId, k, v);
    }
    return existing
      ? { action: 'update', message: `Updates ${Object.keys(stats).length} metric(s) on existing ${date} record${zeroWarning}` }
      : { action: 'create', message: `Creates ${date} ${type} record with ${Object.keys(stats).length} metric(s)${zeroWarning}` };
  },
};

// ── Pipeline ─────────────────────────────────────────────────────────────

function processRows(db, kind, rows, resolutions, apply) {
  const processor = processors[kind];
  if (!processor) throw new Error(`Unknown import kind "${kind}"`);
  return rows.map((raw, index) => {
    const row = {};
    for (const [k, v] of Object.entries(raw)) row[normKey(k)] = v;
    try {
      const result = processor(db, row, { apply, resolution: resolutions?.[index] });
      return { index, ...result };
    } catch (err) {
      return { index, action: 'error', message: err.message };
    }
  });
}

export function planImport(db, kind, rows, resolutions = {}) {
  return processRows(db, kind, rows, resolutions, false);
}

export function applyImport(db, kind, rows, resolutions = {}, meta = {}) {
  // Unresolved duplicates block apply — the admin must decide first (§8).
  const plan = planImport(db, kind, rows, resolutions);
  const unresolved = plan.filter(p => p.action === 'needs_resolution');
  if (unresolved.length > 0) {
    return { blocked: true, plan, message: `${unresolved.length} row(s) need duplicate resolution before applying` };
  }

  const results = db.transaction(() => processRows(db, kind, rows, resolutions, true))();
  const counts = {
    created: results.filter(r => r.action === 'create').length,
    updated: results.filter(r => r.action === 'update').length,
    skipped: results.filter(r => r.action === 'skip').length,
    errors: results.filter(r => r.action === 'error').length,
  };
  const audit = db.prepare(
    `INSERT INTO import_audits (kind, filename, uploader_email, dry_run, created_count, updated_count, skipped_count, error_count, report)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(kind, meta.filename || '', meta.uploader || '', counts.created, counts.updated, counts.skipped, counts.errors, JSON.stringify(results));
  return { blocked: false, results, counts, auditId: audit.lastInsertRowid };
}
