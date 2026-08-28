// Machine-checkable capture requirements per metric recipe.
//
// The registry's `capture_requirements` prose is what an analyst reads; this
// is what the system enforces. Without it Command accepted a 720p feed as
// READY for Rookie timing, which needs 1080p/30 minimum — the requirement was
// documented and unenforced, so the only thing standing between bad capture
// and a published metric was someone remembering.
//
// Severity:
//   blocking — the metric cannot be measured from this feed. Requires an
//              explicit, audited override to proceed anyway.
//   warning  — measurable, but precision or reliability is degraded.

export const CAPTURE_SPECS = {
  // Frame-timed running metrics: resolution decides whether the contact and
  // base-touch frames are legible; frame rate decides the timing floor.
  home_to_first: { min_height: 1080, min_fps: 30, preferred_fps: 60, needs_video: true, view: 'Contact and first base both visible' },
  steal_time:    { min_height: 1080, min_fps: 30, preferred_fps: 60, needs_video: true, view: 'Committed start and destination base both visible' },
  ninety_ft_speed: { derived_from: 'home_to_first' },
  // Radar velocity comes from the radar device, not the video.
  pitch_velocity_radar: { needs_video: false },
  exit_velocity_radar:  { needs_video: false },
};

// NTSC rates sit fractionally below their nominal value (60000/1001 =
// 59.94, 30000/1001 = 29.97). Treating those as "below 60" or "below 30"
// would flag every normal camera, so thresholds carry a small tolerance —
// wide enough for NTSC, far too tight to let 30 pass as 60.
const NTSC_TOLERANCE = 0.15;
const meetsRate = (fps, threshold) => fps >= threshold - NTSC_TOLERANCE;

// One frame at 30 fps is 33 ms; at 60 it is 17. Both are usable for a ~4.5 s
// run, which is why 30 warns rather than blocks.
export function evaluateFeed(spec, feed) {
  const issues = [];
  if (!spec || !spec.needs_video) return issues;

  const height = feed.height || 0;
  const fps = feed.effective_fps || feed.nominal_fps || 0;

  if (spec.min_height && height && height < spec.min_height) {
    issues.push({
      severity: 'blocking',
      code: 'resolution_below_minimum',
      detail: `${feed.width}×${height} is below the ${spec.min_height}p minimum — the contact and base-touch frames are not reliably legible.`,
    });
  }
  if (spec.min_fps && fps && !meetsRate(fps, spec.min_fps)) {
    issues.push({
      severity: 'blocking',
      code: 'frame_rate_below_minimum',
      detail: `${fps.toFixed(2)} fps is below the ${spec.min_fps} fps minimum — one frame is ${(1000 / fps).toFixed(0)} ms of timing error.`,
    });
  } else if (spec.preferred_fps && fps && !meetsRate(fps, spec.preferred_fps)) {
    issues.push({
      severity: 'warning',
      code: 'frame_rate_below_preferred',
      detail: `${fps.toFixed(2)} fps is below the preferred ${spec.preferred_fps} — timing precision is ±${(1000 / fps).toFixed(0)} ms instead of ±${(1000 / spec.preferred_fps).toFixed(0)} ms.`,
    });
  }
  if (!height || !fps) {
    issues.push({ severity: 'warning', code: 'capture_spec_unknown', detail: 'Feed metadata is incomplete — capture suitability could not be checked.' });
  }
  return issues;
}

// Per-metric capture readiness across a job's feeds. A metric is satisfied by
// its BEST feed: one adequate angle is enough, and a second poor feed must not
// veto it. Feeds are ranked so the reported issues belong to the best option.
export function assessCapture(db, jobId) {
  const metrics = db.prepare(
    `SELECT req.metric_code, reg.label, reg.method
       FROM cmd_metric_requirements req
       JOIN cmd_jobs j ON j.order_id = req.order_id
       JOIN cmd_metric_registry reg ON reg.metric_code = req.metric_code
      WHERE j.id = ? AND req.enabled = 1
      ORDER BY req.priority, req.metric_code`
  ).all(jobId);
  const feeds = db.prepare("SELECT * FROM cmd_video_feeds WHERE job_id = ? AND status = 'ready'").all(jobId);
  const overrides = db.prepare(
    "SELECT metric_code, note, actor_id, created_at FROM cmd_capture_overrides WHERE job_id = ?"
  ).all(jobId);
  const overrideFor = code => overrides.find(o => o.metric_code === code) || null;

  return metrics.map(m => {
    const spec = CAPTURE_SPECS[m.metric_code];
    if (!spec || spec.derived_from) {
      return { metric_code: m.metric_code, label: m.label, status: 'not_applicable', derived_from: spec?.derived_from ?? null, issues: [] };
    }
    if (!spec.needs_video) {
      return { metric_code: m.metric_code, label: m.label, status: 'ok', issues: [], note: 'Measured from radar, not video.' };
    }
    if (feeds.length === 0) {
      return {
        metric_code: m.metric_code, label: m.label, status: 'blocked',
        issues: [{ severity: 'blocking', code: 'no_ready_feed', detail: 'No processed video feed on this job.' }],
        override: overrideFor(m.metric_code),
      };
    }
    // Best feed = fewest blocking issues, then fewest issues overall.
    const ranked = feeds
      .map(f => ({ feed: f, issues: evaluateFeed(spec, f) }))
      .sort((a, b) => {
        const ab = a.issues.filter(i => i.severity === 'blocking').length;
        const bb = b.issues.filter(i => i.severity === 'blocking').length;
        return ab - bb || a.issues.length - b.issues.length;
      });
    const best = ranked[0];
    const blocking = best.issues.filter(i => i.severity === 'blocking');
    const override = overrideFor(m.metric_code);
    return {
      metric_code: m.metric_code,
      label: m.label,
      status: blocking.length === 0 ? (best.issues.length ? 'warning' : 'ok') : (override ? 'overridden' : 'blocked'),
      best_feed: { id: best.feed.id, name: best.feed.original_name || best.feed.label, height: best.feed.height, fps: best.feed.effective_fps },
      issues: best.issues,
      override,
    };
  });
}

// The structured reason a blocked metric releases as unavailable — the same
// controlled vocabulary the measurement drawer uses.
export function unavailableReasonFor(assessment) {
  const blocking = (assessment.issues || []).find(i => i.severity === 'blocking');
  if (!blocking) return null;
  if (blocking.code === 'no_ready_feed') return 'camera_stopped';
  return 'insufficient_capture_quality';
}
