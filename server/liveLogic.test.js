import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  createStream, getStream, endStream, authorize, recordRelayState, addEvent,
  sessionReport, slugifyPath, withUrls, playbackUrl,
  mintViewerToken, verifyViewerToken, relayTokenValid, constantTimeEqual,
} from './liveLogic.js';

const ENV = {
  DM_RELAY_HOST: 'ingest.test',
  DM_RELAY_SRT_PORT: '8890',
  DM_RELAY_RTMP_PORT: '1935',
  DM_PLAYBACK_BASE: 'https://live.test',
};

// The logic takes db as a parameter, so an in-memory database with just these
// tables is enough — no need to boot the app's schema.
function fresh() {
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
  `);
  return db;
}

test('a stream binds a job to a unique relay path and issues a key', () => {
  const db = fresh();
  const a = createStream(db, { job_id: 'job_1', label: 'Field 4 · 10U Final' }, ENV);
  const b = createStream(db, { job_id: 'job_1', label: 'Field 4 · 10U Final' }, ENV);
  assert.match(a.path, /^live\/field-4-10u-final-[0-9a-f]{6}$/);
  assert.notEqual(a.path, b.path, 'the same label must not collide');
  assert.ok(a.stream_key.length >= 32);
});

test('slugifyPath never yields an empty path segment', () => {
  assert.equal(slugifyPath('!!! ???', 'game'), 'game');
  assert.equal(slugifyPath('Field 4 — 10U', 'game'), 'field-4-10u');
});

test('ingest URLs use the grammar each protocol expects', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1', label: 'Game' }, ENV);
  const urls = withUrls(getStream(db, s.id), ENV).urls;
  assert.equal(urls.srt,
    `srt://ingest.test:8890?streamid=publish:${s.path}:publish:${s.stream_key}&pkt_size=1316`);
  assert.equal(urls.rtmp,
    `rtmp://ingest.test:1935/${s.path}?user=publish&pass=${encodeURIComponent(s.stream_key)}`);
});

// ── publishing ──────────────────────────────────────────────────────────────

test('publish is allowed only with the exact stream key', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  assert.equal(authorize(db, { action: 'publish', path: s.path, password: s.stream_key }).allow, true);
  assert.equal(authorize(db, { action: 'publish', path: s.path, password: 'wrong' }).allow, false);
  assert.equal(authorize(db, { action: 'publish', path: s.path, password: '' }).allow, false);
  // A prefix of the real key must not pass.
  assert.equal(authorize(db, { action: 'publish', path: s.path, password: s.stream_key.slice(0, -1) }).allow, false);
});

test('publish is refused for unknown and ended streams', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  assert.equal(authorize(db, { action: 'publish', path: 'live/nope', password: s.stream_key }).reason, 'unknown path');
  endStream(db, s.id);
  assert.equal(authorize(db, { action: 'publish', path: s.path, password: s.stream_key }).reason, 'stream ended');
});

test('actions other than publish and read are never delegated to us', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  for (const action of ['api', 'metrics', 'pprof', 'playback']) {
    assert.equal(authorize(db, { action, path: s.path }).allow, false, `${action} must be refused`);
  }
});

// ── viewers ─────────────────────────────────────────────────────────────────

test('a viewer token grants read on its own stream only, until it expires', () => {
  const db = fresh();
  const a = createStream(db, { job_id: 'job_1' }, ENV);
  const b = createStream(db, { job_id: 'job_2' }, ENV);
  const now = Date.now();
  const token = mintViewerToken(a.id, 300, now);

  assert.equal(authorize(db, { action: 'read', path: a.path, query: `token=${token}` }, now).allow, true);
  assert.equal(authorize(db, { action: 'read', path: b.path, query: `token=${token}` }, now).reason,
    'token is for another stream');
  assert.equal(authorize(db, { action: 'read', path: a.path, query: `token=${token}` }, now + 301_000).reason,
    'viewer token expired');
});

