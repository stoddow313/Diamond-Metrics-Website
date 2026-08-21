// Regression: an interrupted upload must not permanently block re-uploading
// that file. A 2-hour game file over a coach's wifi will get interrupted;
// content-hash dedupe previously matched the half-finished feed and returned
// it as a duplicate, so the analyst could never complete the transfer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-upload-resume-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');

let jobId;
const HASH = 'abc123';
const SIZE = 12_000_000_000;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('O')").run().lastInsertRowid;
  const team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'T', 't')").run(org).lastInsertRowid;
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'R')").run().lastInsertRowid;
  const sport = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-08-21', ?)").run(sport, team, order).lastInsertRowid;
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

// Mirrors the registration route's dedupe decision.
const RESUMABLE = ['uploading', 'failed'];
function classify(hash, size) {
  const existing = db.prepare(
    'SELECT * FROM cmd_video_feeds WHERE job_id = ? AND content_hash = ? AND size_bytes = ?'
  ).get(jobId, hash, size);
  if (!existing) return { action: 'create' };
  return RESUMABLE.includes(existing.status)
    ? { action: 'resume', feedId: existing.id }
    : { action: 'duplicate', feedId: existing.id };
}

const addFeed = (status) => db.prepare(
  "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, size_bytes, content_hash, status) VALUES (?, 'BH', 'k', 'game.mp4', ?, ?, ?)"
).run(jobId, SIZE, HASH, status).lastInsertRowid;

test('an upload interrupted mid-transfer can be restarted, not blocked forever', () => {
  const feedId = addFeed('uploading');
  const decision = classify(HASH, SIZE);
  assert.equal(decision.action, 'resume', 'a half-uploaded feed must be resumable');
  assert.equal(decision.feedId, feedId, 'resume reuses the same feed row — no orphan duplicates');

  // A feed whose processing failed is also worth re-sending.
  db.prepare("UPDATE cmd_video_feeds SET status = 'failed' WHERE id = ?").run(feedId);
  assert.equal(classify(HASH, SIZE).action, 'resume');
});

test('a genuinely complete feed is still deduped — re-selecting it uploads nothing', () => {
  db.prepare("UPDATE cmd_video_feeds SET status = 'ready' WHERE id = (SELECT id FROM cmd_video_feeds WHERE job_id = ?)").run(jobId);
  assert.equal(classify(HASH, SIZE).action, 'duplicate', 'real duplicates must not re-upload');

  // In-flight processing is not an interruption either — leave it alone.
  for (const st of ['uploaded', 'queued', 'processing', 'retrying']) {
    db.prepare("UPDATE cmd_video_feeds SET status = ? WHERE job_id = ?").run(st, jobId);
    assert.equal(classify(HASH, SIZE).action, 'duplicate', `${st} must not restart the transfer`);
  }
});

test('a different file on the same job is unaffected', () => {
  assert.equal(classify('other-hash', 999).action, 'create');
});
