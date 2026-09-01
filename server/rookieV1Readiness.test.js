// Rookie V1 readiness: order gating, evidence provenance, synthetic-job
// isolation on release, and the operational checks (backup restore drill,
// email test path). Each pins a behaviour the pilot team asked for before
// real customer orders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-rookie-v1-${process.pid}.db`;
const MEDIA_DIR = `/tmp/dm-rookie-v1-${process.pid}-store`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_MEDIA_DIR = MEDIA_DIR;
process.env.DM_STORAGE = 'local';
process.env.DM_LOG_SILENT = '1';
delete process.env.DM_ORDERABLE_PACKAGES;
delete process.env.RESEND_API_KEY;

const { db } = await import('./db.js');
const { PACKAGES, orderablePackages, SHARING_SCOPES_V1, assertRequirementToggle, buildRequirements } = await import('./commandLogic.js');
const { classifyReading } = await import('./radarImport.js');
const { releaseMetrics, decideResult } = await import('./releaseLogic.js');
const { runBackup, verifyLatestBackup } = await import('./backup.js');
const { sendTestEmail, emailMissingConfig } = await import('./notifications.js');

let team, baseball, adminId, playerId;
function makeJob({ synthetic = 0 } = {}) {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, synthetic) VALUES ('rookie', 'Rookie', ?)").run(synthetic).lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) {
    const reg = db.prepare('SELECT capture_requirements FROM cmd_metric_registry WHERE metric_code = ?').get(code);
    db.prepare('INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, ?, 1)').run(order, code, reg?.capture_requirements || '');
  }
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-31', ?)").run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(job, 'customer', adminId);
  return { job, order };
}

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  adminId = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  playerId = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Ace', 'Arm', 'ace-arm')").run().lastInsertRowid;
});

