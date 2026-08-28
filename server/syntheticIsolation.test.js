// Synthetic pipeline-test jobs must never reach a customer. The events are
// still recorded — suppressed, not dropped — so the audit trail shows what
// would have been sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-synth-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { emitJobEvent } = await import('./notifications.js');

let realJob, testJob;
before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('O')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'T', 't')").run(org).lastInsertRowid;
  const sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  const mk = (synthetic) => {
    const o = db.prepare("INSERT INTO cmd_orders (package_key, label, contact_email, synthetic) VALUES ('rookie','R','coach@club.test',?)").run(synthetic).lastInsertRowid;
    return db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?,?,'2026-08-27',?)").run(sport, team, o).lastInsertRowid;
  };
  realJob = mk(0);
  testJob = mk(1);
});
after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const statusOf = jobId => db.prepare('SELECT email_status FROM cmd_notifications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId)?.email_status;

test('a synthetic job records notifications as suppressed, never queued to send', () => {
  for (const key of ['footage_received', 'metrics_ready', 'full_review_complete', 'paid_metric_unavailable']) {
    emitJobEvent(db, { jobId: testJob, eventKey: key });
    assert.equal(statusOf(testJob), 'suppressed_synthetic', `${key} must be suppressed`);
  }
  const rows = db.prepare('SELECT COUNT(*) n FROM cmd_notifications WHERE job_id = ?').get(testJob).n;
  assert.equal(rows, 4, 'suppressed, not dropped — the audit trail is intact');
});

test('a real job is unaffected', () => {
  emitJobEvent(db, { jobId: realJob, eventKey: 'metrics_ready' });
  assert.notEqual(statusOf(realJob), 'suppressed_synthetic');
  assert.ok(['skipped', 'queued'].includes(statusOf(realJob)));
});
