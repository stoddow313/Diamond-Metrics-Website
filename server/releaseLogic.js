// Command M5: review gates + the metric-release adapter (TDR §5/§5a).
// cmd_metric_results keep every reading/attempt as evidence; only approved
// display rollups (DM_RELEASE_V1) publish into the existing games/
// stat_entries path. Unavailable never becomes zero and never enters an
// average; a paid metric with nothing releasable notifies the customer.
import { rollupForMetricCode, RELEASE_VERSION } from './metricRelease.js';
import { emitJobEvent } from './notifications.js';
import { assessCapture } from './captureSpec.js';

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

  // Per-feed VFR note stays; resolution/frame-rate suitability is now decided
  // per metric recipe below rather than by a blanket threshold.
  for (const f of ready) {
    if (f.vfr) flags.push({ code: 'vfr_feed', level: 'warning', label: `Feed "${f.label}" was variable frame rate`, detail: 'The proxy was normalized to constant frame rate; timing uses the proxy clock.' });
  }

  // Recipe-based capture QA: a metric whose capture requirements are not met
  // blocks approval until it is either re-captured or explicitly overridden.
  for (const a of assessCapture(db, jobId)) {
    if (a.status === 'blocked') {
      flags.push({
        code: `capture_${a.metric_code}`, level: 'blocking',
        label: `${a.label}: capture requirements not met`,
        detail: a.issues.map(i => i.detail).join(' ') + ' Re-capture, or record an explicit override.',
      });
    } else if (a.status === 'overridden') {
      flags.push({
        code: `capture_override_${a.metric_code}`, level: 'warning',
        label: `${a.label}: capture requirements overridden`,
        detail: `${a.issues.map(i => i.detail).join(' ')} Override on record: "${a.override.note}".`,
      });
    } else if (a.status === 'warning') {
      for (const i of a.issues) {
        flags.push({ code: `capture_${i.code}_${a.metric_code}`, level: 'warning', label: `${a.label}: ${i.code.replace(/_/g, ' ')}`, detail: i.detail });
      }
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
  if (result.status === 'withdrawn') throw httpError('This result is withdrawn — restore the reading or measurement to revive it', 409);
  if (result.superseded_by != null) throw httpError('This result was superseded — decide on its replacement', 409);
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
export function releasePlan(db, jobId, { publishedOnly = false } = {}) {
  const metrics = orderedMetrics(db, jobId);
  // DM_RELEASE_V1 rolls up 'approved' values. Results published by an
  // earlier release stay releasable — a correction re-release must keep
  // them in the rollup, not treat them as undelivered. publishedOnly is the
  // correction resync's view: what the profile may show right now, which
  // is only what a release has already published.
  const results = db.prepare(`${ACTIVE_RESULTS} ORDER BY r.player_id, r.metric_code, r.id`).all(jobId)
    .filter(r => !publishedOnly || r.status === 'published')
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
// Result lifecycle: one raw reading or measurement has exactly one derived
// result per metric. Invalidation withdraws that row (remembering what it
// was); restoring the same evidence to the same player revives that same
// row. Nothing is deleted, nothing is duplicated, and the profile is
// resynced immediately so a withdrawn value never lingers on a player page
// until someone remembers to re-release.
const auditResult = (db, resultId, actorId, action, note, prev, next) => db.prepare(
  "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_metric_results', ?, ?, ?, ?, ?, ?)"
).run(resultId, actorId ?? null, action, String(note || ''), prev ?? '', next ?? '');

const sameValue = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);

// The live result for a piece of evidence — the one row that may count.
// Legacy supersede chains (pre-2026-09) are skipped; a withdrawn row is
// returned when nothing live exists so it can be revived instead of cloned.
export function resultForEvidence(db, evidenceKind, evidenceId, metricCode = null) {
  return db.prepare(
    `SELECT * FROM cmd_metric_results
      WHERE evidence_kind = ? AND evidence_id = ? AND superseded_by IS NULL ${metricCode ? 'AND metric_code = ?' : ''}
      ORDER BY (status != 'withdrawn') DESC, id DESC LIMIT 1`
  ).get(...(metricCode ? [evidenceKind, evidenceId, metricCode] : [evidenceKind, evidenceId])) || null;
}

export function withdrawResult(db, resultId, { reason = '', actorId = null } = {}) {
  const r = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
  if (!r) throw httpError('Result not found', 404);
  if (r.status === 'withdrawn') return r;
  db.prepare("UPDATE cmd_metric_results SET status = 'withdrawn', restore_status = ?, updated_at = datetime('now') WHERE id = ?").run(r.status, resultId);
  auditResult(db, resultId, actorId, 'withdrawn', reason, r.status, 'withdrawn');
  return db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
}

// Bring a result into line with its evidence. Same facts on a withdrawn row
// → revived to the status it held before (a published value returns to the
// profile at once). Changed facts (player, metric, value) on a decided row
// → back to draft for review; on a draft → updated in place. Idempotent:
// identical facts on a live row change nothing.
const STATUS_RANK = { draft: 0, approved: 1, published: 2 };

export function applyResultState(db, resultId, { player_id, metric_code, value, actorId = null, reason = '', reviveCap = null }) {
  const r = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
  if (!r) throw httpError('Result not found', 404);
  const same = r.player_id === player_id && r.metric_code === metric_code && sameValue(r.value, value) && r.status !== 'unavailable';
  if (r.status !== 'withdrawn' && same) return r;

  let status;
  let action;
  if (r.status === 'withdrawn') {
    status = same ? (r.restore_status || 'draft') : 'draft';
    // A derived result can never outrank the parent it is computed from.
    if (reviveCap && (STATUS_RANK[status] ?? 0) > (STATUS_RANK[reviveCap] ?? 0)) status = reviveCap;
    action = 'revived';
  } else if (['approved', 'published'].includes(r.status)) {
    status = 'draft';
    action = 'reassigned';
  } else {
    status = 'draft';   // draft or unavailable with new facts
    action = 'updated';
  }
  db.prepare(
    `UPDATE cmd_metric_results SET player_id = ?, metric_code = ?, value = ?, status = ?, restore_status = NULL, unavailable_reason = '', updated_at = datetime('now') WHERE id = ?`
  ).run(player_id, metric_code, value, status, resultId);
  auditResult(db, resultId, actorId, action,
    reason || `${r.metric_code} ${r.value ?? '—'} (player ${r.player_id}) → ${metric_code} ${value ?? '—'} (player ${player_id})`,
    r.status, status);
  return db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
}

export function markResultUnavailable(db, resultId, { reason, actorId = null, note = '' }) {
  const r = db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
  if (!r) throw httpError('Result not found', 404);
  if (r.status === 'unavailable' && r.unavailable_reason === reason) return r;
  db.prepare(
    "UPDATE cmd_metric_results SET status = 'unavailable', value = NULL, unavailable_reason = ?, restore_status = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(reason, resultId);
  auditResult(db, resultId, actorId, 'marked_unavailable', note || reason, r.status, 'unavailable');
  return db.prepare('SELECT * FROM cmd_metric_results WHERE id = ?').get(resultId);
}

// Publish a plan's releasable rollups into games/stat_entries for one job
// and remove adapter-owned entries that no longer release — for every
// player the job has ever published for. Shared by the release and by the
// correction resync so the profile can never disagree with the results.
function writeRollups(db, job, { metrics, plan }) {
  const managedKeys = [...new Set(metrics.flatMap(m => m.publishes_to))];
  const gameIds = new Map(
    db.prepare('SELECT id, player_id FROM games WHERE command_job_id = ?').all(job.id).map(g => [g.player_id, g.id])
  );
  const gameFor = (playerId) => {
    if (gameIds.has(playerId)) return gameIds.get(playerId);
    const id = db.prepare(
      'INSERT INTO games (player_id, game_date, game_type, opponent, tournament_game_id, command_job_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(playerId, job.game_date, job.game_type, job.opponent_label || job.event_label || '', job.tournament_game_id ?? null, job.id).lastInsertRowid;
    gameIds.set(playerId, id);
    return id;
  };
  const current = db.prepare('SELECT value FROM stat_entries WHERE game_id = ? AND metric_key = ?');
  const upsert = db.prepare(
    `INSERT INTO stat_entries (game_id, metric_key, value, method, metric_result_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (game_id, metric_key) DO UPDATE SET value = excluded.value, method = excluded.method, metric_result_id = excluded.metric_result_id`
  );

  const published = [];
  const changes = [];
  const publishedKeys = new Set();
  for (const item of plan) {
    if (!item.rollup.released) continue;
    const gameId = gameFor(item.player_id);
    // Provenance points at the exact result that holds the published value
    // (max/best); averages aggregate many results and carry only the
    // method. Published values are rounded to the registry's decimals, so
    // the raw result value must be compared rounded too.
    const dec = metrics.find(m => m.metric_code === item.metric_code)?.decimals ?? 2;
    for (const entry of item.rollup.entries) {
      const source = item.results.find(r => r.status !== 'unavailable' && r.value != null && Number(r.value.toFixed(dec)) === entry.value);
      const before = current.get(gameId, entry.metric_key);
      upsert.run(gameId, entry.metric_key, entry.value, item.method, source ? source.id : null);
      if (!before || before.value !== entry.value) changes.push({ player_id: item.player_id, metric_key: entry.metric_key, from: before?.value ?? null, to: entry.value });
      published.push({ player_id: item.player_id, metric_key: entry.metric_key, value: entry.value, sample: item.rollup.sample });
      publishedKeys.add(`${item.player_id}:${entry.metric_key}`);
    }
  }
  // Corrections: adapter-owned entries (method set) for keys that no longer
  // release are removed — the evidence chain in cmd_metric_results is the
  // history. Manually entered admin stats (method NULL) are never touched.
  for (const [playerId, gameId] of gameIds) {
    for (const key of managedKeys) {
      if (publishedKeys.has(`${playerId}:${key}`)) continue;
      const gone = db.prepare('SELECT value FROM stat_entries WHERE game_id = ? AND metric_key = ? AND method IS NOT NULL').get(gameId, key);
      if (!gone) continue;
      db.prepare('DELETE FROM stat_entries WHERE game_id = ? AND metric_key = ? AND method IS NOT NULL').run(gameId, key);
      changes.push({ player_id: playerId, metric_key: key, from: gone.value, to: null });
    }
  }
  return { published, changes };
}

// Immediate correction: make games/stat_entries match what is *still*
// published for this job — now, not at the next release. Approved-but-
// unreleased results never leak through here; only the release moves them.
export function resyncPublishedRollups(db, jobId, actorId = null, reason = '') {
  const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobId);
  if (!job) return { changes: [] };
  if (db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id)?.synthetic) return { changes: [], synthetic: true };
  const touched = db.prepare("SELECT 1 FROM cmd_metric_results WHERE job_id = ? AND status = 'published' LIMIT 1").get(jobId)
    || db.prepare('SELECT 1 FROM games WHERE command_job_id = ? LIMIT 1').get(jobId);
  if (!touched) return { changes: [] };
  const { changes } = writeRollups(db, job, releasePlan(db, jobId, { publishedOnly: true }));
  if (changes.length) {
    const summary = changes.map(c => `${c.metric_key} ${c.from ?? '—'}→${c.to ?? 'removed'} (player ${c.player_id})`).join(', ');
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'published_rollups_resynced', ?, '', ?)"
    ).run(jobId, actorId ?? null, `${reason ? `${reason} — ` : ''}${summary}`.slice(0, 600), RELEASE_VERSION);
  }
  return { changes };
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
  // A synthetic (pipeline-test) job runs the whole release workflow — status,
  // published results, audit — but never touches a customer surface: no
  // games/stat_entries rows, so nothing appears on a player profile.
  const synthetic = !!db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id)?.synthetic;

  let published = [];
  const run = db.transaction(() => {
    if (synthetic) {
      published = plan.filter(item => item.rollup.released).flatMap(item =>
        item.rollup.entries.map(entry => ({ player_id: item.player_id, metric_key: entry.metric_key, value: entry.value, sample: item.rollup.sample, withheld: 'synthetic' }))
      );
    } else {
      ({ published } = writeRollups(db, job, { metrics, plan }));
    }
    // Contributing approved results are now published (synthetic too — the
    // workflow is real, only the customer surface is withheld).
    const publish = db.prepare("UPDATE cmd_metric_results SET status = 'published', updated_at = datetime('now') WHERE id = ? AND status = 'approved'");
    for (const item of plan) {
      if (!item.rollup.released) continue;
      for (const r of item.results) if (r.status === 'approved' && !r.published) publish.run(r.id);
    }
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_jobs', ?, ?, 'metrics_released', ?, '', ?)"
    ).run(jobId, actorId, `${published.length} entr${published.length === 1 ? 'y' : 'ies'} ${synthetic ? 'released but withheld from player profiles — synthetic job' : 'published'} (${RELEASE_VERSION})`, RELEASE_VERSION);
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
