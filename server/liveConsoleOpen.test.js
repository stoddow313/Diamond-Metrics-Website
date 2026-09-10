// DM_LIVE_CONSOLE_OPEN is a testing switch that opens the staff routes. These
// tests pin its boundaries: off by default, and when on it opens *only* the
// staff routes — never the relay's hooks or the phone's stream-key checks.
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

// Mounts with a requireInternal that always refuses, so any 200 on a staff route
// can only have come from the switch.
async function harness(open) {
  const prior = process.env.DM_LIVE_CONSOLE_OPEN;
  if (open) process.env.DM_LIVE_CONSOLE_OPEN = '1'; else delete process.env.DM_LIVE_CONSOLE_OPEN;

  const db = schema();
  const app = express();
  app.use(express.json());
  const refuse = (_req, res) => res.status(401).json({ error: 'Not authenticated' });
  mountLiveRoutes(app, { db, requireInternal: refuse, currentUser: () => null });
  // Express only treats four-argument middleware as an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  if (prior === undefined) delete process.env.DM_LIVE_CONSOLE_OPEN;
  else process.env.DM_LIVE_CONSOLE_OPEN = prior;

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { db, server, base: `http://127.0.0.1:${server.address().port}/api/live` };
}

test('the console is closed unless the switch is set', async () => {
  const { server, base } = await harness(false);
  assert.equal((await fetch(`${base}/streams`)).status, 401);
  assert.equal((await fetch(`${base}/streams`, { method: 'POST' })).status, 401);
  server.close();
});

test('with the switch set, staff routes open and /health says so', async () => {
  const { server, base } = await harness(true);
  assert.equal((await fetch(`${base}/streams`)).status, 200);

  const created = await fetch(`${base}/streams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: 'job_1' }),
  });
  assert.equal(created.status, 201);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.api.console_open, true, 'the console must be able to warn on screen');
  server.close();
});

test('an open console never opens the relay hooks', async () => {
  const { server, base } = await harness(true);
  const prior = process.env.DM_RELAY_TOKEN;
  process.env.DM_RELAY_TOKEN = 'relay-secret';
  // The relay's identity is a different principal; the testing switch must not
  // let anyone post fake live events or authorise their own publish.
  for (const [path, body] of [
    ['/auth', { action: 'publish', path: 'live/x', password: 'y' }],
    ['/events', { path: 'live/x', state: 'live' }],
    ['/recordings', { path: 'live/x', segment: 's.mp4' }],
  ]) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 401, `${path} must still require the relay token`);
  }
  if (prior === undefined) delete process.env.DM_RELAY_TOKEN; else process.env.DM_RELAY_TOKEN = prior;
  server.close();
});

test("an open console never opens the phone's stream-key routes", async () => {
  const { db, server, base } = await harness(true);
  const stream = createStream(db, { job_id: 'job_1' });
  const res = await fetch(`${base}/streams/${stream.id}/samples`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401, 'uploads and samples still need the stream key');
  server.close();
});
