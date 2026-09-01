// Command M6: pipeline telemetry — where jobs spend time, how often
// evidence is unmeasurable, how often review sends work back.
//
// These are the numbers that turn the 2–3-week pilot estimate into a real
// per-game cost model (PRD Phase 5), so the aggregation core is pure and
// tested: SQLite timestamps in, hours and rates out.
export const METRIC_STAGES = ['not_started', 'in_progress', 'ready_for_review', 'needs_correction', 'approved'];

// SQLite datetime('now') is UTC without a zone marker.
export function parseTs(value) {
  if (!value) return null;
  const ms = Date.parse(`${String(value).replace(' ', 'T')}${/[Zz]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'}`);
  return Number.isNaN(ms) ? null : ms;
}

export function percentile(values, p) {
  const sorted = [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const hours = ms => Number((ms / 3_600_000).toFixed(2));

// One job's time-in-stage. The job enters 'not_started' when created; each
// transition closes the previous stage. A job still mid-pipeline has its
// current stage measured to `now` and marked open (excluded from completed
// stage stats so an in-flight job can't look like a slow one).
export function stageDurations({ createdAt, transitions = [], now = Date.now() }) {
  const start = parseTs(createdAt);
  if (start == null) return { stages: [], open: null };
  const ordered = [...transitions]
    .map(t => ({ ...t, at: parseTs(t.created_at) }))
    .filter(t => t.at != null)
    .sort((a, b) => a.at - b.at);

  const stages = [];
  let stage = 'not_started';
  let enteredAt = start;
  for (const t of ordered) {
    stages.push({ stage, hours: hours(t.at - enteredAt), closed: true });
    stage = t.new_state;
    enteredAt = t.at;
  }
  return { stages, open: { stage, hours: hours(now - enteredAt), closed: false } };
}

// Roll many jobs' stage lists into per-stage p50/p90.
export function summarizeStages(jobStages) {
  const byStage = new Map();
  for (const { stages } of jobStages) {
    for (const s of stages) {
      if (!byStage.has(s.stage)) byStage.set(s.stage, []);
      byStage.get(s.stage).push(s.hours);
    }
  }
  return METRIC_STAGES.filter(s => byStage.has(s)).map(stage => {
    const values = byStage.get(stage);
    return {
      stage,
      samples: values.length,
      p50_hours: percentile(values, 50),
      p90_hours: percentile(values, 90),
    };
  });
}

const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);

export function computeRates({ readings = [], results = [], returns = 0, reviewedJobs = 0 }) {
  // Unparseable rows (no velocity) can never match — they'd depress the
  // match rate for a reason that has nothing to do with matching.
  const parseable = readings.filter(r => r.velocity != null);
  const matched = parseable.filter(r => r.status === 'matched').length;
  const invalid = parseable.filter(r => r.status === 'invalid').length;
  const unmatched = parseable.filter(r => r.status === 'unmatched').length;

  const unavailable = results.filter(r => r.status === 'unavailable').length;
  return {
    radar: {
      readings: readings.length,
      unparseable: readings.length - parseable.length,
      matched, invalid, unmatched,
      match_rate: rate(matched, parseable.length),
    },
    results: {
      total: results.length,
      unavailable,
      unavailable_rate: rate(unavailable, results.length),
    },
    review: {
      jobs_reviewed: reviewedJobs,
      returns,
      return_rate: rate(returns, reviewedJobs),
    },
  };
}

// ---------------------------------------------------------------------------
// DB aggregation over a trailing window.
export function pipelineTelemetry(db, { sinceDays = 30, now = Date.now() } = {}) {
  const since = new Date(now - sinceDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

  // Synthetic (pipeline-test) jobs never enter the analytics — their timing
  // and match rates say nothing about customer work.
  const jobs = db.prepare(
    `SELECT j.id, j.created_at, j.metric_release_status, j.game_record_status
       FROM cmd_jobs j JOIN cmd_orders o ON o.id = j.order_id
      WHERE j.created_at >= ? AND o.synthetic = 0`
  ).all(since);

  // Both release tracks audit as 'status_changed'; the note carries the kind.
  const transitions = db.prepare(
    `SELECT target_id AS job_id, prev_state, new_state, created_at
       FROM cmd_review_actions
      WHERE target_table = 'cmd_jobs' AND action = 'status_changed' AND note LIKE 'metric_release%'
      ORDER BY created_at`
  ).all();
  const byJob = new Map();
  for (const t of transitions) {
    if (!byJob.has(t.job_id)) byJob.set(t.job_id, []);
    byJob.get(t.job_id).push(t);
  }

  const jobStages = jobs.map(j => stageDurations({ createdAt: j.created_at, transitions: byJob.get(j.id) || [], now }));

  // Turnaround: job creation → first release.
  const turnarounds = [];
  for (const j of jobs) {
    const released = (byJob.get(j.id) || []).find(t => t.new_state === 'released');
    const start = parseTs(j.created_at);
    if (released && start != null) turnarounds.push(hours(parseTs(released.created_at) - start));
  }

  const readings = db.prepare(
    `SELECT r.velocity, r.status FROM cmd_radar_readings r
       JOIN cmd_jobs j ON j.id = r.job_id JOIN cmd_orders o ON o.id = j.order_id
      WHERE j.created_at >= ? AND o.synthetic = 0`
  ).all(since);
  const results = db.prepare(
    `SELECT r.status FROM cmd_metric_results r
       JOIN cmd_jobs j ON j.id = r.job_id JOIN cmd_orders o ON o.id = j.order_id
      WHERE j.created_at >= ? AND o.synthetic = 0 AND r.superseded_by IS NULL AND r.status != 'withdrawn'`
  ).all(since);

  // A "return" is work sent back: a job moved to needs_correction, or a
  // reviewer flipped an approved result back to draft.
  const jobReturns = transitions.filter(t => t.new_state === 'needs_correction' && byJob.has(t.job_id)).length;
  const resultReturns = db.prepare(
    `SELECT COUNT(*) n FROM cmd_review_actions
      WHERE target_table = 'cmd_metric_results' AND action = 'reviewed'
        AND prev_state = 'approved' AND new_state = 'draft' AND created_at >= ?`
  ).get(since).n;
  const reviewedJobs = new Set(transitions.filter(t => t.new_state === 'ready_for_review').map(t => t.job_id)).size;

  const media = db.prepare(
    `SELECT kind, status, created_at, started_at, finished_at, attempts
       FROM cmd_media_jobs WHERE created_at >= ?`
  ).all(since);
  const mediaByKind = [...new Set(media.map(m => m.kind))].map(kind => {
    const rows = media.filter(m => m.kind === kind);
    const done = rows.filter(m => m.status === 'done' && m.started_at && m.finished_at);
    const waits = rows.filter(m => m.started_at).map(m => hours(parseTs(m.started_at) - parseTs(m.created_at)));
    const runs = done.map(m => (parseTs(m.finished_at) - parseTs(m.started_at)) / 1000);
    return {
      kind,
      total: rows.length,
      failed: rows.filter(m => m.status === 'failed').length,
      retried: rows.filter(m => m.attempts > 1).length,
      p50_queue_hours: percentile(waits, 50),
      p50_seconds: percentile(runs, 50) != null ? Number(percentile(runs, 50).toFixed(1)) : null,
      p90_seconds: percentile(runs, 90) != null ? Number(percentile(runs, 90).toFixed(1)) : null,
    };
  });

  return {
    window_days: sinceDays,
    jobs: {
      total: jobs.length,
      released: jobs.filter(j => j.metric_release_status === 'released').length,
      in_flight: jobs.filter(j => !['released'].includes(j.metric_release_status)).length,
      p50_turnaround_hours: percentile(turnarounds, 50),
      p90_turnaround_hours: percentile(turnarounds, 90),
    },
    stages: summarizeStages(jobStages),
    media: mediaByKind,
    ...computeRates({ readings, results, returns: jobReturns + resultReturns, reviewedJobs }),
  };
}
