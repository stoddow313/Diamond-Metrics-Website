// Diamond Metrics Command — M1 routes (jobs, orders, queue). Mounted from
// index.js with shared db + auth middleware. Every state change writes a
// cmd_review_actions row; creation flows are transactional.
import { PACKAGES, buildRequirements, canTransition, roleCanTransition, METRIC_RELEASE_STATES, GAME_RECORD_STATES, orderablePackages, SHARING_SCOPES_V1, assertRequirementToggle } from './commandLogic.js';
import { addJobGuest } from './commandRoster.js';
import { validateGameRecordSource, releaseGameRecord, gameRecordPlan } from './gameRecord.js';
import { emitJobEvent } from './notifications.js';
import { computeQaFlags, releaseMetrics, resyncPublishedRollups } from './releaseLogic.js';

export function mountCommandRoutes(app, { db, requireInternal }) {
  const audit = (targetTable, targetId, actorId, action, { note = '', prev = '', next = '' } = {}) =>
    db.prepare(
      'INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(targetTable, targetId, actorId, action, note, prev, next);

  const registryRows = () => db.prepare('SELECT * FROM cmd_metric_registry ORDER BY category, metric_code').all()
    .map(r => ({ ...r, publishes_to: JSON.parse(r.publishes_to), dependencies: JSON.parse(r.dependencies) }));

  app.get('/api/command/bootstrap', requireInternal, (_req, res) => {
    res.json({
      registry: registryRows(),
      packages: Object.entries(PACKAGES).map(([key, p]) => ({
        key, label: p.label, metric_codes: p.metric_codes, allows_addons: !!p.allows_addons,
        orderable: orderablePackages().includes(key), unavailable_reason: p.unavailable_reason || null,
      })),
      sharing_scopes: SHARING_SCOPES_V1,
      capture_profiles: db.prepare('SELECT * FROM cmd_capture_profiles ORDER BY id').all()
        .map(p => ({ ...p, expected_metrics: JSON.parse(p.expected_metrics) })),
      analysts: db.prepare('SELECT id, email, name, role FROM admins ORDER BY name').all(),
      teams: db.prepare(
        'SELECT t.id, t.name, t.age_group, o.name AS organization_name FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.active = 1 ORDER BY t.name'
      ).all(),
      tournaments: db.prepare('SELECT id, name, slug, start_date, end_date FROM tournaments WHERE archived = 0 ORDER BY start_date DESC').all(),
      tournament_games: db.prepare(
        `SELECT tg.id, tg.tournament_id, tg.game_date, tg.game_time, ht.name AS home_team_name, at.name AS away_team_name,
                he.team_id AS home_team_id, ae.team_id AS away_team_id
         FROM tournament_games tg
         JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
         JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
         ORDER BY tg.game_date DESC`
      ).all(),
      rulesets: db.prepare('SELECT r.*, s.key AS sport_key FROM rulesets r JOIN sports s ON s.id = r.sport_id').all(),
      states: { metric_release: METRIC_RELEASE_STATES, game_record: GAME_RECORD_STATES },
    });
  });

  // One-shot job creation: order + requirements + job + consent, transactionally.
  const jobListSql = `
    SELECT j.*, t.name AS team_name, o.package_key, o.label AS order_label, o.synthetic,
           a.name AS assigned_name, tr.name AS tournament_name,
           (SELECT COUNT(*) FROM cmd_metric_requirements r WHERE r.order_id = j.order_id AND r.enabled = 1) AS requirement_count,
           o.contact_email, c.media_consent, c.sharing_scope
    FROM cmd_jobs j
    JOIN teams t ON t.id = j.team_id
    JOIN cmd_orders o ON o.id = j.order_id
    LEFT JOIN admins a ON a.id = j.assigned_to
    LEFT JOIN tournaments tr ON tr.id = j.tournament_id
    LEFT JOIN cmd_consent c ON c.job_id = j.id`;

  app.get('/api/command/jobs', requireInternal, (req, res) => {
    const clauses = [], params = [];
    if (req.query.status) { clauses.push('j.metric_release_status = ?'); params.push(req.query.status); }
    if (req.query.analyst) { clauses.push('j.assigned_to = ?'); params.push(req.query.analyst); }
    if (req.query.team) { clauses.push('j.team_id = ?'); params.push(req.query.team); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`${jobListSql}${where} ORDER BY j.created_at DESC`).all(...params);
    res.json({ jobs: rows });
  });

  function jobDetail(id) {
    const job = db.prepare(`${jobListSql} WHERE j.id = ?`).get(id);
    if (!job) return null;
    const requirements = db.prepare(
      `SELECT r.*, m.label, m.category, m.availability_tier, m.method, m.unit, m.recipe_version, m.capture_requirements
       FROM cmd_metric_requirements r JOIN cmd_metric_registry m ON m.metric_code = r.metric_code
       WHERE r.order_id = ? ORDER BY r.priority, r.metric_code`
    ).all(job.order_id);
    // The job's audit history is everything decided under it: job status
    // changes, plus reading classifications (with the invalid reason),
    // result withdrawals/revivals, and measurement actions.
    const auditTrail = db.prepare(
      `SELECT * FROM (
         SELECT ra.*, a.name AS actor_name, 'job' AS scope, NULL AS subject
           FROM cmd_review_actions ra LEFT JOIN admins a ON a.id = ra.actor_id
          WHERE ra.target_table = 'cmd_jobs' AND ra.target_id = ?
         UNION ALL
         SELECT ra.*, a.name AS actor_name, 'reading' AS scope, (rr.velocity || ' mph') AS subject
           FROM cmd_review_actions ra JOIN cmd_radar_readings rr ON rr.id = ra.target_id LEFT JOIN admins a ON a.id = ra.actor_id
          WHERE ra.target_table = 'cmd_radar_readings' AND rr.job_id = ?
         UNION ALL
         SELECT ra.*, a.name AS actor_name, 'result' AS scope, (r.metric_code || ' ' || COALESCE(r.value, '—')) AS subject
           FROM cmd_review_actions ra JOIN cmd_metric_results r ON r.id = ra.target_id LEFT JOIN admins a ON a.id = ra.actor_id
          WHERE ra.target_table = 'cmd_metric_results' AND r.job_id = ?
         UNION ALL
         SELECT ra.*, a.name AS actor_name, CASE WHEN e.event_type IN ('lineup','half_inning','plate_appearance','pitch','runner','substitution','game_final') THEN 'scorebook' ELSE 'attempt' END AS scope, e.event_type AS subject
           FROM cmd_review_actions ra JOIN cmd_events e ON e.id = ra.target_id LEFT JOIN admins a ON a.id = ra.actor_id
          WHERE ra.target_table = 'cmd_events' AND e.job_id = ?
       ) ORDER BY id DESC LIMIT 300`
    ).all(id, id, id, id);
    const notifications = db.prepare(
      'SELECT id, event_key, audience, email_status, created_at FROM cmd_notifications WHERE job_id = ? ORDER BY id DESC'
    ).all(id);
    const gameRecordSources = db.prepare(
      `SELECT g.*, a.name AS created_by_name FROM cmd_game_record_sources g LEFT JOIN admins a ON a.id = g.created_by
       WHERE g.job_id = ? ORDER BY g.id DESC`
    ).all(id).map(g => {
      let report = null;
      try { report = g.parsed_report ? JSON.parse(g.parsed_report) : null; } catch { report = null; }
      const { parsed_report: _pr, resolutions: _rs, ...rest } = g;
      return { ...rest, report, has_content: g.source_kind === 'live_internal' || !!(g.raw_import && String(g.raw_import).trim()) };   // the live scorebook's content is the event log
    });
    const gameResult = db.prepare('SELECT * FROM cmd_game_results WHERE job_id = ?').get(id) || null;
    return { ...job, requirements, audit: auditTrail, notifications, game_record_sources: gameRecordSources, game_result: gameResult ? { ...gameResult, line_score: JSON.parse(gameResult.line_score || '{}'), team: JSON.parse(gameResult.team || '{}') } : null };
  }

  app.get('/api/command/jobs/:id', requireInternal, (req, res) => {
    const detail = jobDetail(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: detail });
  });

  app.put('/api/command/jobs/:id', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    const updates = [];
    if ('assigned_to' in b) {
      if (b.assigned_to && !db.prepare('SELECT 1 FROM admins WHERE id = ?').get(b.assigned_to)) {
        return res.status(400).json({ error: 'assigned_to must reference an internal account' });
      }
      updates.push(['assigned_to', b.assigned_to ?? null, 'assigned']);
    }
    if ('blocker_reason' in b) updates.push(['blocker_reason', String(b.blocker_reason || ''), 'blocked']);
    if ('due_date' in b) updates.push(['due_date', b.due_date || null, 'due_date_changed']);
    // The synthetic flag lives on the order and must be settable after the
    // fact: test jobs already exist, and a flag you cannot apply to them
    // does not isolate anything.
    const settingSynthetic = 'synthetic' in b;
    if (!updates.length && !settingSynthetic) return res.status(400).json({ error: 'No supported fields to update' });
    const apply = db.transaction(() => {
      for (const [col, value, action] of updates) {
        const prev = job[col];
        db.prepare(`UPDATE cmd_jobs SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, job.id);
        audit('cmd_jobs', job.id, req.internal.id, action, { prev: String(prev ?? ''), next: String(value ?? '') });
      }
      if (settingSynthetic) {
        const next = b.synthetic ? 1 : 0;
        const prev = db.prepare('SELECT synthetic FROM cmd_orders WHERE id = ?').get(job.order_id)?.synthetic ?? 0;
        db.prepare('UPDATE cmd_orders SET synthetic = ? WHERE id = ?').run(next, job.order_id);
        audit('cmd_jobs', job.id, req.internal.id, next ? 'marked_synthetic' : 'unmarked_synthetic',
          { prev: String(prev), next: String(next) });
        // Profiles follow the flag at once: a job flagged synthetic after it
        // released loses its published values; unflagging republishes them.
        if (next !== prev) resyncPublishedRollups(db, job.id, req.internal.id, next ? 'marked synthetic' : 'unmarked synthetic');
      }
    });
    apply();
    res.json({ job: jobDetail(job.id) });
  });

  // Two-release status transitions with role gates.
  // Job creation, shared by the single-job route and bulk tournament
  // creation (M6). Throws {status, message} on validation failure so both
  // callers surface the same errors.
  const createJob = (b, actorId) => {
    const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
    const teamRow = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(b.team_id);
    if (!teamRow) fail('team_id must reference an existing team');
    if (!b.game_date) fail('game_date is required');
    if (b.assigned_to && !db.prepare('SELECT 1 FROM admins WHERE id = ?').get(b.assigned_to)) {
      fail('assigned_to must reference an internal account');
    }
    let tournamentId = b.tournament_id ?? null;
    if (b.tournament_game_id) {
      const tg = db.prepare('SELECT id, tournament_id FROM tournament_games WHERE id = ?').get(b.tournament_game_id);
      if (!tg) fail('tournament_game_id not found');
      tournamentId = tg.tournament_id;
    }

    // Rookie V1 gate: only packages whose modules exist can be ordered, and
    // only sharing scopes with a working consumer. Hidden in the forms too,
    // but the API is the contract — bulk creation and scripts hit this path.
    const pkg = PACKAGES[b.package_key];
    if (!pkg) fail(`Unknown package: ${b.package_key}`);
    if (!orderablePackages().includes(b.package_key)) {
      fail(`${pkg.label} is not orderable in Rookie V1 — ${pkg.unavailable_reason || 'its modules have not shipped'}. Order Rookie instead.`);
    }
    if (b.sharing_scope && !SHARING_SCOPES_V1.includes(b.sharing_scope)) {
      fail(`Sharing scope "${b.sharing_scope}" is not available in Rookie V1 — use internal or customer`);
    }

    let requirements;
    try {
      requirements = buildRequirements({
        packageKey: b.package_key,
        addonCodes: Array.isArray(b.addon_codes) ? b.addon_codes : [],
        registry: registryRows(),
      });
    } catch (err) {
      fail(err.message);
    }

    const baseball = db.prepare("SELECT id FROM sports WHERE key = 'baseball'").get().id;
    const ruleset = db.prepare("SELECT id FROM rulesets WHERE key = 'baseball_default'").get();

    const orderId = db.prepare('INSERT INTO cmd_orders (package_key, label, notes, contact_email, synthetic, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.package_key, PACKAGES[b.package_key].label, String(b.notes || ''), String(b.contact_email || '').toLowerCase().trim(), b.synthetic ? 1 : 0, actorId).lastInsertRowid;
    const insReq = db.prepare(
      'INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of requirements) insReq.run(orderId, r.metric_code, r.priority, r.capture_requirement, r.enabled);

    const jobId = db.prepare(
      `INSERT INTO cmd_jobs (sport_id, ruleset_id, team_id, opponent_label, tournament_id, tournament_game_id,
                             event_label, game_date, game_type, order_id, assigned_to, due_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(baseball, ruleset?.id ?? null, teamRow.id, String(b.opponent_label || ''), tournamentId, b.tournament_game_id ?? null,
      String(b.event_label || ''), b.game_date, b.game_type === 'pro_day' ? 'pro_day' : 'game',
      orderId, b.assigned_to ?? null, b.due_date || null, actorId).lastInsertRowid;

    db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, ?, ?, ?)')
      .run(jobId, b.media_consent ? 1 : 0, ['internal', 'customer', 'public'].includes(b.sharing_scope) ? b.sharing_scope : 'internal', actorId);

    audit('cmd_jobs', jobId, actorId, 'created', { note: `${PACKAGES[b.package_key].label} · ${teamRow.name} · ${b.game_date}` });
    if (b.assigned_to) audit('cmd_jobs', jobId, actorId, 'assigned', { next: String(b.assigned_to) });
    return jobId;
  };

  app.post('/api/command/jobs', requireInternal, (req, res) => {
    try {
      const jobId = db.transaction(() => createJob(req.body || {}, req.internal.id))();
      res.status(201).json({ job: jobDetail(jobId) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : `Job creation failed: ${err.message}` });
    }
  });

  app.post('/api/command/jobs/:id/status', requireInternal, (req, res) => {
    const job = db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { kind, to, note = '' } = req.body || {};
    if (!['metric_release', 'game_record'].includes(kind)) return res.status(400).json({ error: "kind must be 'metric_release' or 'game_record'" });
    const col = kind === 'metric_release' ? 'metric_release_status' : 'game_record_status';
    const from = job[col];
    if (!canTransition(kind, from, to)) {
      return res.status(400).json({ error: `Invalid ${kind} transition: ${from} → ${to}` });
    }
    if (!roleCanTransition(req.internal.role, kind, to)) {
      return res.status(403).json({ error: `Role '${req.internal.role}' cannot move ${kind} to '${to}' — reviewer or admin required` });
    }
    // Capture-readiness gate (M5): blocking QA flags stop approval.
    if (kind === 'metric_release' && to === 'approved') {
      const blocking = computeQaFlags(db, job.id).filter(f => f.level === 'blocking');
      if (blocking.length > 0) {
        return res.status(409).json({ error: `Cannot approve: ${blocking.map(f => f.label).join('; ')}`, qa_flags: blocking });
      }
    }
    // The release adapter runs inside the released transition — approved
    // rollups publish to games/stat_entries before the customer is notified.
    // Game-record track: 'validated' needs a validated source; 'released'
    // publishes box-score statistics through the game-record adapter.
    if (kind === 'game_record' && to === 'validated') {
      const validated = db.prepare("SELECT 1 FROM cmd_game_record_sources WHERE job_id = ? AND validation_status = 'validated'").get(job.id);
      if (!validated) return res.status(400).json({ error: 'Validate a game-record source (GameChanger export or manual box score) before marking the record validated' });
    }
    let release = null;
    if (kind === 'metric_release' && to === 'released') {
      release = releaseMetrics(db, job.id, req.internal.id);
    }
    if (kind === 'game_record' && to === 'released') {
      try { release = releaseGameRecord(db, job.id, req.internal.id); }
      catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    }
    db.prepare(`UPDATE cmd_jobs SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(to, job.id);
    audit('cmd_jobs', job.id, req.internal.id, 'status_changed', { note: `${kind}${note ? ` — ${note}` : ''}`, prev: from, next: to });

    // Customer notification events (TDR §3): auditable rows; email rides the adapter.
    if (kind === 'metric_release' && to === 'in_progress' && from === 'not_started') {
      emitJobEvent(db, { jobId: job.id, eventKey: 'review_started' });
    }
    if (kind === 'metric_release' && to === 'released') {
      emitJobEvent(db, { jobId: job.id, eventKey: 'metrics_ready' });
      if (!['released', 'not_ordered'].includes(job.game_record_status)) {
        emitJobEvent(db, { jobId: job.id, eventKey: 'full_review_pending' });
      }
    }
    if (kind === 'game_record' && to === 'released') {
      emitJobEvent(db, { jobId: job.id, eventKey: 'full_review_complete' });
    }
    res.json({ job: jobDetail(job.id), release });
  });

  // GameChanger scorecard / manual game-record sources: non-blocking for
  // Rookie; raw import preserved, pending validation (box score completes later).
  app.post('/api/command/jobs/:id/game-record-sources', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const b = req.body || {};
    if (!['gamechanger_export', 'live_internal', 'postgame_manual'].includes(b.source_kind)) {
      return res.status(400).json({ error: 'source_kind must be gamechanger_export, live_internal, or postgame_manual' });
    }
    const info = db.prepare(
      'INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(job.id, b.source_kind, String(b.label || ''), typeof b.raw_import === 'string' ? b.raw_import : JSON.stringify(b.raw_import || ''), String(b.note || ''), req.internal.id);
    audit('cmd_jobs', job.id, req.internal.id, 'game_record_source_attached', { note: `${b.source_kind}${b.label ? ` — ${b.label}` : ''}` });
    res.status(201).json({ job: jobDetail(job.id), source_id: info.lastInsertRowid });
  });

  // Guest / unknown-player placeholder for one job (roadmap §4.2). Never a
  // guessed permanent match: the placeholder is reassigned to the identified
  // player after the game, or stays a non-public guest.
  app.post('/api/command/jobs/:id/guests', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      res.status(201).json({ player: addJobGuest(db, job.id, req.body || {}, req.internal.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Tournament footage triage (roadmap §4.2 bulk triage): every job for a
  // tournament with its feeds, so missing or failed footage is visible in one
  // place before analysts start, without creating any new entities.
  app.get('/api/command/tournaments/:id/footage', requireInternal, (req, res) => {
    const tournament = db.prepare('SELECT id, name, start_date, end_date FROM tournaments WHERE id = ?').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    const jobs = db.prepare(`${jobListSql} WHERE j.tournament_id = ? ORDER BY j.game_date, j.id`).all(tournament.id);
    const feeds = db.prepare(
      `SELECT f.job_id, f.id, f.label, f.original_name, f.status, f.error, f.height, f.effective_fps
         FROM cmd_video_feeds f JOIN cmd_jobs j ON j.id = f.job_id
        WHERE j.tournament_id = ? ORDER BY f.id`
    ).all(tournament.id);
    const byJob = new Map();
    for (const f of feeds) { if (!byJob.has(f.job_id)) byJob.set(f.job_id, []); byJob.get(f.job_id).push(f); }
    const rows = jobs.map(j => {
      const fs = byJob.get(j.id) || [];
      const ready = fs.filter(f => f.status === 'ready').length;
      const failed = fs.filter(f => ['failed', 'retrying'].includes(f.status)).length;
      const processing = fs.filter(f => ['uploading', 'queued', 'processing'].includes(f.status)).length;
      const flag = fs.length === 0 ? 'missing_footage' : (ready === 0 && failed > 0 ? 'failed_footage' : ready === 0 ? 'processing' : null);
      return {
        job_id: j.id, team_name: j.team_name, opponent_label: j.opponent_label, game_date: j.game_date,
        assigned_to: j.assigned_to, assigned_name: j.assigned_name, synthetic: j.synthetic,
        metric_release_status: j.metric_release_status, game_record_status: j.game_record_status,
        feeds: fs, ready, failed, processing, flag,
      };
    });
    res.json({
      tournament,
      jobs: rows,
      totals: {
        jobs: rows.length,
        missing_footage: rows.filter(r => r.flag === 'missing_footage').length,
        failed_footage: rows.filter(r => r.flag === 'failed_footage').length,
        processing: rows.filter(r => r.flag === 'processing').length,
        ready: rows.filter(r => r.ready > 0).length,
        unassigned: rows.filter(r => !r.assigned_to).length,
      },
    });
  });

  // Validate a game-record source: parse, resolve rows to the roster, apply
  // the analyst's resolutions { "batting:12": playerId | null }, report gaps.
  app.post('/api/command/game-record-sources/:id/validate', requireInternal, (req, res) => {
    try {
      const out = validateGameRecordSource(db, Number(req.params.id), { resolutions: req.body?.resolutions || {} }, req.internal.id);
      const source = db.prepare('SELECT job_id FROM cmd_game_record_sources WHERE id = ?').get(req.params.id);
      res.json({ ...out, job: jobDetail(source.job_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // What the game-record release would publish right now.
  app.get('/api/command/jobs/:id/game-record', requireInternal, (req, res) => {
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const plan = gameRecordPlan(db, job.id);
    const names = plan.players.length
      ? new Map(db.prepare(`SELECT id, first_name, last_name FROM players WHERE id IN (${plan.players.map(() => '?').join(',')})`).all(...plan.players.map(p => p.player_id)).map(p => [p.id, `${p.first_name} ${p.last_name}`]))
      : new Map();
    res.json({
      sources: plan.sources.map(s => ({ id: s.id, source_kind: s.source_kind, label: s.label, validation_status: s.validation_status, validated_at: s.validated_at })),
      players: plan.players.map(p => ({ ...p, name: names.get(p.player_id) || `player ${p.player_id}` })),
    });
  });

  app.put('/api/command/requirements/:id', requireInternal, (req, res) => {
    const row = db.prepare('SELECT * FROM cmd_metric_requirements WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Requirement not found' });
    const enabled = req.body?.enabled ? 1 : 0;
    try { assertRequirementToggle(db, row, enabled); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    db.prepare('UPDATE cmd_metric_requirements SET enabled = ? WHERE id = ?').run(enabled, row.id);
    const job = db.prepare('SELECT id FROM cmd_jobs WHERE order_id = ?').get(row.order_id);
    if (job) audit('cmd_jobs', job.id, req.internal.id, 'requirement_toggled', { note: row.metric_code, prev: String(row.enabled), next: String(enabled) });
    res.json({ ok: true });
  });

  // Shared with the ops routes (bulk tournament job creation).
  return { createJob, jobDetail };
}
