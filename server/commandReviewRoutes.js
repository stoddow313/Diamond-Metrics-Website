// Command M5: review & publish surface. The reviewer sees every active
// result with its evidence, the QA flags, and the exact rollups that will
// publish — then approves per result and releases through the job status
// route (which runs the adapter). Analysts can look; deciding requires
// reviewer or admin.
import { computeQaFlags, decideResult, releasePlan } from './releaseLogic.js';
import { assessCapture } from './captureSpec.js';

export function mountCommandReviewRoutes(app, { db, requireInternal }) {
  const requireReviewer = (req, res, next) => requireInternal(req, res, () => {
    if (!['reviewer', 'admin'].includes(req.internal.role)) {
      return res.status(403).json({ error: 'Reviewer or admin role required' });
    }
    next();
  });

  app.get('/api/command/jobs/:id/review', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const qa_flags = computeQaFlags(db, job.id);
    const capture = assessCapture(db, job.id);
    const { metrics, plan } = releasePlan(db, job.id);

    // Every active result with player + evidence context, grouped for the UI.
    const results = db.prepare(
      `SELECT r.*, p.first_name, p.last_name, p.slug,
              m.start_frame, m.end_frame, m.fps_used, e.selected_feed_id,
              rr.velocity AS reading_velocity, rr.source_timestamp, rr.source AS reading_source, rr.pitch_type
         FROM cmd_metric_results r
         JOIN players p ON p.id = r.player_id
         LEFT JOIN cmd_measurements m ON r.evidence_kind = 'measurement' AND m.id = r.evidence_id
         LEFT JOIN cmd_events e ON e.id = m.event_id
         LEFT JOIN cmd_radar_readings rr ON r.evidence_kind = 'radar_reading' AND rr.id = r.evidence_id
        WHERE r.job_id = ? AND r.superseded_by IS NULL AND r.status != 'withdrawn'
        ORDER BY p.last_name, p.first_name, r.metric_code, r.id`
    ).all(job.id);

    const history = db.prepare(
      `SELECT r.id, r.metric_code, r.player_id, r.value, r.status, r.superseded_by, p.first_name, p.last_name
         FROM cmd_metric_results r JOIN players p ON p.id = r.player_id
        WHERE r.job_id = ? AND (r.superseded_by IS NOT NULL OR r.status = 'withdrawn')
        ORDER BY r.id`
    ).all(job.id);

    res.json({
      job,
      qa_flags,
      capture,
      metrics,
      results,
      history,
      plan: plan.map(({ metric_code, player_id, rollup }) => ({ metric_code, player_id, rollup })),
    });
  });

  // An explicit, audited exception to a metric's capture requirements — the
  // only way a blocked metric proceeds. Reviewer/admin only, reason required.
  app.post('/api/command/jobs/:id/capture-overrides', requireReviewer, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { metric_code, note } = req.body || {};
    if (!metric_code) return res.status(400).json({ error: 'metric_code is required' });
    if (!String(note || '').trim()) return res.status(400).json({ error: 'A written reason is required to override a capture requirement' });
    if (!db.prepare('SELECT 1 FROM cmd_metric_registry WHERE metric_code = ?').get(metric_code)) {
      return res.status(400).json({ error: 'Unknown metric_code' });
    }
    db.prepare(
      `INSERT INTO cmd_capture_overrides (job_id, metric_code, note, actor_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (job_id, metric_code) DO UPDATE SET note = excluded.note, actor_id = excluded.actor_id, created_at = datetime('now')`
    ).run(job.id, metric_code, String(note).trim(), req.internal.id);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, new_state) VALUES ('cmd_jobs', ?, ?, 'capture_override', ?, ?)"
    ).run(job.id, req.internal.id, String(note).trim(), metric_code);
    res.status(201).json({ capture: assessCapture(db, job.id) });
  });

  app.delete('/api/command/jobs/:id/capture-overrides/:code', requireReviewer, (req, res) => {
    db.prepare('DELETE FROM cmd_capture_overrides WHERE job_id = ? AND metric_code = ?').run(req.params.id, req.params.code);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, new_state) VALUES ('cmd_jobs', ?, ?, 'capture_override_removed', '', ?)"
    ).run(req.params.id, req.internal.id, req.params.code);
    res.json({ capture: assessCapture(db, req.params.id) });
  });

  app.post('/api/command/results/:id/decision', requireReviewer, (req, res) => {
    try {
      const result = decideResult(db, req.params.id, req.body || {}, req.internal.id);
      res.json({ result });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });
}
