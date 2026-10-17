// Command M3 routes: radar CSV import (idempotent, raw preserved), manual
// readings (owner directive field set), classification queue, and live
// per-player rollup previews via the TDR §5a mapping.
import { classifyReading, PITCH_TYPES, suggestMatches, importRadarCsv } from './radarImport.js';
import { velocityRollup } from './metricRelease.js';
import { commandRoster } from './commandRoster.js';
import { pairingOf, pairJobIds, jobForPlayer, moveReadingToJob } from './gamePairing.js';

export function mountCommandRadarRoutes(app, { db, requireInternal }) {
  app.post('/api/command/jobs/:id/radar-imports', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { filename = 'radar.csv', content } = req.body || {};
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content (CSV text) is required' });

    try {
      const r = importRadarCsv(db, job.id, { filename, content }, req.internal.id);
      res.status(r.duplicate ? 200 : 201).json(r);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
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

  // Bulk: many readings to one pitcher (or back to unmatched, or invalid) in
  // one go — a pitcher's stint, a half inning split at the pauses. A pitcher
  // on the paired job's roster takes the readings to that job.
  app.post('/api/command/jobs/:id/radar-readings/assign', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    const ids = [...new Set((Array.isArray(b.reading_ids) ? b.reading_ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Choose the readings to assign' });
    if (ids.length > 2000) return res.status(400).json({ error: 'Assign at most 2,000 readings at a time' });
    const status = b.status || 'matched';
    if (!['matched', 'unmatched', 'invalid'].includes(status)) return res.status(400).json({ error: 'status must be matched, unmatched or invalid' });
    let owner = job.id;
    if (status === 'matched') {
      owner = jobForPlayer(db, job, b.player_id);
      if (!owner) return res.status(400).json({ error: "Pick a player on this job's roster or the paired job's" });
    }
    const pair = pairJobIds(db, job);
    const rows = db.prepare(
      `SELECT id, job_id FROM cmd_radar_readings WHERE id IN (${ids.map(() => '?').join(',')}) AND job_id IN (${pair.map(() => '?').join(',')})`
    ).all(...ids, ...pair);
    if (rows.length !== ids.length) return res.status(400).json({ error: 'Some of those readings are not on this job' });
    try {
      db.transaction(() => {
        for (const r of rows) {
          if (status === 'matched') moveReadingToJob(db, r.id, owner);
          classifyReading(db, r.id, {
            player_id: status === 'matched' ? Number(b.player_id) : null,
            pitch_or_exit: b.pitch_or_exit || (status === 'matched' ? 'pitch' : undefined),
            pitch_type: b.pitch_type || undefined,
            status,
          }, req.internal.id);
        }
      })();
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    res.json({ assigned: rows.length, moved: rows.filter(r => r.job_id !== owner).length, job_id: owner });
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

    // Roster = dated team roster + event roster (incl. guests) + job guests;
    // a paired game adds the other team's job roster for their pitchers.
    const roster = commandRoster(db, job);
    const partner = pairingOf(db, job).partner;
    const partnerRoster = partner ? commandRoster(db, partner) : [];
    // Suggested matches ride each unmatched reading; confirming one is an
    // ordinary classification, so nothing here can publish by itself.
    const suggestions = suggestMatches(readings);

    const drafts = db.prepare(
      `SELECT player_id, metric_code, value, status FROM cmd_metric_results
       WHERE job_id = ? AND metric_code IN ('pitch_velocity_radar', 'exit_velocity_radar')
         AND status != 'withdrawn' AND superseded_by IS NULL AND value IS NOT NULL`
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

    res.json({
      readings: readings.map(r => ({ ...r, suggestion: suggestions.get(r.id) || null })),
      imports, roster, summaries, pitch_types: PITCH_TYPES,
      partner: partner ? { job_id: partner.id, team_name: db.prepare('SELECT name FROM teams WHERE id = ?').get(partner.team_id)?.name || '' } : null,
      partner_roster: partnerRoster,
    });
  });
}
