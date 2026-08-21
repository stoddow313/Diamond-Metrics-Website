// Command M4 routes: running-attempt queues + the measurement drawer.
import { createAttempt, saveMeasurement, markUnavailable, UNAVAILABLE_REASONS, ATTEMPT_TYPES } from './measurementLogic.js';
import { timingRollup } from './metricRelease.js';
import { membershipCoversDate } from './rosterLogic.js';

export function mountCommandMeasureRoutes(app, { db, requireInternal }) {
  app.post('/api/command/jobs/:id/attempts', requireInternal, (req, res) => {
    if (!db.prepare('SELECT 1 FROM cmd_jobs WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Job not found' });
    try {
      res.status(201).json({ attempt: createAttempt(db, Number(req.params.id), req.body || {}, req.internal.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/command/attempts/:id/measure', requireInternal, (req, res) => {
    try {
      res.json({ measurement: saveMeasurement(db, Number(req.params.id), req.body || {}, req.internal.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/command/attempts/:id/unavailable', requireInternal, (req, res) => {
    try {
      res.json({ measurement: markUnavailable(db, Number(req.params.id), req.body || {}, req.internal.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/command/jobs/:id/attempts', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const attempts = db.prepare(
      `SELECT e.*, p.first_name, p.last_name, m.id AS measurement_id, m.start_frame, m.end_frame, m.fps_used,
              m.elapsed_s, m.validity, m.unavailable_reason, m.note AS measurement_note
       FROM cmd_events e
       JOIN players p ON p.id = e.player_id
       LEFT JOIN cmd_measurements m ON m.event_id = e.id
       WHERE e.job_id = ? AND e.event_type = 'running_attempt' AND e.status = 'active'
       ORDER BY e.sequence`
    ).all(job.id).map(a => ({ ...a, payload: JSON.parse(a.payload) }));

    const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(job.team_id);
    const rosterIds = new Set(memberships.filter(m => membershipCoversDate(m, job.game_date)).map(m => m.player_id));
    const roster = rosterIds.size
      ? db.prepare(`SELECT id, first_name, last_name, primary_position FROM players WHERE id IN (${[...rosterIds].map(() => '?').join(',')}) ORDER BY last_name`).all(...rosterIds)
      : [];

    const feeds = db.prepare(
      `SELECT f.id, f.label, f.status, f.effective_fps, f.vfr, r.id AS proxy_rendition_id, r.fps AS proxy_fps
       FROM cmd_video_feeds f
       LEFT JOIN cmd_media_renditions r ON r.feed_id = f.id AND r.kind = 'proxy'
       WHERE f.job_id = ? ORDER BY f.id`
    ).all(job.id);

    // Live per-player timing rollups from current draft/unavailable results.
    const summaries = [];
    for (const code of ['home_to_first', 'steal_time']) {
      const rows = db.prepare(
        `SELECT player_id, value, status FROM cmd_metric_results WHERE job_id = ? AND metric_code = ?`
      ).all(job.id, code);
      const byPlayer = new Map();
      for (const r of rows) {
        if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
        byPlayer.get(r.player_id).push({ value: r.value, status: r.status === 'unavailable' ? 'unavailable' : 'approved' });
      }
      for (const [playerId, results] of byPlayer) {
        const p = db.prepare('SELECT first_name, last_name FROM players WHERE id = ?').get(playerId);
        const rollup = timingRollup(results, { key: code });
        summaries.push({ player_id: playerId, name: `${p.first_name} ${p.last_name}`, metric_code: code, ...rollup.sample });
      }
    }

    res.json({ attempts, roster, feeds, summaries, unavailable_reasons: UNAVAILABLE_REASONS, attempt_types: ATTEMPT_TYPES });
  });
}
