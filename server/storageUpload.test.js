// Server-side uploads to R2 (review proxies, backups). requestTimeout is a
// wall-clock limit on one request, and an upload's response waits for its
// whole body — so a single PUT of a full-game proxy that took longer than
// 120 s to send failed after every encode ("a request has exceeded the
// configured 120000 ms requestTimeout"). Large files now go up in parts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

delete process.env.DM_STORAGE;
const { uploadFile } = await import('./storage.js');
const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
const { NodeHttpHandler } = await import('@smithy/node-http-handler');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-upload-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
function fileOf(bytes, name = `f-${bytes}.bin`) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(Array.from({ length: bytes }, (_, i) => i % 251)));
  return p;
}
const read = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };

// A fake S3 send: records commands, keeps part bodies, can fail on cue.
function fakeS3({ failPart = {} } = {}) {
  const calls = [];
  const parts = new Map();
  let inFlight = 0, maxInFlight = 0;
  const send = async cmd => {
    const name = cmd.constructor.name;
    calls.push({ name, input: cmd.input });
    if (name === 'CreateMultipartUploadCommand') return { UploadId: 'up-1' };
    if (name === 'UploadPartCommand') {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const body = await read(cmd.input.Body);
        await new Promise(r => setTimeout(r, 5));
        const n = cmd.input.PartNumber;
        if (failPart[n] > 0) { failPart[n]--; throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); }
        parts.set(n, body);
        return { ETag: `"etag-${n}"` };
      } finally { inFlight--; }
    }
    if (name === 'PutObjectCommand') return { ETag: '"one"', body: await read(cmd.input.Body) };
    return {};
  };
  return { send, calls, parts, maxInFlight: () => maxInFlight };
}

test('a file within one part goes up as a single PUT', async () => {
  const s3 = fakeS3();
  const r = await uploadFile(s3.send, { bucket: 'b', key: 'renditions/1/thumbs.jpg', filePath: fileOf(800), partBytes: 1000 });
  assert.deepEqual(r, { parts: 1, size: 800 });
  assert.deepEqual(s3.calls.map(c => c.name), ['PutObjectCommand']);
  assert.equal(s3.calls[0].input.ContentLength, 800);
});

test('a larger file goes up in equal parts, in order, a few at a time, and arrives intact', async () => {
  const s3 = fakeS3();
  const file = fileOf(4500);
  const r = await uploadFile(s3.send, { bucket: 'b', key: 'renditions/1/proxy.mp4', filePath: file, partBytes: 1000, concurrency: 3, backoffMs: 1 });
  assert.deepEqual(r, { parts: 5, size: 4500 });
  const sizes = [...s3.parts.keys()].sort((a, b) => a - b).map(n => s3.parts.get(n).length);
  assert.deepEqual(sizes, [1000, 1000, 1000, 1000, 500], 'every part but the last is the same size');
  const joined = Buffer.concat([1, 2, 3, 4, 5].map(n => s3.parts.get(n)));
  assert.ok(joined.equals(fs.readFileSync(file)), 'parts reassemble to the file');
  const complete = s3.calls.find(c => c.name === 'CompleteMultipartUploadCommand').input;
  assert.deepEqual(complete.MultipartUpload.Parts.map(p => [p.PartNumber, p.ETag]), [1, 2, 3, 4, 5].map(n => [n, `"etag-${n}"`]));
  assert.ok(s3.maxInFlight() <= 3 && s3.maxInFlight() >= 2, `in flight: ${s3.maxInFlight()}`);
});

test('a failed part is retried from disk on its own; a part that keeps failing aborts the upload', async () => {
  const flaky = fakeS3({ failPart: { 2: 1 } });
  const file = fileOf(3000, 'flaky.bin');
  await uploadFile(flaky.send, { bucket: 'b', key: 'k', filePath: file, partBytes: 1000, backoffMs: 1 });
  assert.equal(flaky.calls.filter(c => c.name === 'UploadPartCommand' && c.input.PartNumber === 2).length, 2);
  assert.equal(flaky.parts.get(2).length, 1000, 'the retry re-read the part');
  assert.ok(!flaky.calls.some(c => c.name === 'AbortMultipartUploadCommand'));

  const broken = fakeS3({ failPart: { 3: 99 } });
  await assert.rejects(uploadFile(broken.send, { bucket: 'b', key: 'k', filePath: file, partBytes: 1000, tries: 3, backoffMs: 1 }), /socket hang up/);
  assert.equal(broken.calls.filter(c => c.input.PartNumber === 3).length, 3);
  assert.ok(broken.calls.some(c => c.name === 'AbortMultipartUploadCommand'), 'no orphaned parts left behind');
  assert.ok(!broken.calls.some(c => c.name === 'CompleteMultipartUploadCommand'));
});

// The production failure, end to end with the real SDK: a fake R2 that
// accepts bytes slowly but steadily. One PUT of the file outlasts
// requestTimeout and fails with the exact production error; the same file
// in parts succeeds because each part is a short request of its own.
let server, port;
const objects = new Map();
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', c => { chunks.push(c); req.pause(); setTimeout(() => req.resume(), 40); });   // ~1.5 MB/s, never idle
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>u1</UploadId></InitiateMultipartUploadResult>');
      }
      if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
        objects.set(`part:${url.searchParams.get('partNumber')}`, body);
        res.writeHead(200, { ETag: `"p${url.searchParams.get('partNumber')}"` });
        return res.end();
      }
      if (req.method === 'POST' && url.searchParams.has('uploadId')) {
        const n = (body.toString().match(/<PartNumber>/g) || []).length;
        objects.set('object', Buffer.concat(Array.from({ length: n }, (_, i) => objects.get(`part:${i + 1}`))));
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>');
      }
      res.writeHead(200, { ETag: '"single"' });
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server?.close());

const realClient = extra => new S3Client({
  ...extra,
  region: 'auto', endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 1500, throwOnRequestTimeout: true }),
});

test('real SDK: a steady upload longer than requestTimeout fails as one PUT and succeeds in parts', { timeout: 30_000 }, async () => {
  const file = fileOf(4 * 1024 * 1024, 'proxy.mp4');   // ≈2.7 s at the fake's pace; requestTimeout is 1.5 s
  const client = realClient();
  await assert.rejects(
    client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size })),
    /exceeded the configured 1500 ms requestTimeout/,
  );

  const partClient = realClient({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  const r = await uploadFile(cmd => client.send(cmd), {
    bucket: 'b', key: 'k', filePath: file, sendPart: cmd => partClient.send(cmd), partBytes: 512 * 1024, concurrency: 3, backoffMs: 10,
  });
  assert.equal(r.parts, 8);
  assert.ok(objects.get('object').equals(fs.readFileSync(file)), 'the assembled object is byte-identical');
});
