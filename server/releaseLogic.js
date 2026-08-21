// Command M5: review gates + the metric-release adapter (TDR §5/§5a).
// cmd_metric_results keep every reading/attempt as evidence; only approved
// display rollups (DM_RELEASE_V1) publish into the existing games/
// stat_entries path. Unavailable never becomes zero and never enters an
// average; a paid metric with nothing releasable notifies the customer.
import { rollupForMetricCode, RELEASE_VERSION } from './metricRelease.js';
import { emitJobEvent } from './notifications.js';

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

// Results that still count: never superseded, never withdrawn.
const ACTIVE_RESULTS = `
  SELECT r.* FROM cmd_metric_results r
  WHERE r.job_id = ? AND r.superseded_by IS NULL AND r.status != 'withdrawn'`;

function orderedMetrics(db, jobId) {
  return db.prepare(
    `SELECT req.metric_code, reg.label, reg.unit, reg.decimals, reg.method, reg.publishes_to
       FROM cmd_metric_requirements req
       JOIN cmd_jobs j ON j.order_id = req.order_id
       JOIN cmd_metric_registry reg ON reg.metric_code = req.metric_code
      WHERE j.id = ? AND req.enabled = 1
      ORDER BY req.priority, req.metric_code`
  ).all(jobId).map(m => ({ ...m, publishes_to: JSON.parse(m.publishes_to || '[]') }));
}