after(() => {
  db.close();
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// ── Item 2: order/package gating ───────────────────────────────────────────
test('only Rookie is orderable in V1; the others carry a reason and an env override exists for staging', () => {
  assert.deepEqual(orderablePackages({}), ['rookie']);
  for (const key of ['rookie_plus', 'pro', 'custom']) {
    assert.equal(PACKAGES[key].orderable, false, key);
    assert.ok(PACKAGES[key].unavailable_reason, `${key} explains why`);
  }
  assert.deepEqual(orderablePackages({ DM_ORDERABLE_PACKAGES: 'rookie, pro, nonsense' }), ['rookie', 'pro'], 'override keeps known keys only');
  assert.deepEqual(SHARING_SCOPES_V1, ['internal', 'customer'], 'public sharing is not offered');
});

test('a custom order with no metrics is refused by the requirement builder itself', () => {
  const registry = db.prepare('SELECT * FROM cmd_metric_registry').all();
  assert.throws(() => buildRequirements({ packageKey: 'custom', addonCodes: [], registry }), /no metric requirements/);
  assert.equal(buildRequirements({ packageKey: 'rookie', registry }).length, 4);
});

test('the last active metric requirement on a job cannot be disabled', () => {
  const { order } = makeJob();
  const reqs = db.prepare('SELECT * FROM cmd_metric_requirements WHERE order_id = ? ORDER BY id').all(order);
  assert.equal(reqs.length, 4);
  // Disabling three of four is fine.
  for (const r of reqs.slice(0, 3)) {
    assertRequirementToggle(db, r, 0);
    db.prepare('UPDATE cmd_metric_requirements SET enabled = 0 WHERE id = ?').run(r.id);
  }
  assert.throws(() => assertRequirementToggle(db, reqs[3], 0), /at least one active metric requirement/);
  assertRequirementToggle(db, reqs[0], 1);   // re-enabling is always allowed
});

// ── Item 3: CSV evidence provenance ────────────────────────────────────────
test('confirming an imported reading keeps its CSV provenance; source fields are immutable at the database', () => {
  const { job } = makeJob();
  const importId = db.prepare(
    "INSERT INTO cmd_radar_imports (job_id, filename, file_hash, raw_content, row_count, created_by) VALUES (?, 'PocketRadar_2026-08-31.csv', 'h1', 'raw', 1, ?)"
  ).run(job, adminId).lastInsertRowid;
  const readingId = db.prepare(
    `INSERT INTO cmd_radar_readings (job_id, source, import_id, row_index, velocity, source_timestamp, raw_row, status, created_by)
     VALUES (?, 'csv_import', ?, 2, 78, '2026-08-31T15:00:03-06:00', '2026-08-31T15:00:03-06:00,78,MPH', 'unmatched', ?)`
  ).run(job, importId, adminId).lastInsertRowid;

  classifyReading(db, readingId, { player_id: playerId, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, adminId);

  const r = db.prepare(
    `SELECT r.*, i.filename AS import_filename, a.name AS confirmed_by_name
       FROM cmd_radar_readings r LEFT JOIN cmd_radar_imports i ON i.id = r.import_id LEFT JOIN admins a ON a.id = r.confirmed_by WHERE r.id = ?`
  ).get(readingId);
  assert.equal(r.source, 'csv_import', 'source never becomes manual');
  assert.equal(r.import_filename, 'PocketRadar_2026-08-31.csv');
  assert.equal(r.row_index, 2);
  assert.equal(r.velocity, 78);
  assert.equal(r.source_timestamp, '2026-08-31T15:00:03-06:00');
  assert.equal(r.raw_row, '2026-08-31T15:00:03-06:00,78,MPH');
  assert.equal(r.status, 'matched');
  assert.ok(r.confirmed_by_name, 'confirmation is recorded separately, with the analyst');
  assert.ok(r.confirmed_at);

  // The audit history holds the decision.
  const audit = db.prepare("SELECT * FROM cmd_review_actions WHERE target_table='cmd_radar_readings' AND target_id=? AND action='classified'").all(readingId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].new_state, `matched/${playerId}`);

  // The review payload's evidence carries the same provenance.
  const res = db.prepare(
    `SELECT r.*, rr.source AS reading_source, rr.row_index AS reading_row, ri.filename AS reading_import_filename, ra.name AS reading_confirmed_by_name
       FROM cmd_metric_results r
       LEFT JOIN cmd_radar_readings rr ON r.evidence_kind = 'radar_reading' AND rr.id = r.evidence_id
       LEFT JOIN cmd_radar_imports ri ON ri.id = rr.import_id
       LEFT JOIN admins ra ON ra.id = rr.confirmed_by
      WHERE r.evidence_id = ? AND r.evidence_kind = 'radar_reading'`
  ).get(readingId);
  assert.equal(res.reading_source, 'csv_import');
  assert.equal(res.reading_row, 2);
  assert.equal(res.reading_import_filename, 'PocketRadar_2026-08-31.csv');
  assert.ok(res.reading_confirmed_by_name);

  // Nothing — not even a direct UPDATE — can rewrite what the device recorded.
  for (const sql of [
    "UPDATE cmd_radar_readings SET source = 'manual' WHERE id = ?",
    'UPDATE cmd_radar_readings SET velocity = 81 WHERE id = ?',
    'UPDATE cmd_radar_readings SET row_index = 9 WHERE id = ?',
    "UPDATE cmd_radar_readings SET source_timestamp = '' WHERE id = ?",
    "UPDATE cmd_radar_readings SET raw_row = 'x' WHERE id = ?",
    'UPDATE cmd_radar_readings SET import_id = NULL WHERE id = ?',
  ]) {
    assert.throws(() => db.prepare(sql).run(readingId), /immutable/, sql);
  }
  // Analyst-owned columns still change freely.
  db.prepare("UPDATE cmd_radar_readings SET note = 'looked clean' WHERE id = ?").run(readingId);
  classifyReading(db, readingId, { status: 'invalid', note: 'gun misread' }, adminId);
  assert.equal(db.prepare('SELECT source, velocity FROM cmd_radar_readings WHERE id = ?').get(readingId).source, 'csv_import');
});

// ── Item 4: synthetic jobs never reach customer surfaces ───────────────────
test('releasing a synthetic job runs the workflow but publishes nothing to player profiles', () => {
  const { job } = makeJob({ synthetic: 1 });
  const readingId = db.prepare(
    "INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 79, 'unmatched', ?)"
  ).run(job, adminId).lastInsertRowid;
  classifyReading(db, readingId, { player_id: playerId, pitch_or_exit: 'pitch', status: 'matched' }, adminId);
  const result = db.prepare("SELECT id FROM cmd_metric_results WHERE job_id = ? AND status = 'draft'").get(job);
  decideResult(db, result.id, { decision: 'approved' }, adminId);

  const before = db.prepare('SELECT COUNT(*) c FROM stat_entries').get().c;
  const { published } = releaseMetrics(db, job, adminId);
  assert.ok(published.length >= 1, 'the rollup still "releases" for workflow purposes');
  assert.ok(published.every(p => p.withheld === 'synthetic'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stat_entries').get().c, before, 'no stat entries');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM games WHERE command_job_id = ?').get(job).c, 0, 'no game rows');
  assert.equal(db.prepare('SELECT status FROM cmd_metric_results WHERE id = ?').get(result.id).status, 'published');
  const audit = db.prepare("SELECT note FROM cmd_review_actions WHERE target_id = ? AND action = 'metrics_released'").get(job);
  assert.match(audit.note, /withheld from player profiles — synthetic/);
  const emails = db.prepare('SELECT email_status FROM cmd_notifications WHERE job_id = ?').all(job);
  assert.ok(emails.every(e => e.email_status === 'suppressed_synthetic'), JSON.stringify(emails));
});

test('releasing a real job still publishes to games/stat_entries', () => {
  const { job } = makeJob({ synthetic: 0 });
  const readingId = db.prepare(
    "INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 82, 'unmatched', ?)"
  ).run(job, adminId).lastInsertRowid;
  classifyReading(db, readingId, { player_id: playerId, pitch_or_exit: 'pitch', status: 'matched' }, adminId);
  const result = db.prepare("SELECT id FROM cmd_metric_results WHERE job_id = ? AND status = 'draft'").get(job);
  decideResult(db, result.id, { decision: 'approved' }, adminId);
  const { published } = releaseMetrics(db, job, adminId);
  assert.ok(published.length >= 1 && published.every(p => !p.withheld));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM games WHERE command_job_id = ?').get(job).c, 1);
});

// ── Item 5: operational readiness checks ───────────────────────────────────
test('restore drill: the latest snapshot downloads, passes integrity_check, and reports row counts', async () => {
  await runBackup(db);
  const v = await verifyLatestBackup(db);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.integrity, 'ok');
  assert.ok(v.counts.cmd_jobs >= 1);
  assert.ok(v.bytes > 0);
});

test('email test send explains exactly what is missing when unconfigured', async () => {
  assert.deepEqual(emailMissingConfig(), ['RESEND_API_KEY', 'DM_EMAIL_FROM']);
  const r = await sendTestEmail('ops@example.com');
  assert.equal(r.ok, false);
  assert.match(r.error, /RESEND_API_KEY and DM_EMAIL_FROM/);
  process.env.RESEND_API_KEY = 'k'; process.env.DM_EMAIL_FROM = 'noreply@example.com';
  const bad = await sendTestEmail('not-an-address');
  assert.match(bad.error, /valid recipient/);
  delete process.env.RESEND_API_KEY; delete process.env.DM_EMAIL_FROM;
});
