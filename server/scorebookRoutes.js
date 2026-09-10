// Phase 2 scorebook routes. Everything reads back the replayed state so the
// client never keeps its own copy of the truth.
import { replayJob, appendEvent, appendPlateAppearance, correctEvent, voidEvent, disputeEvent, resolveEvent, rulesetFor, refreshLiveSource,
         EVENT_TYPES, PA_RESULTS, PITCH_RESULTS, RUNNER_HOWS, SUB_KINDS, FINAL_REASONS, BATTED_BALLS, DIRECTIONS, POSITION_NUMBERS, setEventClip, setStartingPitcher } from './scorebook.js';
import { PITCH_TYPES } from './radarImport.js';
import { requirementEnabled, METRIC_BY_ATTEMPT } from './measurementLogic.js';
import { commandRoster } from './commandRoster.js';

export function mountScorebookRoutes(app, { db, requireInternal }) {
  const payloadFor = (jobId, rp) => {
    const job = rp.job;
    const source = db.prepare("SELECT id, validation_status, validated_at FROM cmd_game_record_sources WHERE job_id = ? AND source_kind = 'live_internal' ORDER BY id LIMIT 1").get(jobId) || null;
    return {
      job: { id: job.id, game_date: job.game_date, opponent_label: job.opponent_label, game_record_status: job.game_record_status, metric_release_status: job.metric_release_status, regulation_innings: job.regulation_innings },
      ruleset: rulesetFor(db, job),
      roster: commandRoster(db, job),
      source,
      feeds: db.prepare('SELECT id, label, status, effective_fps, nominal_fps, width, height, duration_s FROM cmd_video_feeds WHERE job_id = ? ORDER BY id').all(jobId),
      // Internal metrics the scorer can attach to plays (PRD §5.1 "when known"): radar readings to pitches,
      // timing attempts to runners/batters — only for modules this order activated.
      radar_readings: db.prepare("SELECT id, velocity, unit, source_timestamp, row_index, status, player_id, pitch_type, pitch_or_exit FROM cmd_radar_readings WHERE job_id = ? AND status != 'invalid' ORDER BY row_index, id").all(jobId),
      pitch_types: PITCH_TYPES,
      modules: { radar: requirementEnabled(db, jobId, 'pitch_velocity_radar'), home_to_first: requirementEnabled(db, jobId, METRIC_BY_ATTEMPT.home_to_first), steal: requirementEnabled(db, jobId, METRIC_BY_ATTEMPT.steal) },
      vocab: { event_types: EVENT_TYPES, pa_results: PA_RESULTS, pitch_results: PITCH_RESULTS, runner_hows: RUNNER_HOWS, sub_kinds: SUB_KINDS, final_reasons: FINAL_REASONS, batted_balls: BATTED_BALLS, directions: DIRECTIONS, position_numbers: POSITION_NUMBERS },
      version: rp.version, state: rp.state, tallies: rp.tallies, issues: rp.issues, log: rp.log,
      events: rp.events.map(e => ({ id: e.id, sequence: e.sequence, event_type: e.event_type, parent_event_id: e.parent_event_id, status: e.status, payload: e.payload })),
    };
  };
  const handle = (res, fn) => { try { fn(); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

  app.get('/api/command/jobs/:id/scorebook', requireInternal, (req, res) => handle(res, () => {
    res.json(payloadFor(Number(req.params.id), replayJob(db, Number(req.params.id))));
  }));

  app.post('/api/command/jobs/:id/scorebook/events', requireInternal, (req, res) => handle(res, () => {
    const rp = appendEvent(db, Number(req.params.id), req.body || {}, req.internal.id);
    res.status(201).json({ event: rp.event, ...payloadFor(Number(req.params.id), rp) });
  }));

  app.post('/api/command/jobs/:id/scorebook/plate-appearance', requireInternal, (req, res) => handle(res, () => {
    const rp = appendPlateAppearance(db, Number(req.params.id), req.body || {}, req.internal.id);
    res.status(201).json({ event_id: rp.event_id, ...payloadFor(Number(req.params.id), rp) });
  }));

  app.put('/api/command/scorebook/events/:id', requireInternal, (req, res) => handle(res, () => {
    const rp = correctEvent(db, Number(req.params.id), { payload: req.body?.payload || {} }, req.internal.id, req.body?.note || '');
    res.json({ event_id: rp.event_id, superseded_id: rp.superseded_id, ...payloadFor(rp.job.id, rp) });
  }));

  app.post('/api/command/scorebook/events/:id/void', requireInternal, (req, res) => handle(res, () => {
    const rp = voidEvent(db, Number(req.params.id), req.internal.id, req.body?.note || '');
    res.json(payloadFor(rp.job.id, rp));
  }));

  app.post('/api/command/scorebook/events/:id/dispute', requireInternal, (req, res) => handle(res, () => {
    const rp = disputeEvent(db, Number(req.params.id), { note: req.body?.note || '' }, req.internal.id);
    res.json(payloadFor(rp.job.id, rp));
  }));

  app.post('/api/command/scorebook/events/:id/resolve', requireInternal, (req, res) => handle(res, () => {
    const rp = resolveEvent(db, Number(req.params.id), { note: req.body?.note || '' }, req.internal.id);
    res.json(payloadFor(rp.job.id, rp));
  }));

  // Recompute the live game-record source on demand (also happens after every event).
  app.post('/api/command/jobs/:id/scorebook/refresh', requireInternal, (req, res) => handle(res, () => {
    res.json(refreshLiveSource(db, Number(req.params.id), req.internal.id));
  }));

  // Footage link: feed, moment and clip bounds for a tagged play.
  app.put('/api/command/scorebook/events/:id/clip', requireInternal, (req, res) => {
    try { res.json(setEventClip(db, Number(req.params.id), req.body || {}, req.internal.id)); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // Our starting pitcher, after the fact (retroactive on replay) — or an audited unknown-pitcher exception.
  app.post('/api/command/jobs/:id/scorebook/starting-pitcher', requireInternal, (req, res) => {
    try { res.json(setStartingPitcher(db, Number(req.params.id), req.body || {}, req.internal.id)); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
}