// ---------------------------------------------------------------------------
// Capture-readiness gate + automated QA flags. 'blocking' flags stop the
// approve transition; 'warning' flags surface on the review screen.
export function computeQaFlags(db, jobId) {
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError('Job not found', 404);
  const flags = [];
  const metrics = orderedMetrics(db, jobId);
  const results = db.prepare(ACTIVE_RESULTS).all(jobId);
  const feeds = db.prepare('SELECT * FROM cmd_video_feeds WHERE job_id = ?').all(jobId);
  const ready = feeds.filter(f => f.status === 'ready');
  const needsVideo = metrics.some(m => m.method === 'frame_timed');

  const consent = db.prepare('SELECT * FROM cmd_consent WHERE job_id = ? AND media_consent = 1').get(jobId);
  if (!consent) {
    flags.push({ code: 'consent_missing', level: 'blocking', label: 'No media consent on record', detail: 'Metrics cannot be approved for release without recorded consent.' });
  }

  const drafts = results.filter(r => r.status === 'draft');
  if (drafts.length > 0) {
    flags.push({ code: 'unreviewed_results', level: 'blocking', label: `${drafts.length} result${drafts.length === 1 ? '' : 's'} awaiting review`, detail: 'Every draft result must be approved or returned before the job can be approved.' });
  }

  const order = db.prepare('SELECT o.contact_email FROM cmd_orders o JOIN cmd_jobs j ON j.order_id = o.id WHERE j.id = ?').get(jobId);
  if (!order?.contact_email) {
    flags.push({ code: 'no_contact_email', level: 'warning', label: 'Order has no contact email', detail: 'Customer notifications will be recorded in-app but no email can be sent.' });
  }

  if (needsVideo && ready.length === 0) {
    flags.push({ code: 'no_ready_feed', level: 'warning', label: 'Timing metrics ordered but no ready video feed', detail: 'Frame-timed metrics will release as unavailable unless footage is processed.' });
  }
  for (const f of ready) {
    if (f.vfr) flags.push({ code: 'vfr_feed', level: 'warning', label: `Feed "${f.label}" was variable frame rate`, detail: 'The proxy was normalized to constant frame rate; timing uses the proxy clock.' });
    if (needsVideo && f.effective_fps && f.effective_fps < 50) {
      flags.push({ code: 'low_fps', level: 'warning', label: `Feed "${f.label}" is ${f.effective_fps.toFixed(0)} fps`, detail: 'Below the preferred 60 fps — timing precision is reduced (±1 frame is larger).' });
    }
  }

  const unmatched = db.prepare("SELECT COUNT(*) n FROM cmd_radar_readings WHERE job_id = ? AND status = 'unmatched' AND velocity IS NOT NULL").get(jobId).n;
  if (unmatched > 0) {
    flags.push({ code: 'unmatched_radar', level: 'warning', label: `${unmatched} radar reading${unmatched === 1 ? '' : 's'} still unmatched`, detail: 'Unmatched readings never publish; confirm or invalidate them if they belong to this job.' });
  }

  for (const m of metrics) {
    if (m.metric_code === 'ninety_ft_speed') continue;   // derived — rides home_to_first
    if (!results.some(r => r.metric_code === m.metric_code)) {
      flags.push({ code: 'metric_no_data', level: 'warning', label: `${m.label}: no results recorded`, detail: 'This ordered metric will release as unavailable and the customer will be notified.' });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Per-result review decision. Reviewer/admin only (enforced at the route):
// draft → approved, or approved → draft (returned for rework). Unavailable
// results carry their reason and need no decision.
export function decideResult(db, resultId, { decision, note = '' }, actorId) {
  const result = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
  if (!result) throw httpError('Result not found', 404);
  if (result.superseded_by != null || result.status === 'withdrawn') throw httpError('This result was superseded — decide on its replacement', 409);
  if (!['approved', 'draft'].includes(decision)) throw httpError("decision must be 'approved' or 'draft'");
  if (result.status === 'unavailable') throw httpError('Unavailable results release with their reason — there is nothing to approve');
  if (result.status === 'published') throw httpError('Published results change via correction (reopen the job), not review');
  if (result.status === decision) return result;

  const apply = db.transaction(() => {
    db.prepare("UPDATE cmd_metric_results SET status = ?, updated_at = datetime('now') WHERE id = ?").run(decision, resultId);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_metric_results', ?, ?, 'reviewed', ?, ?, ?)"
    ).run(resultId, actorId, note, result.status, decision);
  });
  apply();
  return db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
}

// ---------------------------------------------------------------------------
// Rollup preview: exactly what the adapter would publish right now, grouped
// per player × ordered metric. Shared by the review screen and the release.
export function releasePlan(db, jobId) {
  const metrics = orderedMetrics(db, jobId);
  // DM_RELEASE_V1 rolls up 'approved' values. Results published by an
  // earlier release stay releasable — a correction re-release must keep
  // them in the rollup, not treat them as undelivered.
  const results = db.prepare(`${ACTIVE_RESULTS} ORDER BY r.player_id, r.metric_code, r.id`).all(jobId)
    .map(r => (r.status === 'published' ? { ...r, status: 'approved', published: true } : r));
  const plan = [];
  for (const metric of metrics) {
    const byPlayer = new Map();
    for (const r of results.filter(x => x.metric_code === metric.metric_code)) {
      if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
      byPlayer.get(r.player_id).push(r);
    }
    for (const [playerId, playerResults] of byPlayer) {
      const rollup = rollupForMetricCode(metric.metric_code, playerResults);
      if (!rollup) continue;   // no Phase 1 publish mapping (e.g. derived 90-ft speed)
      plan.push({ metric_code: metric.metric_code, method: metric.method, player_id: playerId, rollup, results: playerResults });
    }
  }
  return { metrics, plan };
}

// ---------------------------------------------------------------------------
// The release adapter. Runs when metric_release_status transitions to
// 'released': publishes approved rollups into games/stat_entries (with
// method + metric_result_id provenance), marks contributing results
// published, clears adapter-owned entries that no longer release
// (corrections), and notifies when a paid metric has nothing releasable.
export function releaseMetrics(db, jobId, actorId) {
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError('Job not found', 404);
  const { metrics, plan } = releasePlan(db, jobId);
  const managedKeys = [...new Set(metrics.flatMap(m => m.publishes_to))];

  const published = [];
  const run = db.transaction(() => {
    const gameIds = new Map();   // player_id → games.id (find-or-create per job)
    const gameFor = (playerId) => {
      if (gameIds.has(playerId)) return gameIds.get(playerId);
      let game = db.prepare('SELECT id FROM games WHERE player_id = ? AND command_job_id = ?').get(playerId, jobId);
      if (!game) {
        const id = db.prepare(
          'INSERT INTO games (player_id, game_date, game_type, opponent, tournament_game_id, command_job_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(playerId, job.game_date, job.game_type, job.opponent_label || job.event_label || '', job.tournament_game_id ?? null, jobId).lastInsertRowid;
        game = { id };
      }
      gameIds.set(playerId, game.id);
      return game.id;
    };

    for (const item of plan) {
      if (!item.rollup.released) continue;
      const gameId = gameFor(item.player_id);
      for (const entry of item.rollup.entries) {
        // Provenance points at the exact result that holds the published
        // value (max/best); averages aggregate many results and carry only
        // the method. Published values are rounded to the registry's
        // decimals, so the raw result value must be compared rounded too.
        const dec = metrics.find(m => m.metric_code === item.metric_code)?.decimals ?? 2;
        const source = item.results.find(r => r.status !== 'unavailable' && r.value != null && Number(r.value.toFixed(dec)) === entry.value);
        db.prepare(
          `INSERT INTO stat_entries (game_id, metric_key, value, method, metric_result_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (game_id, metric_key) DO UPDATE SET value = excluded.value, method = excluded.method, metric_result_id = excluded.metric_result_id`
        ).run(gameId, entry.metric_key, entry.value, item.method, source ? source.id : null);
        published.push({ player_id: item.player_id, metric_key: entry.metric_key, value: entry.value, sample: item.rollup.sample });
      }
      for (const r of item.results) {
        if (r.status === 'approved') {
          db.prepare("UPDATE cmd_metric_results SET status = 'published', updated_at = datetime('now') WHERE id = ?").run(r.id);
        }
      }
    }

    // Corrections: adapter-owned entries (method set) for keys that no longer
    // release are removed — the evidence chain in cmd_metric_results is the
    // history. Manually entered admin stats (method NULL) are never touched.
    if (managedKeys.length > 0) {
      const publishedKeys = new Set(published.map(p => `${p.player_id}:${p.metric_key}`));
      for (const [playerId, gameId] of gameIds) {
        for (const key of managedKeys) {
          if (!publishedKeys.has(`${playerId}:${key}`)) {
            db.prepare('DELETE FROM stat_entries WHERE game_id = ? AND metric_key = ? AND method IS NOT NULL').run(gameId, key);
          }
        }
      }
    }

    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'metrics_released', ?, '', ?)"
    ).run(jobId, actorId, `${published.length} entr${published.length === 1 ? 'y' : 'ies'} published (${RELEASE_VERSION})`, RELEASE_VERSION);
  });
  run();

  // Paid-metric-unavailable: an ordered metric with nothing releasable
  // job-wide. Deduped against the last notification so a correction
  // re-release doesn't re-email an unchanged situation.
  const undelivered = metrics
    .filter(m => m.publishes_to.length > 0)
    .filter(m => !plan.some(p => p.metric_code === m.metric_code && p.rollup.released))
    .map(m => m.metric_code);
  if (undelivered.length > 0) {
    const reasons = db.prepare(
      `SELECT DISTINCT unavailable_reason FROM cmd_metric_results
        WHERE job_id = ? AND status = 'unavailable' AND superseded_by IS NULL AND unavailable_reason != ''`
    ).all(jobId).map(r => r.unavailable_reason);
    const last = db.prepare(
      "SELECT payload FROM cmd_notifications WHERE job_id = ? AND event_key = 'paid_metric_unavailable' ORDER BY id DESC LIMIT 1"
    ).get(jobId);
    const payload = { metric_codes: undelivered.sort(), reasons };
    if (!last || JSON.stringify(JSON.parse(last.payload).metric_codes) !== JSON.stringify(payload.metric_codes)) {
      emitJobEvent(db, { jobId, eventKey: 'paid_metric_unavailable', payload });
    }
  }

  return { published, undelivered };
}
