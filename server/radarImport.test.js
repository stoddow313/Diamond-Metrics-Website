// M3 acceptance: tolerant CSV parsing, idempotent import, immutable source
// rows, classification → draft metric results, and the directive's manual-
// entry field set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-radar-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const { parseRadarCsv, classifyReading } = await import('./radarImport.js');
const { velocityRollup } = await import('./metricRelease.js');

let jobId, playerId, otherPlayerId;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Team', 'team')").run(org).lastInsertRowid;
  playerId = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('p-one', 'P', 'One')").run().lastInsertRowid;
  otherPlayerId = db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('p-two', 'P', 'Two')").run().lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of ['pitch_velocity_radar', 'home_to_first', 'steal_time']) {
    db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority) VALUES (?, ?, 10)").run(order, code);
  }
  const baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-21', ?)").run(baseball, team, order).lastInsertRowid;
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('parser: Pocket-Radar-style CSV with headers, noise, and junk rows', () => {
  const csv = [
    'Date,Time,Speed (MPH)',
    '8/21/26,10:01:15,68.4',
    '8/21/26,10:01:52,71.2',
    '8/21/26,10:02:30,--',        // no reading captured
    '8/21/26,10:03:05,142',       // implausible → invalid
    '8/21/26,10:03:44,69.8',
  ].join('\n');
  const { rows, header_detected } = parseRadarCsv(csv);
  assert.equal(header_detected, true);
  assert.equal(rows.length, 5, 'every row kept');
  assert.deepEqual(rows.filter(r => r.parse_ok).map(r => r.velocity), [68.4, 71.2, 69.8]);
  assert.equal(rows[0].source_timestamp, '10:01:15');
  assert.ok(rows.every(r => r.raw_row.length > 0), 'raw rows preserved');
});

test('parser: headerless velocity list still imports', () => {
  const { rows, header_detected } = parseRadarCsv('67.9\n70.3\nnoise\n72.0');
  assert.equal(header_detected, false);
  assert.deepEqual(rows.filter(r => r.parse_ok).map(r => r.velocity), [67.9, 70.3, 72]);
});

test('classification: matched reading creates a draft radar-verified result; invalidation removes it', () => {
  const readingId = db.prepare(
    "INSERT INTO cmd_radar_readings (job_id, source, velocity, raw_row) VALUES (?, 'csv_import', 71.2, 'r')"
  ).run(jobId).lastInsertRowid;

  classifyReading(db, readingId, { player_id: playerId, pitch_or_exit: 'pitch', pitch_type: 'fastball', status: 'matched' }, 1);
  let result = db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_kind='radar_reading' AND evidence_id=?").get(readingId);
  assert.ok(result, 'draft result created');
  assert.equal(result.method, 'radar_verified');
  assert.equal(result.metric_code, 'pitch_velocity_radar');
  assert.equal(result.value, 71.2);
  assert.equal(result.status, 'draft');

  // Reassign to another player — the draft follows the reading.
  classifyReading(db, readingId, { player_id: otherPlayerId }, 1);
  result = db.prepare("SELECT * FROM cmd_metric_results WHERE evidence_id=?").get(readingId);
  assert.equal(result.player_id, otherPlayerId);

  // Invalidate — the draft is withdrawn, never deleted; the immutable reading row remains.
  classifyReading(db, readingId, { status: 'invalid', note: 'car radar noise' }, 1);
  const rows = db.prepare('SELECT * FROM cmd_metric_results WHERE evidence_id=?').all(readingId);
  assert.equal(rows.length, 1, 'one result per reading, even after invalidation');
  assert.equal(rows[0].id, result.id, 'the same row');
  assert.equal(rows[0].status, 'withdrawn');
  assert.equal(rows[0].restore_status, 'draft');
  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id=?').get(readingId);
  assert.equal(reading.velocity, 71.2, 'source velocity untouched');
  assert.equal(reading.status, 'invalid');

  // Audit trail recorded every decision — on the reading, and the withdrawal on the result with its reason.
  const audits = db.prepare("SELECT COUNT(*) c FROM cmd_review_actions WHERE target_table='cmd_radar_readings' AND target_id=?").get(readingId).c;
  assert.equal(audits, 3);
  const withdrawn = db.prepare("SELECT note FROM cmd_review_actions WHERE target_table='cmd_metric_results' AND target_id=? AND action='withdrawn'").get(result.id);
  assert.match(withdrawn.note, /car radar noise/);

  // Restore — the same result revives; still exactly one row.
  classifyReading(db, readingId, { player_id: otherPlayerId, status: 'matched' }, 1);
  const revived = db.prepare('SELECT * FROM cmd_metric_results WHERE evidence_id=?').all(readingId);
  assert.equal(revived.length, 1);
  assert.equal(revived[0].id, result.id);
  assert.equal(revived[0].status, 'draft');
  assert.equal(revived[0].player_id, otherPlayerId);
});

test('guards: matched requires player; unparseable rows cannot match; exit velocity needs its module', () => {
  const r1 = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity) VALUES (?, 'manual', 66)").run(jobId).lastInsertRowid;
  assert.throws(() => classifyReading(db, r1, { status: 'matched' }, 1), /requires a player/);

  const r2 = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity) VALUES (?, 'csv_import', NULL)").run(jobId).lastInsertRowid;
  assert.throws(() => classifyReading(db, r2, { player_id: playerId, status: 'matched' }, 1), /cannot be matched/);

  // Rookie order has no exit-velocity module → matched exit reading stores no draft result.
  const r3 = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity) VALUES (?, 'manual', 84.1)").run(jobId).lastInsertRowid;
  classifyReading(db, r3, { player_id: playerId, pitch_or_exit: 'exit', status: 'matched' }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cmd_metric_results WHERE evidence_id=?').get(r3).c, 0, 'no module, no result');
});

test('rollup preview: drafts feed the TDR §5a velocity mapping', () => {
  for (const v of [68.4, 69.8]) {
    const id = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity) VALUES (?, 'csv_import', ?)").run(jobId, v).lastInsertRowid;
    classifyReading(db, id, { player_id: playerId, pitch_or_exit: 'pitch', status: 'matched' }, 1);
  }
  const drafts = db.prepare(
    "SELECT value, 'approved' AS status FROM cmd_metric_results WHERE job_id=? AND player_id=? AND metric_code='pitch_velocity_radar'"
  ).all(jobId, playerId);
  const rollup = velocityRollup(drafts, { maxKey: 'max_velo', avgKey: 'avg_velo' });
  assert.equal(rollup.sample.valid_readings, 2);
  assert.equal(rollup.sample.max, 69.8);
});
