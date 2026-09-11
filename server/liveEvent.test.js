// The console's event view is where a game's two recordings are seen. These pin
// the regression where a finished master came back with nothing to play, and
// where an empty live-copy list hid why it was empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { mountLiveRoutes } from './liveRoutes.js';
import { createStream } from './liveLogic.js';

function schema() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cmd_live_streams (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, label TEXT, path TEXT NOT NULL UNIQUE,
      stream_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
      consent TEXT NOT NULL DEFAULT 'team', created_at TEXT NOT NULL,
      started_at TEXT, ended_at TEXT, recording_prefix TEXT);
    CREATE TABLE cmd_live_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT NOT NULL, kind TEXT NOT NULL,
      at TEXT NOT NULL, detail TEXT, source TEXT);
    CREATE TABLE cmd_live_masters (
      id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL,
      part_size INTEGER NOT NULL, parts_total INTEGER NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT, storage_key TEXT NOT NULL,
      upload_id TEXT, expected_fps REAL);
  `);
  return db;
}

async function harness() {
  process.env.DM_LIVE_CONSOLE_OPEN = '1';
  const db = schema();
  const app = express();
  app.use(express.json());
  mountLiveRoutes(app, { db, requireInternal: (_req, res) => res.status(401).end(), currentUser: () => null });
  // Express only treats four-argument middleware as an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  delete process.env.DM_LIVE_CONSOLE_OPEN;
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { db, server, base: `http://127.0.0.1:${server.address().port}/api/live` };
}

function addMaster(db, streamId, status) {
  db.prepare(`INSERT INTO cmd_live_masters
      (id, stream_id, filename, bytes, part_size, parts_total, status, created_at, storage_key, upload_id)
      VALUES (?, ?, 'master.mp4', 1000, 500, 2, ?, ?, ?, NULL)`)
    .run(`mst_${status}`, streamId, status, new Date().toISOString(), `live-masters/${streamId}/master.mp4`);
}

test('a completed master comes back with something to play', async () => {
  const { db, server, base } = await harness();
  const s = createStream(db, { job_id: 'job_1' });
  addMaster(db, s.id, 'complete');
  const event = await (await fetch(`${base}/streams/${s.id}/event`)).json();
  assert.equal(event.masters.length, 1);
  assert.ok(event.masters[0].url, 'a complete master with no url renders as an empty player');
  assert.equal(event.masters[0].bytes_received, 1000);
  server.close();
});

test('a master still uploading reports numeric progress and no url', async () => {
  const { db, server, base } = await harness();
  const s = createStream(db, { job_id: 'job_1' });
  addMaster(db, s.id, 'uploading');
  const [m] = (await (await fetch(`${base}/streams/${s.id}/event`)).json()).masters;
  assert.ok(Number.isFinite(m.bytes_received), 'undefined progress renders as "Uploading — NaN%"');
  assert.equal(m.url, null);
  server.close();
});

test('when the live copy cannot be listed, the event says why', async () => {
  const { db, server, base } = await harness();
  const s = createStream(db, { job_id: 'job_1' });
  const event = await (await fetch(`${base}/streams/${s.id}/event`)).json();
  assert.deepEqual(event.live_copy, []);
  assert.ok(event.live_copy_unavailable, 'an unexplained empty list reads as "nothing was recorded"');
  server.close();
});
