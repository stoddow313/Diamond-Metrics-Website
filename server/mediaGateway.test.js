// The gateway is what stands between ffmpeg and storage in production —
// prove the HTTP semantics (auth, ranges) and, critically, that ffprobe can
// SEEK through it: a moov-at-end MP4 forces range requests, which is
// exactly what a phone/drone original does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gateway-'));
process.env.DM_DB_PATH = `/tmp/dm-gateway-${process.pid}.db`;
process.env.DM_MEDIA_DIR = MEDIA_DIR;
process.env.DM_LOG_SILENT = '1';
delete process.env.DM_STORAGE;

const { gatewayUrlFor } = await import('./mediaGateway.js');
const { localPathFor } = await import('./storage.js');

const KEY = 'originals/99/source.mp4';
let url;

before(async () => {
  const FFMPEG = require_('@ffmpeg-installer/ffmpeg').path;
  const filePath = localPathFor(KEY);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Deliberately NOT faststart: moov lands at the END of the file, so any
  // reader must seek — the hard case for HTTP input.
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', filePath]);
  url = await gatewayUrlFor(KEY);
});

after(() => {
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  for (const f of [process.env.DM_DB_PATH, `${process.env.DM_DB_PATH}-wal`, `${process.env.DM_DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

test('rejects requests without a valid token', async () => {
  const res = await fetch(url.split('?')[0]);
  assert.equal(res.status, 403);
  const res2 = await fetch(`${url.split('?')[0]}?t=deadbeef`);
  assert.equal(res2.status, 403);
});

test('serves full content and honours byte ranges like a real file server', async () => {
  const size = fs.statSync(localPathFor(KEY)).size;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get('content-length')), size);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  await full.arrayBuffer();

  const mid = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-range'), `bytes 100-199/${size}`);
  assert.equal((await mid.arrayBuffer()).byteLength, 100);

  // Suffix range is how readers grab the moov atom from the tail.
  const tail = await fetch(url, { headers: { Range: 'bytes=-256' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 256);
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 256}-${size - 1}/${size}`);
});

test('ffprobe seeks a moov-at-end MP4 through the gateway (the DJI case)', async () => {
  const FFPROBE = require_('@ffprobe-installer/ffprobe').path;
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'csv=p=0', url]);
  assert.match(stdout.trim(), /^h264,320,180,60$/);
});
