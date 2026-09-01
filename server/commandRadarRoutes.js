// Command M3 routes: radar CSV import (idempotent, raw preserved), manual
// readings (owner directive field set), classification queue, and live
// per-player rollup previews via the TDR §5a mapping.
import { createHash } from 'node:crypto';
import { parseRadarCsv, classifyReading, PITCH_TYPES } from './radarImport.js';
import { velocityRollup } from './metricRelease.js';
import { membershipCoversDate } from './rosterLogic.js';

export function mountCommandRadarRoutes(app, { db, requireInternal }) {
  const audit = (jobId, actorId, action, note) =>
    db.prepare("INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, ?, ?)")
      .run(jobId, actorId, action, note);

  app.post('/api/command/jobs/:id/radar-imports', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { filename = 'radar.csv', content } = req.body || {};
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content (CSV text) is required' });

    const hash = createHash('sha256').update(content).digest('hex');
    const existing = db.prepare('SELECT id, row_count FROM cmd_radar_imports WHERE job_id = ? AND file_hash = ?').get(job.id, hash);
    if (existing) return res.json({ import_id: existing.id, duplicate: true, rows: existing.row_count });

    const { rows, header_detected } = parseRadarCsv(content);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in the file' });

    const create = db.transaction(() => {
      const importId = db.prepare(
        'INSERT INTO cmd_radar_imports (job_id, filename, file_hash, raw_content, row_count, created_by) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(job.id, String(filename), hash, content, rows.length, req.internal.id).lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO cmd_radar_readings (job_id, source, import_id, row_index, velocity, source_timestamp, raw_row, status, note, created_by)
         VALUES (?, 'csv_import', ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of rows) {
        ins.run(job.id, importId, r.row_index, r.velocity, r.source_timestamp, r.raw_row,
          r.parse_ok ? 'unmatched' : 'invalid', r.parse_ok ? '' : 'no readable velocity in row', req.internal.id);
      }
      audit(job.id, req.internal.id, 'radar_import', `${filename} — ${rows.length} rows (${rows.filter(r => r.parse_ok).length} readable)`);
      return importId;
    });
    const importId = create();
    res.status(201).json({ import_id: importId, duplicate: false, rows: rows.length, readable: rows.filter(r => r.parse_ok).length, header_detected });
  });

  // Manual entry — directive fields: player, velocity, pitch/exit, pitch
  // type, context, optional note, unmatched/invalid status.
  app.post('/api/command/jobs/:id/radar-readings', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    const velocity = Number(b.velocity);
    if (!Number.isFinite(velocity) || velocity < 20 || velocity > 130) {
      return res.status(400).json({ error: 'velocity must be a plausible mph value (20–130)' });
    }
    const readingId = db.prepare(
      `INSERT INTO cmd_radar_readings (job_id, source, velocity, source_timestamp, context, created_by)
       VALUES (?, 'manual', ?, ?, ?, ?)`
    ).run(job.id, velocity, String(b.source_timestamp || ''), String(b.context || ''), req.internal.id).lastInsertRowid;
    try {
      const reading = classifyReading(db, readingId, {
        player_id: b.player_id ?? null,
        pitch_or_exit: b.pitch_or_exit || 'unknown',
        pitch_type: b.pitch_type || 'unknown',
        status: b.status || (b.player_id ? 'matched' : 'unmatched'),
        note: b.note ?? '',
      }, req.internal.id);
      res.status(201).json({ reading });
    } catch (err) {
      db.prepare('DELETE FROM cmd_radar_readings WHERE id = ?').run(readingId);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.put('/api/command/radar-readings/:id', requireInternal, (req, res) => {
    try {
      res.json({ reading: classifyReading(db, Number(req.params.id), req.body || {}, req.internal.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Queue payload: readings + roster (dated memberships + event roster) +
  // live per-player rollup previews from current draft results.
  app.get('/api/command/jobs/:id/radar', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Provenance travels with every reading: which file, which row, and who
    // confirmed it — the source columns themselves are immutable (db trigger).
    const readings = db.prepare(
      `SELECT r.*, p.first_name, p.last_name,
              i.filename AS import_filename,
              a.name AS confirmed_by_name, c.name AS created_by_name
         FROM cmd_radar_readings r
         LEFT JOIN players p ON p.id = r.player_id
         LEFT JOIN cmd_radar_imports i ON i.id = r.import_id
         LEFT JOIN admins a ON a.id = r.confirmed_by
         LEFT JOIN admins c ON c.id = r.created_by
        WHERE r.job_id = ? ORDER BY r.import_id, r.row_index, r.id`
    ).all(job.id);
    const imports = db.prepare(
      `SELECT i.id, i.filename, i.row_count, i.created_at, a.name AS created_by_name
         FROM cmd_radar_imports i LEFT JOIN admins a ON a.id = i.created_by
        WHERE i.job_id = ? ORDER BY i.id`
    ).all(job.id);

    const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(job.team_id);
    const rosterIds = new Set(memberships.filter(m => membershipCoversDate(m, job.game_date)).map(m => m.player_id));
    if (job.tournament_game_id) {
      const eventRows = db.prepare(
        `SELECT er.player_id FROM event_rosters er
         JOIN tournament_entries te ON te.id = er.entry_id
         WHERE te.team_id = ? AND te.tournament_id = ?`
      ).all(job.team_id, job.tournament_id);
      for (const r of eventRows) rosterIds.add(r.player_id);
    }
    const roster = rosterIds.size
      ? db.prepare(`SELECT id, first_name, last_name, primary_position FROM players WHERE id IN (${[...rosterIds].map(() => '?').join(',')}) ORDER BY last_name`).all(...rosterIds)
      : [];

    const drafts = db.prepare(
      `SELECT player_id, metric_code, value, status FROM cmd_metric_results
       WHERE job_id = ? AND metric_code IN ('pitch_velocity_radar', 'exit_velocity_radar')`
    ).all(job.id);
    const byPlayer = new Map();
    for (const d of drafts) {
      const k = `${d.player_id}:${d.metric_code}`;
      if (!byPlayer.has(k)) byPlayer.set(k, []);
      byPlayer.get(k).push({ value: d.value, status: 'approved' });   // preview rollup over current drafts
    }
    const summaries = [...byPlayer.entries()].map(([k, results]) => {
      const [playerId, code] = k.split(':');
      const p = db.prepare('SELECT first_name, last_name FROM players WHERE id = ?').get(playerId);
      const rollup = velocityRollup(results, code === 'exit_velocity_radar'
        ? { maxKey: 'max_exit_velo', avgKey: 'avg_exit_velo' } : { maxKey: 'max_velo', avgKey: 'avg_velo' });
      return { player_id: Number(playerId), name: `${p.first_name} ${p.last_name}`, metric_code: code, ...rollup.sample };
    });

    res.json({ readings, imports, roster, summaries, pitch_types: PITCH_TYPES });
  });
}
