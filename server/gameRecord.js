// Game-record track (roadmap §6, §7.9): a GameChanger scorecard export or a
// post-game manual box score is a *source* for the validated game record.
// Raw import is preserved verbatim, rows resolve to roster players (jersey
// first, then name), the analyst resolves what the parser could not, and a
// validated record releases box-score statistics through the game-record
// release — independent of the metric release, never mixed with measured
// metrics (stat_entries.method = 'scorebook_derived').
//
// GameChanger exports one table per stat group (batting, pitching, fielding)
// with a Number/Last/First (or Player) header. The parser is tolerant: it
// finds header rows anywhere in the file, classifies each block by its
// columns, maps common labels to box-score keys, and reports every column it
// could not place instead of guessing.
import { resyncPublishedRollups } from './releaseLogic.js';
import { commandRoster } from './commandRoster.js';
import { liveRecordReport, setGameRecordReleaseHook } from './scorebook.js';

const norm = s => String(s ?? '').trim();
const key = s => norm(s).toLowerCase().replace(/[^a-z0-9#%/+-]+/g, '');

// Column aliases → box-score metric keys, per stat group. Labels that appear
// in more than one group (H, R, BB, SO) resolve by the block's group.
const BATTING = {
  pa: 'bs_pa', ab: 'bs_ab', r: 'bs_r', runs: 'bs_r', h: 'bs_h', hits: 'bs_h', '2b': 'bs_2b', doubles: 'bs_2b',
  '3b': 'bs_3b', triples: 'bs_3b', hr: 'bs_hr', rbi: 'bs_rbi', bb: 'bs_bb', walks: 'bs_bb', so: 'bs_k', k: 'bs_k',
  strikeouts: 'bs_k', hbp: 'bs_hbp', sb: 'bs_sb',
};
const PITCHING = {
  ip: 'bs_ip', bf: 'bs_bf', h: 'bs_ha', r: 'bs_ra', er: 'bs_er', bb: 'bs_bba', so: 'bs_kp', k: 'bs_kp', hr: 'bs_hra',
  '#p': 'bs_pitches', p: 'bs_pitches', pitches: 'bs_pitches', np: 'bs_pitches',
};
const FIELDING = { e: 'bs_e', errors: 'bs_e' };
const IDENTITY = new Set(['number', 'no', 'no.', '#', 'jersey', 'last', 'first', 'player', 'name', 'lastname', 'firstname']);
const DERIVED_IGNORED = new Set(['gp', 'gs', 'avg', 'obp', 'ops', 'slg', 'era', 'whip', 'w', 'l', 'sv', 'svo', 'bs', 'hld', 'tb', 'xbh', 'lob', 'qab', 'ps', 'ps/pa', 'c%', 'sb%', 'fpct', 'ab/hr', 'bb/k', 'k-l', 'sac', 'sf', 'roe', 'fc', 'cs', 'pik', 'gidp', 'gitp', '1b', 'ts', 'tc', 'a', 'po', 'dp', 'tp', 'bb%', 'k%', 'babip', 'ip/gs']);

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function classify(headerKeys) {
  const has = k => headerKeys.includes(k);
  if (has('ip') || has('bf') || has('er')) return 'pitching';
  if (has('tc') || has('po') || has('fpct') || (has('e') && !has('ab') && !has('pa'))) return 'fielding';
  if (has('ab') || has('pa') || has('rbi')) return 'batting';
  return null;
}

// Parse a GameChanger-style CSV (or a manual box score with the same
// labels). Returns blocks with resolved column mapping and per-row stats.
export function parseBoxScoreCsv(content) {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  const warnings = [];
  let block = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) { block = null; continue; }
    const cells = splitCsvLine(raw).map(norm);
    const keys = cells.map(key);
    const identityCount = keys.filter(k => IDENTITY.has(k)).length;
    const group = classify(keys);
    if (identityCount >= 1 && group) {
      // header row
      const map = {};
      const unknown = [];
      const aliases = group === 'pitching' ? PITCHING : group === 'fielding' ? FIELDING : BATTING;
      keys.forEach((k, idx) => {
        if (IDENTITY.has(k)) map[idx] = { kind: 'identity', key: k };
        else if (aliases[k]) map[idx] = { kind: 'stat', key: aliases[k] };
        else if (DERIVED_IGNORED.has(k) || k === '') map[idx] = { kind: 'ignored', key: k };
        else { map[idx] = { kind: 'unknown', key: cells[idx] }; unknown.push(cells[idx]); }
      });
      block = { group, header_row: i + 1, columns: cells, unknown_columns: unknown, rows: [] };
      blocks.push(block);
      if (unknown.length) warnings.push(`${group} block at line ${i + 1}: unplaced columns ${unknown.join(', ')}`);
      continue;
    }
    if (!block) continue;   // data before any header: skip
    const first = cells.find(c => c) || '';
    if (/^(totals?|team)$/i.test(first)) continue;
    const identity = { jersey: '', last: '', first: '', name: '' };
    const stats = {};
    let anyStat = false;
    Object.entries(blockColumns(block)).forEach(([idx, col]) => {
      const v = cells[Number(idx)];
      if (col.kind === 'identity') {
        if (['number', 'no', 'no.', '#', 'jersey'].includes(col.key)) identity.jersey = norm(v).replace(/^#/, '');
        else if (col.key === 'last' || col.key === 'lastname') identity.last = norm(v);
        else if (col.key === 'first' || col.key === 'firstname') identity.first = norm(v);
        else identity.name = norm(v);
      } else if (col.kind === 'stat') {
        const n = parseStat(v);
        if (n != null) { stats[col.key] = (stats[col.key] ?? 0) + n; anyStat = true; }
      }
    });
    if (!identity.jersey && !identity.last && !identity.name) continue;
    if (!anyStat) continue;
    const name = identity.name || `${identity.first} ${identity.last}`.trim();
    block.rows.push({ row: i + 1, jersey: identity.jersey, first_name: identity.first, last_name: identity.last, name, stats, raw: raw.slice(0, 300) });
  }
  return { blocks, warnings, row_count: blocks.reduce((n, b) => n + b.rows.length, 0) };
}

// Column map is rebuilt from the header each time (blocks hold the header cells).
function blockColumns(block) {
  const keys = block.columns.map(key);
  const aliases = block.group === 'pitching' ? PITCHING : block.group === 'fielding' ? FIELDING : BATTING;
  const map = {};
  keys.forEach((k, idx) => {
    if (IDENTITY.has(k)) map[idx] = { kind: 'identity', key: k };
    else if (aliases[k]) map[idx] = { kind: 'stat', key: aliases[k] };
  });
  return map;
}

// Innings pitched arrive as "5.2" (5 and two thirds) in GameChanger exports —
// keep the notation as-is for bs_ip (the catalog documents thirds); every
// other stat is an integer count.
function parseStat(v) {
  const s = norm(v);
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Resolve parsed rows to roster players: jersey match first, then name.
// Unresolved rows are reported, never guessed.
export function resolveBoxScoreRows(db, jobId, parsed, resolutions = {}) {
  const roster = commandRoster(db, jobId);
  const nameKey = s => norm(s).toLowerCase().replace(/[^a-z]/g, '');
  // Jerseys are not unique on a roster that spans seasons or event guests
  // (two #21s is normal), so a jersey match must be the only candidate AND
  // agree with the name when the row carries one. Never guess between two.
  const byJersey = new Map();
  for (const p of roster) {
    if (!p.jersey) continue;
    const j = String(p.jersey).replace(/^#/, '');
    if (!byJersey.has(j)) byJersey.set(j, []);
    byJersey.get(j).push(p);
  }
  const byName = new Map(roster.map(p => [nameKey(`${p.first_name}${p.last_name}`), p]));
  const byLast = new Map();
  for (const p of roster) { const k = nameKey(p.last_name); byLast.set(k, byLast.has(k) ? null : p); }   // null = ambiguous
  const rowLast = row => nameKey(row.last_name || row.name.replace(/^(.*),.*$/, '$1').split(' ').pop());
  const agrees = (p, row) => !rowLast(row) || nameKey(p.last_name) === rowLast(row);

  const resolved = [];
  for (const block of parsed.blocks) {
    for (const row of block.rows) {
      const rowKey = `${block.group}:${row.row}`;
      let player = null, how = null;
      if (Object.prototype.hasOwnProperty.call(resolutions, rowKey)) {
        const pid = resolutions[rowKey];
        player = pid == null ? null : roster.find(p => p.id === Number(pid)) || null;
        how = pid == null ? 'skipped' : (player ? 'analyst' : null);
      } else {
        const candidates = row.jersey ? (byJersey.get(row.jersey) || []) : [];
        const agreeing = candidates.filter(p => agrees(p, row));
        if (agreeing.length === 1 && (candidates.length === 1 || rowLast(row))) {
          player = agreeing[0];
          how = candidates.length === 1 ? 'jersey' : 'jersey+name';
        }
        if (!player && row.name) {
          const full = nameKey(row.first_name ? `${row.first_name}${row.last_name}` : row.name.replace(/^(.*),\s*(.*)$/, '$2$1'));
          if (byName.has(full)) { player = byName.get(full); how = 'name'; }
          else if (rowLast(row) && byLast.get(rowLast(row))) { player = byLast.get(rowLast(row)); how = 'last_name'; }
        }
      }
      resolved.push({ key: rowKey, group: block.group, row: row.row, jersey: row.jersey, name: row.name, stats: row.stats, player_id: player?.id ?? null, player_name: player ? `${player.first_name} ${player.last_name}` : null, resolved_by: how, skipped: how === 'skipped' });
    }
  }
  const unresolved = resolved.filter(r => !r.player_id && !r.skipped);
  return { rows: resolved, unresolved, roster: roster.map(p => ({ id: p.id, jersey: p.jersey, name: `${p.first_name} ${p.last_name}`, is_guest: p.is_guest })) };
}

// Validate a source: parse, resolve, store the report. Fully resolved (or
// explicitly skipped) → 'validated'; otherwise 'validating' with the gaps.
export function validateGameRecordSource(db, sourceId, { resolutions = {} } = {}, actorId = null) {
  const source = db.prepare('SELECT * FROM cmd_game_record_sources WHERE id = ?').get(sourceId);
  if (!source) throw Object.assign(new Error('Game record source not found'), { status: 404 });
  if (source.source_kind === 'live_internal') {
    // The live scorebook has no file to parse: its rows are replayed from events.
    const live = liveRecordReport(db, source.job_id);
    db.prepare("UPDATE cmd_game_record_sources SET validation_status = ?, parsed_report = ?, validated_at = CASE WHEN ? = 'validated' THEN COALESCE(validated_at, datetime('now')) ELSE NULL END WHERE id = ?")
      .run(live.status, JSON.stringify(live.report), live.status, sourceId);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'game_record_source_validated', ?, ?, ?)"
    ).run(source.job_id, actorId, `live scorebook: ${live.report.rows.length} player rows${live.report.scorebook.final ? '' : ' — game not final'}${live.report.scorebook.issues.length ? `; ${live.report.scorebook.issues.length} issue(s)` : ''}`, source.validation_status, live.status);
    return live;
  }
  const content = source.raw_import || '';
  if (!content.trim()) throw Object.assign(new Error('This source has no imported content — attach the CSV text first'), { status: 400 });
  const parsed = parseBoxScoreCsv(content);
  if (parsed.row_count === 0) throw Object.assign(new Error('No player rows found — expected a GameChanger-style table with Number/Last/First (or Player) and stat columns'), { status: 400 });
  const priorResolutions = safeJson(source.resolutions) || {};
  const merged = { ...priorResolutions, ...resolutions };
  const res = resolveBoxScoreRows(db, source.job_id, parsed, merged);
  const status = res.unresolved.length === 0 ? 'validated' : 'validating';
  const report = {
    blocks: parsed.blocks.map(b => ({ group: b.group, header_row: b.header_row, rows: b.rows.length, unknown_columns: b.unknown_columns })),
    warnings: parsed.warnings,
    rows: res.rows,
    unresolved: res.unresolved.map(r => ({ key: r.key, group: r.group, row: r.row, jersey: r.jersey, name: r.name })),
    roster: res.roster,
  };
  db.prepare("UPDATE cmd_game_record_sources SET validation_status = ?, parsed_report = ?, resolutions = ?, validated_at = CASE WHEN ? = 'validated' THEN datetime('now') ELSE NULL END WHERE id = ?")
    .run(status, JSON.stringify(report), JSON.stringify(merged), status, sourceId);
  db.prepare(
    "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'game_record_source_validated', ?, ?, ?)"
  ).run(source.job_id, actorId, `${source.source_kind}${source.label ? ` — ${source.label}` : ''}: ${res.rows.length - res.unresolved.length} of ${res.rows.length} rows resolved${parsed.warnings.length ? `; ${parsed.warnings.length} column warning(s)` : ''}`, source.validation_status, status);
  return { status, report };
}

const safeJson = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Everything a validated record would publish: bs_* per resolved player,
// summed across sources and blocks.
export function gameRecordPlan(db, jobId) {
  const sources = db.prepare("SELECT * FROM cmd_game_record_sources WHERE job_id = ? AND validation_status = 'validated' ORDER BY id").all(jobId);
  const perPlayer = new Map();
  for (const s of sources) {
    const report = safeJson(s.parsed_report);
    for (const r of report?.rows || []) {
      if (!r.player_id || r.skipped) continue;
      if (!perPlayer.has(r.player_id)) perPlayer.set(r.player_id, { player_id: r.player_id, stats: {}, source_ids: new Set() });
      const acc = perPlayer.get(r.player_id);
      for (const [k, v] of Object.entries(r.stats)) acc.stats[k] = (acc.stats[k] ?? 0) + v;
      acc.source_ids.add(s.id);
    }
  }
  return { sources, players: [...perPlayer.values()].map(p => ({ ...p, source_ids: [...p.source_ids] })) };
}

// Game-record release adapter: writes scorebook-derived statistics into the
// same games/stat_entries the profile reads, labelled by method so they can
// never be mistaken for measured metrics, and removes stale scorebook keys
// on re-release. Synthetic jobs run the workflow and write nothing.
export function releaseGameRecord(db, jobId, actorId = null) {
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  const { sources, players } = gameRecordPlan(db, jobId);
  if (sources.length === 0) throw Object.assign(new Error('No validated game-record source on this job — validate a GameChanger export or manual box score first'), { status: 400 });
  const synthetic = !!db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id)?.synthetic;

  const written = [];
  const run = db.transaction(() => {
    if (!synthetic) {
      const gameIds = new Map(db.prepare('SELECT id, player_id FROM games WHERE command_job_id = ?').all(jobId).map(g => [g.player_id, g.id]));
      const gameFor = playerId => {
        if (gameIds.has(playerId)) return gameIds.get(playerId);
        const id = db.prepare(
          'INSERT INTO games (player_id, game_date, game_type, opponent, tournament_game_id, command_job_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(playerId, job.game_date, job.game_type, job.opponent_label || job.event_label || '', job.tournament_game_id ?? null, jobId).lastInsertRowid;
        gameIds.set(playerId, id);
        return id;
      };
      const upsert = db.prepare(
        `INSERT INTO stat_entries (game_id, metric_key, value, method, game_record_source_id) VALUES (?, ?, ?, 'scorebook_derived', ?)
         ON CONFLICT (game_id, metric_key) DO UPDATE SET value = excluded.value, method = excluded.method, game_record_source_id = excluded.game_record_source_id`
      );
      const keysByPlayer = new Map();
      for (const p of players) {
        const gameId = gameFor(p.player_id);
        for (const [k, v] of Object.entries(p.stats)) {
          upsert.run(gameId, k, v, p.source_ids[0]);
          written.push({ player_id: p.player_id, metric_key: k, value: v });
        }
        keysByPlayer.set(p.player_id, new Set(Object.keys(p.stats)));
      }
      // Stale scorebook keys from an earlier release leave when the record no longer carries them.
      for (const [playerId, gameId] of gameIds) {
        const keep = keysByPlayer.get(playerId) || new Set();
        for (const row of db.prepare("SELECT metric_key FROM stat_entries WHERE game_id = ? AND method = 'scorebook_derived'").all(gameId)) {
          if (!keep.has(row.metric_key)) db.prepare("DELETE FROM stat_entries WHERE game_id = ? AND metric_key = ? AND method = 'scorebook_derived'").run(gameId, row.metric_key);
        }
      }
    } else {
      for (const p of players) for (const [k, v] of Object.entries(p.stats)) written.push({ player_id: p.player_id, metric_key: k, value: v, withheld: 'synthetic' });
    }
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'game_record_released', ?, '', 'released')"
    ).run(jobId, actorId, `${written.length} box-score entr${written.length === 1 ? 'y' : 'ies'} for ${players.length} player${players.length === 1 ? '' : 's'} from ${sources.length} validated source${sources.length === 1 ? '' : 's'}${synthetic ? ' — withheld from profiles (synthetic job)' : ''}`);
  });
  run();
  // Metric rollups are untouched by design; resync is a no-op unless something drifted.
  resyncPublishedRollups(db, jobId, actorId, 'game record released');
  return { written, players: players.length, sources: sources.length, synthetic };
}

// A correction to a released scorebook re-runs the release so the profile
// never shows a superseded value (TDR §7.1).
setGameRecordReleaseHook((db, jobId, actorId, why) => {
  const out = releaseGameRecord(db, jobId, actorId);
  db.prepare(
    "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'game_record_rereleased', ?)"
  ).run(jobId, actorId ?? null, `${why} — ${out.written.length} entries republished`);
  return out;
});
