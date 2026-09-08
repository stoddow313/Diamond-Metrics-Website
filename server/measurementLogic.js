// Frame-measurement domain logic (Command M4). Recipes: appendix
// Home-to-First, Steal Time, 90-Foot Speed. The analyst marks frames; the
// system computes, stores evidence, and maintains draft metric results.
export const MEASURE_VERSION = 'CMD_MEASURE_V1';
export const ATTEMPT_TYPES = ['home_to_first', 'steal'];
export const UNAVAILABLE_REASONS = [
  'base_not_visible', 'runner_or_ball_obscured', 'camera_stopped',
  'insufficient_frame_rate', 'no_valid_attempt', 'insufficient_capture_quality', 'other_with_note',
];

import { resultForEvidence, applyResultState, withdrawResult, markResultUnavailable, resyncPublishedRollups } from './releaseLogic.js';

const err = (message, status = 400) => Object.assign(new Error(message), { status });

// Frame time = frame index ÷ effective FPS of the measured rendition.
export function computeElapsed({ startFrame, endFrame, fps }) {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) throw err('start_frame and end_frame must be integers');
  if (startFrame < 0) throw err('start_frame cannot be negative');
  if (endFrame <= startFrame) throw err('end_frame must follow start_frame');
  if (!Number.isFinite(fps) || fps <= 0) throw err('fps must be positive');
  return (endFrame - startFrame) / fps;
}

// Appendix: 90 ÷ seconds × 0.681818 → mph (ft/s to mph).
export function ninetyFtSpeedMph(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return (90 / seconds) * 0.681818;
}

const METRIC_BY_ATTEMPT = { home_to_first: 'home_to_first', steal: 'steal_time' };

function requirementEnabled(db, jobId, metricCode) {
  return !!db.prepare(
    `SELECT 1 FROM cmd_metric_requirements r JOIN cmd_jobs j ON j.order_id = r.order_id
     WHERE j.id = ? AND r.metric_code = ? AND r.enabled = 1`
  ).get(jobId, metricCode);
}

export function createAttempt(db, jobId, { attempt_type, player_id, feed_id, base_path = '', outcome = '', timecode_s = null }, actorId) {
  if (!ATTEMPT_TYPES.includes(attempt_type)) throw err(`attempt_type must be ${ATTEMPT_TYPES.join(' or ')}`);
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(player_id)) throw err('Unknown player');
  const feed = feed_id ? db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ? AND job_id = ?').get(feed_id, jobId) : null;
  if (feed_id && !feed) throw err('feed_id must reference a feed on this job');
  if (!requirementEnabled(db, jobId, METRIC_BY_ATTEMPT[attempt_type])) {
    throw err(`The ${attempt_type.replace(/_/g, ' ')} module is not activated on this order`);
  }
  const seq = (db.prepare('SELECT MAX(sequence) m FROM cmd_events WHERE job_id = ?').get(jobId).m || 0) + 1;
  const id = db.prepare(
    `INSERT INTO cmd_events (job_id, sequence, event_type, player_id, payload, selected_feed_id, timecode_s, created_by)
     VALUES (?, ?, 'running_attempt', ?, ?, ?, ?, ?)`
  ).run(jobId, seq, player_id, JSON.stringify({ attempt_type, base_path, outcome }), feed_id ?? null, timecode_s, actorId).lastInsertRowid;
  db.prepare(
    "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_events', ?, ?, 'created', ?)"
  ).run(id, actorId, `${attempt_type} — player ${player_id}`);
  return db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(id);
}

