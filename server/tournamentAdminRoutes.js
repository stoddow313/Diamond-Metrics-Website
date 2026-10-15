// Tournament admin (admin only): tournaments, divisions, team entries with
// event rosters, games with lineup appearances — and the correction tools:
// edit any of them in place, move an entry between divisions (same entry id,
// same event roster), merge divisions, withdraw / archive / delete with a
// dependency summary, and restore deleted records. Rules:
// tournamentAdminLogic.js; data access: tournamentAdminStore.js. Shared teams
// and player profiles are never deleted from here.
import { resolveEventRoster } from './rosterLogic.js';
import {
  readTournamentPatch, readDivisionPatch, readEntryPatch, readGamePatch,
  GAME_STAGE_KEYS, RECORD_KINDS, stageLabel,
} from './tournamentAdminLogic.js';
import {
  AdminRecordError, loadRecord, dependencies, tournamentDetail, freeTournamentSlug, changeTournamentSlug,
  tournamentAliases, moveEntry, mergeDivision, setArchived, deleteRecord, listTrash, restoreTrash,
} from './tournamentAdminStore.js';

export function mountTournamentAdminRoutes(app, { db, requireAdmin }) {
  // Store errors carry their status; anything else is a server error.
  const send = fn => (req, res) => {
    try {
      return fn(req, res);
    } catch (err) {
      if (err instanceof AdminRecordError) return res.status(err.status).json({ error: err.message, ...err.extra });
      throw err;
    }
  };
  const bad = (res, error) => res.status(400).json({ error });
  const update = (table, id, data) => {
    const cols = Object.keys(data);
    db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...data, id });
  };
  const gameRow = id => {
    const g = loadRecord(db, 'game', id);
    return g && { ...g, stage_label: stageLabel(g.stage) };
  };

  // ── Tournaments ────────────────────────────────────────────────────────
  app.get('/api/tournaments', requireAdmin, (_req, res) => {
    res.json({
      tournaments: db.prepare(
        `SELECT tr.*,
                (SELECT COUNT(*) FROM divisions d WHERE d.tournament_id = tr.id) AS division_count,
                (SELECT COUNT(*) FROM tournament_entries te WHERE te.tournament_id = tr.id AND te.status = 'active') AS entry_count,
                (SELECT COUNT(*) FROM tournament_games tg WHERE tg.tournament_id = tr.id AND tg.archived_at IS NULL) AS game_count
         FROM tournaments tr ORDER BY tr.start_date DESC`
      ).all(),
    });
  });

  app.post('/api/tournaments', requireAdmin, (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.start_date || !body.end_date) return bad(res, 'Enter a name, a start date and an end date.');
    const { slug: _ignored, ...fields } = body;
    const r = readTournamentPatch(fields, null);
    if (r.error) return bad(res, r.error);
    const data = { ...r.value, slug: freeTournamentSlug(db, r.value.name) };
    const cols = Object.keys(data);
    const info = db.prepare(`INSERT INTO tournaments (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(data);
    res.status(201).json({ tournament: db.prepare('SELECT * FROM tournaments WHERE id = ?').get(info.lastInsertRowid) });
  });

  app.get('/api/tournaments/:id', requireAdmin, (req, res) => {
    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    res.json(tournamentDetail(db, tournament));
  });

  // Name, dates, location and the rest. Renaming never changes the public
  // URL; changing the URL keeps the old one working as an alias.
  app.put('/api/tournaments/:id', requireAdmin, send((req, res) => {
    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    const r = readTournamentPatch(req.body, tournament);
    if (r.error) return bad(res, r.error);
    const { slug, ...fields } = r.value;
    db.transaction(() => {
      if (slug) changeTournamentSlug(db, tournament, slug);
      if (Object.keys(fields).length) update('tournaments', tournament.id, { ...fields, updated_at: new Date().toISOString() });
    })();
    res.json({
      tournament: db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournament.id),
      aliases: tournamentAliases(db, tournament.id),
    });
  }));

  // ── Divisions ──────────────────────────────────────────────────────────
  app.post('/api/tournaments/:id/divisions', requireAdmin, (req, res) => {
    if (!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Tournament not found' });
    const r = readDivisionPatch({ name: '', ...req.body });
    if (r.error) return bad(res, r.error);
    const { name, age_group = '', level = '' } = r.value;
    const info = db.prepare('INSERT INTO divisions (tournament_id, name, age_group, level) VALUES (?, ?, ?, ?)')
      .run(req.params.id, name, age_group, level);
    res.status(201).json({ division: db.prepare('SELECT * FROM divisions WHERE id = ?').get(info.lastInsertRowid) });
  });

  app.put('/api/divisions/:id', requireAdmin, (req, res) => {
    if (!db.prepare('SELECT 1 FROM divisions WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Division not found' });
    const r = readDivisionPatch(req.body);
    if (r.error) return bad(res, r.error);
    update('divisions', req.params.id, r.value);
    res.json({ division: db.prepare('SELECT * FROM divisions WHERE id = ?').get(req.params.id) });
  });

  // Moves every entry and game into another division, then removes this one.
  app.post('/api/divisions/:id/merge', requireAdmin, send((req, res) => {
    const { into_division_id, stage = null } = req.body || {};
    if (stage != null && stage !== '' && !GAME_STAGE_KEYS.includes(stage)) return bad(res, 'Choose a stage from the list.');
    res.json(mergeDivision(db, Number(req.params.id), Number(into_division_id), stage || null));
  }));

  app.delete('/api/divisions/:id', requireAdmin, send((req, res) => {
    res.json({ ok: true, ...deleteRecord(db, 'division', Number(req.params.id), req.admin.id) });
  }));

  // ── Team entries ───────────────────────────────────────────────────────
  app.post('/api/tournaments/:id/entries', requireAdmin, (req, res) => {
    const { division_id, team_id } = req.body || {};
    const division = db.prepare('SELECT * FROM divisions WHERE id = ? AND tournament_id = ?').get(division_id, req.params.id);
    if (!division) return bad(res, 'Choose a division of this tournament.');
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(team_id)) return bad(res, 'Unknown team');
    const r = readEntryPatch({ seed: req.body.seed ?? null, pool: req.body.pool ?? '' });
    if (r.error) return bad(res, r.error);
    const existing = db.prepare('SELECT status FROM tournament_entries WHERE division_id = ? AND team_id = ?').get(division.id, team_id);
    if (existing) {
      return res.status(409).json({
        error: existing.status === 'active'
          ? 'That team is already entered in this division.'
          : `That team has a ${existing.status} entry in this division — reinstate it instead of entering it again.`,
      });
    }
    const info = db.prepare('INSERT INTO tournament_entries (tournament_id, division_id, team_id, seed, pool) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, division.id, team_id, r.value.seed, r.value.pool || '');
    res.status(201).json({ entry: db.prepare('SELECT * FROM tournament_entries WHERE id = ?').get(info.lastInsertRowid) });
  });

  // Seed, pool, placement, wins, losses, status (active | withdrawn | archived).
  app.put('/api/entries/:id', requireAdmin, send((req, res) => {
    const entry = db.prepare('SELECT * FROM tournament_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const r = readEntryPatch(req.body);
    if (r.error) return bad(res, r.error);
    const { status, ...fields } = r.value;
    db.transaction(() => {
      if (Object.keys(fields).length) update('tournament_entries', entry.id, fields);
      if (status === 'archived' && entry.status !== 'archived') setArchived(db, 'entry', entry.id, true);
      else if (status && status !== 'archived') update('tournament_entries', entry.id, { status });
    })();
    res.json({ entry: loadRecord(db, 'entry', entry.id) });
  }));

  // Same entry id and event roster in another division of the event.
  app.post('/api/entries/:id/move', requireAdmin, send((req, res) => {
    res.json(moveEntry(db, Number(req.params.id), Number(req.body?.division_id)));
  }));

  // ── Event rosters (override season roster; guests welcome) ─────────────
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
      db.prepare('SELECT id, first_name, last_name, slug, grad_year FROM players').all().map(p => [p.id, p])
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
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) return bad(res, 'Unknown player');
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

  // ── Games ──────────────────────────────────────────────────────────────
  const entryOf = (tournamentId, entryId) =>
    db.prepare('SELECT * FROM tournament_entries WHERE id = ? AND tournament_id = ?').get(entryId, tournamentId);
  const divisionOf = (tournamentId, divisionId) =>
    db.prepare('SELECT * FROM divisions WHERE id = ? AND tournament_id = ?').get(divisionId, tournamentId);

  app.post('/api/tournaments/:id/games', requireAdmin, (req, res) => {
    const body = req.body || {};
    if (!body.game_date) return bad(res, 'Enter the game date.');
    const r = readGamePatch(body);
    if (r.error) return bad(res, r.error);
    const g = { game_time: '', field: '', stage: null, status: 'scheduled', ...r.value };
    if (!divisionOf(req.params.id, g.division_id)) return bad(res, 'Choose a division of this tournament.');
    if (!entryOf(req.params.id, g.home_entry_id) || !entryOf(req.params.id, g.away_entry_id)) return bad(res, 'Both teams must be entered in this tournament.');
    const info = db.prepare(
      `INSERT INTO tournament_games (tournament_id, division_id, home_entry_id, away_entry_id, game_date, game_time, field, stage, status, home_score, away_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, g.division_id, g.home_entry_id, g.away_entry_id, g.game_date, g.game_time, g.field, g.stage, g.status,
      g.home_score ?? null, g.away_score ?? null);
    res.status(201).json({ game: gameRow(info.lastInsertRowid) });
  });

  // Date, time, field, status, score, stage, division and either team.
  app.put('/api/tournament-games/:id', requireAdmin, (req, res) => {
    const game = db.prepare('SELECT * FROM tournament_games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const r = readGamePatch(req.body);
    if (r.error) return bad(res, r.error);
    const next = { ...game, ...r.value };
    if (next.home_entry_id === next.away_entry_id) return bad(res, 'A team cannot play itself.');
    if ('division_id' in r.value && !divisionOf(game.tournament_id, next.division_id)) return bad(res, 'Choose a division of this tournament.');
    for (const side of ['home_entry_id', 'away_entry_id']) {
      if (side in r.value && !entryOf(game.tournament_id, next[side])) return bad(res, 'Both teams must be entered in this tournament.');
    }

    // Replacing a team must not strand records made for it in this game.
    const after = [next.home_entry_id, next.away_entry_id];
    const replaced = [game.home_entry_id, game.away_entry_id].filter(e => !after.includes(e));
    if (replaced.length) {
      const marks = replaced.map(() => '?').join(',');
      const appearances = db.prepare(`SELECT COUNT(*) c FROM player_game_appearances WHERE tournament_game_id = ? AND entry_id IN (${marks})`).get(game.id, ...replaced).c;
      if (appearances) {
        return res.status(409).json({ error: `${appearances} lineup appearance${appearances === 1 ? ' is' : 's are'} recorded for the team you’re replacing. Remove them first.` });
      }
      const teamIds = after.map(e => db.prepare('SELECT team_id FROM tournament_entries WHERE id = ?').get(e).team_id);
      const job = db.prepare(
        `SELECT j.id, t.name FROM cmd_jobs j JOIN teams t ON t.id = j.team_id WHERE j.tournament_game_id = ? AND j.team_id NOT IN (${teamIds.map(() => '?').join(',')})`
      ).get(game.id, ...teamIds);
      if (job) {
        return res.status(409).json({ error: `Command job #${job.id} analyzes ${job.name} in this game. Keep that team in the game, or archive this game and add a new one.` });
      }
    }
    update('tournament_games', game.id, r.value);
    res.json({ game: gameRow(game.id) });
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
    if (entry_id !== game.home_entry_id && entry_id !== game.away_entry_id) return bad(res, 'Entry is not part of this game');
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) return bad(res, 'Unknown player');
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

  // ── Dependency summary, archive, delete, restore ───────────────────────
  const kindOf = (req, res) => {
    if (RECORD_KINDS.includes(req.params.kind)) return req.params.kind;
    res.status(404).json({ error: 'Not found' });
    return null;
  };

  app.get('/api/event-records/:kind/:id/dependencies', requireAdmin, (req, res) => {
    const kind = kindOf(req, res);
    if (!kind) return;
    const dep = dependencies(db, kind, Number(req.params.id));
    if (!dep) return res.status(404).json({ error: 'Not found' });
    res.json(dep);
  });

  app.post('/api/event-records/:kind/:id/archive', requireAdmin, send((req, res) => {
    const kind = kindOf(req, res);
    if (kind) res.json({ record: setArchived(db, kind, Number(req.params.id), true) });
  }));

  app.post('/api/event-records/:kind/:id/restore', requireAdmin, send((req, res) => {
    const kind = kindOf(req, res);
    if (kind) res.json({ record: setArchived(db, kind, Number(req.params.id), false) });
  }));

  app.delete('/api/event-records/:kind/:id', requireAdmin, send((req, res) => {
    const kind = kindOf(req, res);
    if (kind) res.json({ ok: true, ...deleteRecord(db, kind, Number(req.params.id), req.admin.id) });
  }));

  app.get('/api/event-trash', requireAdmin, (req, res) => {
    const tournamentId = req.query.tournament_id ? Number(req.query.tournament_id) : null;
    res.json({ items: listTrash(db, { tournamentId }) });
  });

  app.post('/api/event-trash/:id/restore', requireAdmin, send((req, res) => {
    res.json({ ok: true, ...restoreTrash(db, Number(req.params.id)) });
  }));
}