test('a tampered viewer token fails on the signature, not the expiry', () => {
  const token = mintViewerToken('ls_abc', 300);
  const [id, exp, mac] = token.split('.');
  assert.equal(verifyViewerToken(`${id}.${Number(exp) + 9999}.${mac}`).reason, 'bad_signature');
  assert.equal(verifyViewerToken('').reason, 'missing');
});

test('playbackUrl carries a token for its own stream', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  const pb = playbackUrl(getStream(db, s.id), ENV);
  assert.match(pb.url, new RegExp(`^https://live\\.test/${s.path}/index\\.m3u8\\?token=`));
  assert.equal(verifyViewerToken(pb.token).streamId, s.id);
});

// ── the relay's own identity ────────────────────────────────────────────────

test('the relay token fails closed when unconfigured', () => {
  const prior = process.env.DM_RELAY_TOKEN;
  delete process.env.DM_RELAY_TOKEN;
  // An unset secret must never mean "allow anyone" — that is the mistake that
  // exposes /api/live/auth to the internet.
  assert.equal(relayTokenValid(''), false);
  assert.equal(relayTokenValid('anything'), false);
  process.env.DM_RELAY_TOKEN = 'correct-horse';
  assert.equal(relayTokenValid('correct-horse'), true);
  assert.equal(relayTokenValid('wrong'), false);
  assert.equal(relayTokenValid(undefined), false);
  if (prior === undefined) delete process.env.DM_RELAY_TOKEN; else process.env.DM_RELAY_TOKEN = prior;
});

test('constantTimeEqual handles length mismatch without throwing', () => {
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', 'a'), false);
  assert.equal(constantTimeEqual('same', 'same'), true);
});

// ── state ───────────────────────────────────────────────────────────────────

test('started_at is set once and survives reconnects', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  const first = recordRelayState(db, s.path, 'live');
  recordRelayState(db, s.path, 'offline');
  const back = recordRelayState(db, s.path, 'live');
  assert.equal(back.started_at, first.started_at, 'a reconnect must not restart the session clock');
  assert.equal(back.status, 'live');
});

test('an ended stream is not dragged back by a late relay hook', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  recordRelayState(db, s.path, 'live');
  endStream(db, s.id);
  assert.equal(recordRelayState(db, s.path, 'offline').status, 'ended');
});

// ── the acceptance measurement ──────────────────────────────────────────────

test('availability is live time over session time, and gaps become reconnect times', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  const t0 = Date.parse('2026-09-02T18:00:00.000Z');
  for (const [seconds, kind] of [[0, 'live'], [100, 'offline'], [106, 'live'],
                                 [200, 'offline'], [214, 'live'], [300, 'offline']]) {
    const at = new Date(t0 + seconds * 1000).toISOString();
    addEvent(db, s.id, kind, {}, 'relay', at);
    if (kind === 'live' && !getStream(db, s.id).started_at) {
      db.prepare('UPDATE cmd_live_streams SET started_at = ?, status = ? WHERE id = ?').run(at, 'live', s.id);
    }
  }
  db.prepare('UPDATE cmd_live_streams SET ended_at = ?, status = ? WHERE id = ?')
    .run(new Date(t0 + 300_000).toISOString(), 'ended', s.id);

  const rep = sessionReport(db, s.id);
  assert.equal(rep.session_seconds, 300);
  assert.equal(rep.live_seconds, 280);
  assert.equal(rep.availability, 280 / 300);
  assert.equal(rep.reconnect_count, 2);
  assert.equal(rep.worst_reconnect_seconds, 14);
});

test('a stream that never went live reports no availability rather than zero', () => {
  const db = fresh();
  const s = createStream(db, { job_id: 'job_1' }, ENV);
  const rep = sessionReport(db, s.id);
  assert.equal(rep.availability, null, 'zero would read as an outage that never happened');
  assert.equal(rep.session_seconds, 0);
});
