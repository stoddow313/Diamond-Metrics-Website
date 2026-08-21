// Command M6: operations surface — pipeline telemetry, service health,
// backup control, and bulk tournament job creation. Read access is
// internal; anything that mutates infrastructure (manual backup) is admin.
import { pipelineTelemetry } from './telemetry.js';
import { lastBackup, runBackup, RETENTION_DAYS } from './backup.js';
import { storageMode, selfTest, storageReady, missingStorageConfig } from './storage.js';
import { ENV, errorTrackingEnabled } from './observability.js';
import { emailConfigured } from './notifications.js';

export function mountCommandOpsRoutes(app, { db, requireInternal, createJob }) {
  const requireAdminRole = (req, res, next) => requireInternal(req, res, () => {
    if (req.internal.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    next();
  });

  app.get('/api/command/telemetry', requireInternal, (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json(pipelineTelemetry(db, { sinceDays: days }));
  });

  // Service health at a glance: what the pilot operator needs to know
  // before trusting the queue on a Saturday morning.
  app.get('/api/command/ops', requireInternal, (_req, res) => {
    const mediaQueue = db.prepare(
      "SELECT status, COUNT(*) n FROM cmd_media_jobs GROUP BY status"
    ).all().reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
    const stuckFeeds = db.prepare(
      "SELECT COUNT(*) n FROM cmd_video_feeds WHERE status IN ('failed', 'retrying')"
    ).get().n;
    const pendingEmail = db.prepare(
      "SELECT COUNT(*) n FROM cmd_notifications WHERE email_status IN ('queued', 'failed')"
    ).get().n;
    res.json({
      environment: ENV,
      storage_mode: storageMode,
      storage_ready: storageReady,
      storage_missing_config: missingStorageConfig,
      worker_mode: process.env.DM_INLINE_WORKER === '0' ? 'dedicated' : 'inline',
      error_tracking: errorTrackingEnabled,
      email_configured: emailConfigured(),
      backups: {
        enabled: process.env.DM_BACKUPS !== '0',
        retention_days: RETENTION_DAYS,
        last: lastBackup(db),
      },
      media_queue: { ...mediaQueue, stuck_feeds: stuckFeeds },
      notifications: { pending_email: pendingEmail },
    });
  });

  // Proves the configured media backend works end to end — run this right
  // after wiring R2, before anyone uploads a real game file.
  app.post('/api/command/storage/check', requireAdminRole, async (_req, res) => {
    res.json({ check: await selfTest() });
  });

  app.post('/api/command/backups/run', requireAdminRole, async (_req, res) => {
    try {
      res.json({ backup: await runBackup(db) });
    } catch (err) {
      res.status(500).json({ error: `Backup failed: ${err.message}` });
    }
  });

  // ── Bulk tournament job creation ────────────────────────────────────────
  // One job per (game × participating team) so each customer team gets its
  // own order, requirements, and release track. Existing jobs are skipped,
  // which makes the endpoint safe to re-run as a schedule fills in.
  app.post('/api/command/jobs/bulk', requireInternal, (req, res) => {
    const b = req.body || {};
    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(b.tournament_id);
    if (!tournament) return res.status(400).json({ error: 'tournament_id must reference an existing tournament' });

    const games = db.prepare(
      `SELECT tg.id, tg.game_date, tg.status,
              he.team_id AS home_team_id, ht.name AS home_team_name,
              ae.team_id AS away_team_id, at.name AS away_team_name
         FROM tournament_games tg
         JOIN tournament_entries he ON he.id = tg.home_entry_id
         JOIN tournament_entries ae ON ae.id = tg.away_entry_id
         JOIN teams ht ON ht.id = he.team_id
         JOIN teams at ON at.id = ae.team_id
        WHERE tg.tournament_id = ? AND tg.status != 'canceled'
        ORDER BY tg.game_date, tg.game_time, tg.id`
    ).all(tournament.id);

    // Optional scope: only these teams get jobs (the paying customers).
    const scope = Array.isArray(b.team_ids) && b.team_ids.length ? new Set(b.team_ids.map(Number)) : null;
    const existing = new Set(
      db.prepare('SELECT tournament_game_id, team_id FROM cmd_jobs WHERE tournament_id = ? AND tournament_game_id IS NOT NULL')
        .all(tournament.id).map(j => `${j.tournament_game_id}:${j.team_id}`)
    );

    const planned = [];
    for (const g of games) {
      for (const side of [
        { team_id: g.home_team_id, team_name: g.home_team_name, opponent: g.away_team_name },
        { team_id: g.away_team_id, team_name: g.away_team_name, opponent: g.home_team_name },
      ]) {
        if (scope && !scope.has(side.team_id)) continue;
        const key = `${g.id}:${side.team_id}`;
        planned.push({
          tournament_game_id: g.id,
          game_date: g.game_date,
          team_id: side.team_id,
          team_name: side.team_name,
          opponent_label: side.opponent,
          skipped: existing.has(key) ? 'job already exists' : null,
        });
      }
    }

    const toCreate = planned.filter(p => !p.skipped);
    if (b.dry_run) {
      return res.json({ tournament: { id: tournament.id, name: tournament.name }, planned, would_create: toCreate.length });
    }
    if (toCreate.length === 0) {
      return res.status(400).json({ error: 'Nothing to create — every scheduled game already has a job for these teams', planned });
    }

    try {
      // One transaction: a partial bulk run would be worse than none.
      const created = db.transaction(() => toCreate.map(p => ({
        job_id: createJob({
          team_id: p.team_id,
          game_date: p.game_date,
          opponent_label: p.opponent_label,
          tournament_game_id: p.tournament_game_id,
          event_label: tournament.name,
          package_key: b.package_key,
          addon_codes: b.addon_codes,
          assigned_to: b.assigned_to,
          due_date: b.due_date,
          contact_email: b.contact_email,
          media_consent: b.media_consent,
          sharing_scope: b.sharing_scope,
          notes: b.notes,
        }, req.internal.id),
        team_name: p.team_name,
        game_date: p.game_date,
      })))();
      res.status(201).json({ created, skipped: planned.filter(p => p.skipped) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : `Bulk creation failed: ${err.message}` });
    }
  });
}
