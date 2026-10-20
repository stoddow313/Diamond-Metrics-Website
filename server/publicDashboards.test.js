// Public dashboards for demo / marketing use: a team dashboard is private
// (§9) until an admin opens it to everyone, and a tournament is public once
// published with public visibility — which Admin's Publish now sets. Runs the
// real server (the view routes live in index.js) against a scratch database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const TEST_DB = `/tmp/dm-public-dash-${process.pid}.db`;
const PASSWORD = 'local-test-only-password';
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';
process.env.DM_ADMIN_PASSWORD = PASSWORD;

const { db } = await import('./db.js');
let server, base, token, teamId, tourId;

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const get = (path, auth) => fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

before(async () => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Canyon')").run().lastInsertRowid;
  teamId = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon Athletics', 'canyon-athletics-demo')").run(org).lastInsertRowid;
  // Published the old way: the flag set, the visibility left private.
  tourId = db.prepare("INSERT INTO tournaments (name, slug, start_date, end_date, published) VALUES ('RMSB Demo', 'rmsb-demo', '2026-10-09', '2026-10-12', 1)").run().lastInsertRowid;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DM_STORAGE: 'local', DM_MEDIA_DIR: `/tmp/dm-public-dash-${process.pid}-media`, DM_BACKUPS: '0', DM_INLINE_WORKER: '0', DM_RATE_LIMITS: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  const email = db.prepare('SELECT email FROM admins ORDER BY id LIMIT 1').get().email;
  token = (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) }).then(r => r.json())).token;
  assert.ok(token, 'signed in as the seeded admin');
});
after(() => {
  server?.kill();
  db.close();
  fs.rmSync(`/tmp/dm-public-dash-${process.pid}-media`, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('a team dashboard is private until an admin makes it public, and private again after', async () => {
  assert.equal((await get('/api/view/teams/canyon-athletics-demo')).status, 401, 'signed out: private by default');
  assert.equal((await get('/api/view/teams/canyon-athletics-demo', token)).status, 200, 'admins always see it');

  const r = await put(`/api/teams/${teamId}`, { public_dashboard: true });
  assert.equal((await r.json()).team.public_dashboard, 1);
  const open = await get('/api/view/teams/canyon-athletics-demo');
  assert.equal(open.status, 200, 'signed out: viewable');
  assert.equal((await open.json()).viewer, 'anon');

  await put(`/api/teams/${teamId}`, { public_dashboard: 0 });
  assert.equal((await get('/api/view/teams/canyon-athletics-demo')).status, 401);
});

test("a tournament published the old way stays private; publishing with public visibility opens it", async () => {
  assert.equal((await get('/api/view/tournaments/rmsb-demo')).status, 401, 'published flag alone is not public');
  const r = await put(`/api/tournaments/${tourId}`, { published: 1, visibility: 'public' });   // what Admin's Publish sends now
  assert.equal(r.status, 200);
  assert.equal((await get('/api/view/tournaments/rmsb-demo')).status, 200, 'signed out: viewable');
  await put(`/api/tournaments/${tourId}`, { published: 0, visibility: 'private' });
  assert.equal((await get('/api/view/tournaments/rmsb-demo')).status, 401);
});