// Keep the metric results mirroring an attempt's measurement: the timed
// metric itself, plus derived 90-ft speed for a valid home-to-first
// (appendix recipe, evidence = parent measurement). One measurement ↔ one
// result per metric, forever: a re-measure updates the same rows (back to
// draft when the value changed on a decided result), an unavailable mark
// turns the timed result unavailable with its reason and withdraws the
// derived one, and a later valid measurement revives them. The profile is
// resynced immediately so nothing withdrawn lingers on a player page.
function syncResults(db, event, measurement, actorId) {
  const payload = JSON.parse(event.payload);
  const code = METRIC_BY_ATTEMPT[payload.attempt_type];
  const wantDerived = payload.attempt_type === 'home_to_first' && requirementEnabled(db, event.job_id, 'ninety_ft_speed');
  const insert = db.prepare(
    `INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, unavailable_reason, evidence_kind, evidence_id, calculation_version, created_by)
     VALUES (?, ?, ?, ?, ?, 'frame_timed', ?, ?, 'measurement', ?, ?, ?)`
  );
  const ensure = (metricCode, unit, value, reason, reviveCap = null) => {
    const row = resultForEvidence(db, 'measurement', measurement.id, metricCode);
    if (!row) {
      return insert.run(event.job_id, metricCode, event.player_id, value, unit, 'draft', '', measurement.id, MEASURE_VERSION, actorId)
        && resultForEvidence(db, 'measurement', measurement.id, metricCode);
    }
    return applyResultState(db, row.id, { player_id: event.player_id, metric_code: metricCode, value, actorId, reason, reviveCap });
  };

  if (measurement.validity === 'valid') {
    const why = `attempt ${event.id} measured ${measurement.elapsed_s.toFixed(3)}s (frames ${measurement.start_frame}→${measurement.end_frame})`;
    const timed = ensure(code, 's', measurement.elapsed_s, why);
    const derived = resultForEvidence(db, 'measurement', measurement.id, 'ninety_ft_speed');
    // The derived speed rides its parent: it can revive, but never to a
    // higher review status than the timed result it is computed from.
    if (wantDerived) ensure('ninety_ft_speed', 'mph', ninetyFtSpeedMph(measurement.elapsed_s), `${why} — derived`, timed?.status || 'draft');
    else if (derived && derived.status !== 'withdrawn') withdrawResult(db, derived.id, { reason: '90-ft speed is not on this order', actorId });
  } else {
    const row = resultForEvidence(db, 'measurement', measurement.id, code);
    if (!row) {
      insert.run(event.job_id, code, event.player_id, null, 's', 'unavailable', measurement.unavailable_reason, measurement.id, MEASURE_VERSION, actorId);
    } else {
      markResultUnavailable(db, row.id, { reason: measurement.unavailable_reason, actorId, note: `attempt ${event.id} marked unavailable — ${measurement.unavailable_reason}${measurement.note ? `: ${measurement.note}` : ''}` });
    }
    const derived = resultForEvidence(db, 'measurement', measurement.id, 'ninety_ft_speed');
    if (derived && derived.status !== 'withdrawn') {
      withdrawResult(db, derived.id, { reason: `home-to-first marked unavailable (${measurement.unavailable_reason}) — nothing to derive from`, actorId });
    }
  }
  resyncPublishedRollups(db, event.job_id, actorId, `attempt ${event.id} ${measurement.validity === 'valid' ? 're-measured' : 'marked unavailable'}`);
}

export function saveMeasurement(db, eventId, { start_frame, end_frame, rendition_id }, actorId) {
  const event = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND event_type = 'running_attempt' AND status = 'active'").get(eventId);
  if (!event) throw err('Attempt not found', 404);

  let rendition = rendition_id
    ? db.prepare('SELECT * FROM cmd_media_renditions WHERE id = ?').get(rendition_id)
    : event.selected_feed_id
      ? db.prepare("SELECT * FROM cmd_media_renditions WHERE feed_id = ? AND kind = 'proxy' ORDER BY id DESC LIMIT 1").get(event.selected_feed_id)
      : null;
  if (!rendition) throw err('No proxy rendition to measure against — attach and process a feed first');
  const feed = db.prepare('SELECT * FROM cmd_video_feeds WHERE id = ?').get(rendition.feed_id);
  if (feed.status !== 'ready') throw err(`Feed is ${feed.status} — frame-timed measurement requires a ready CFR proxy`);
  const fps = rendition.fps || feed.effective_fps;
  if (!fps) throw err('Rendition has no FPS metadata');

  const elapsed = computeElapsed({ startFrame: start_frame, endFrame: end_frame, fps });

  const existing = db.prepare('SELECT id FROM cmd_measurements WHERE event_id = ?').get(eventId);
  const apply = db.transaction(() => {
    let measurementId;
    if (existing) {
      db.prepare(
        `UPDATE cmd_measurements SET rendition_id=?, start_frame=?, end_frame=?, fps_used=?, elapsed_s=?,
         formula_version=?, validity='valid', unavailable_reason='', updated_at=datetime('now') WHERE id=?`
      ).run(rendition.id, start_frame, end_frame, fps, elapsed, MEASURE_VERSION, existing.id);
      measurementId = existing.id;
    } else {
      measurementId = db.prepare(
        `INSERT INTO cmd_measurements (event_id, rendition_id, start_frame, end_frame, fps_used, elapsed_s, formula_version, validity, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?)`
      ).run(eventId, rendition.id, start_frame, end_frame, fps, elapsed, MEASURE_VERSION, actorId).lastInsertRowid;
    }
    const measurement = db.prepare('SELECT * FROM cmd_measurements WHERE id = ?').get(measurementId);
    syncResults(db, event, measurement, actorId);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, new_state) VALUES ('cmd_events', ?, ?, ?, ?, ?)"
    ).run(eventId, actorId, existing ? 'remeasured' : 'measured', `frames ${start_frame}→${end_frame} @ ${fps.toFixed(2)} fps`, elapsed.toFixed(3) + 's');
    return measurement;
  });
  return apply();
}

// Post-game reassignment (roadmap §4.2): the runner on an attempt turns out
// to be someone else — a courtesy runner, a guest identified afterwards, a
// misread jersey. The attempt keeps its evidence; its results follow the new
// player on the same rows (decided results go back to review) and the
// profile is resynced at once.
export function reassignAttempt(db, eventId, { player_id }, actorId) {
  const event = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND event_type = 'running_attempt' AND status = 'active'").get(eventId);
  if (!event) throw err('Attempt not found', 404);
  const playerId = Number(player_id);
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(playerId)) throw err('Unknown player');
  if (event.player_id === playerId) return event;
  const apply = db.transaction(() => {
    db.prepare('UPDATE cmd_events SET player_id = ? WHERE id = ?').run(playerId, eventId);
    const measurement = db.prepare('SELECT * FROM cmd_measurements WHERE event_id = ?').get(eventId);
    if (measurement) {
      const rows = db.prepare(
        "SELECT * FROM cmd_metric_results WHERE evidence_kind = 'measurement' AND evidence_id = ? AND superseded_by IS NULL"
      ).all(measurement.id);
      for (const r of rows) {
        if (r.status === 'withdrawn' || r.status === 'unavailable') {
          // Nothing releasable to re-review; the row simply follows the runner.
          db.prepare("UPDATE cmd_metric_results SET player_id = ?, updated_at = datetime('now') WHERE id = ?").run(playerId, r.id);
        } else {
          applyResultState(db, r.id, { player_id: playerId, metric_code: r.metric_code, value: r.value, actorId, reason: `attempt ${eventId} reassigned from player ${event.player_id} to ${playerId}` });
        }
      }
    }
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_events', ?, ?, 'reassigned', ?, ?, ?)"
    ).run(eventId, actorId, 'runner reassigned', String(event.player_id), String(playerId));
    resyncPublishedRollups(db, event.job_id, actorId, `attempt ${eventId} reassigned`);
  });
  apply();
  return db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(eventId);
}

export function markUnavailable(db, eventId, { reason, note = '' }, actorId) {
  const event = db.prepare("SELECT * FROM cmd_events WHERE id = ? AND event_type = 'running_attempt' AND status = 'active'").get(eventId);
  if (!event) throw err('Attempt not found', 404);
  if (!UNAVAILABLE_REASONS.includes(reason)) throw err(`reason must be one of: ${UNAVAILABLE_REASONS.join(', ')}`);
  if (reason === 'other_with_note' && !String(note).trim()) throw err('other_with_note requires a note');

  const existing = db.prepare('SELECT id FROM cmd_measurements WHERE event_id = ?').get(eventId);
  const apply = db.transaction(() => {
    let measurementId;
    if (existing) {
      db.prepare(
        `UPDATE cmd_measurements SET validity='unavailable', unavailable_reason=?, note=?, elapsed_s=NULL,
         start_frame=NULL, end_frame=NULL, formula_version=?, updated_at=datetime('now') WHERE id=?`
      ).run(reason, String(note), MEASURE_VERSION, existing.id);
      measurementId = existing.id;
    } else {
      measurementId = db.prepare(
        `INSERT INTO cmd_measurements (event_id, formula_version, validity, unavailable_reason, note, created_by)
         VALUES (?, ?, 'unavailable', ?, ?, ?)`
      ).run(eventId, MEASURE_VERSION, reason, String(note), actorId).lastInsertRowid;
    }
    const measurement = db.prepare('SELECT * FROM cmd_measurements WHERE id = ?').get(measurementId);
    syncResults(db, event, measurement, actorId);
    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, new_state) VALUES ('cmd_events', ?, ?, 'marked_unavailable', ?, ?)"
    ).run(eventId, actorId, String(note), reason);
    return measurement;
  });
  return apply();
}
