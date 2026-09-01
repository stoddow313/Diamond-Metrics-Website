// Localhost media gateway for the worker's ffmpeg/ffprobe input.
//
// Static ffmpeg builds are unreliable about TLS (the bundled linux build —
// a 2018 johnvansickle snapshot — fails instantly on https R2 URLs, while
// the darwin build streams them fine). Instead of depending on each
// platform's binary having working TLS, the worker serves sources over
// plain HTTP on 127.0.0.1 and Node does the R2/TLS legwork. Every ffmpeg
// ever built speaks http/1.1; Range passthrough keeps moov-at-end MP4s
// seekable, and nothing is ever copied to local disk.
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { storageMode, localPathFor, getObjectRange } from './storage.js';
import { log, captureError } from './observability.js';

const SECRET = randomBytes(16).toString('hex');   // per-process; gateway dies with it
const sign = key => createHmac('sha256', SECRET).update(key).digest('hex').slice(0, 32);

let serverPromise = null;

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1] === '') {                                   // suffix range: last N bytes
    const n = Number(m[2]);
    if (size == null) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  return { start, end };
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.replace(/^\/src\//, ''));
    if (!key || url.searchParams.get('t') !== sign(key)) {
      res.writeHead(403).end();
      return;
    }

    if (storageMode !== 'r2') {
      const filePath = localPathFor(key);
      const size = fs.statSync(filePath).size;
      const range = parseRange(req.headers.range, size);
      if (range) {
        const end = range.end == null ? size - 1 : Math.min(range.end, size - 1);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath, { start: range.start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }

    const rangeHeader = req.headers.range || null;
    // Bound the wait for R2's first byte. Without it one unanswered request
    // parks ffmpeg forever — the encoder has no idea the upstream is gone.
    const ac = new AbortController();
    const firstByte = setTimeout(() => ac.abort(new Error(`storage did not answer within ${UPSTREAM_TIMEOUT_MS} ms`)), UPSTREAM_TIMEOUT_MS);
    let obj;
    try { obj = await getObjectRange(key, rangeHeader, { abortSignal: ac.signal }); }
    finally { clearTimeout(firstByte); }
    if (req.destroyed || res.destroyed) { destroyBody(obj.body); return; }
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (obj.contentLength != null) headers['Content-Length'] = obj.contentLength;
    if (obj.contentRange) headers['Content-Range'] = obj.contentRange;
    res.writeHead(obj.contentRange ? 206 : 200, headers);
    pipeUpstream(obj.body, res);
  } catch (err) {
    captureError(err, { event: 'media_gateway_error', component: 'media_gateway', url: String(req.url).split('?')[0], range: req.headers.range || null });
    if (!res.headersSent) res.writeHead(err.name === 'AbortError' || /did not answer/.test(String(err.message)) ? 504 : 502);
    res.end();
  }
}

// Seconds R2 may take to start answering one ranged read.
export const UPSTREAM_TIMEOUT_MS = Number(process.env.DM_GATEWAY_UPSTREAM_TIMEOUT_MS || 30_000);

function destroyBody(body) {
  try { if (body && !body.destroyed) body.destroy(); } catch { /* already gone */ }
}

// ffmpeg seeks by dropping the connection and opening a new one. pipe() stops
// writing when the client goes, but it does NOT end the upstream read — the
// R2 response sat half-consumed on a keep-alive socket that was never
// returned to the SDK's pool (50 of them). Once the pool is exhausted every
// later read waits for a socket that never frees — the most likely way a
// 17-second clip hung in 'processing' for days after 26 jobs' worth of
// seeks. Tear the upstream down with the client, every time.
export function pipeUpstream(body, res) {
  body.pipe(res);
  body.on('error', () => res.destroy());
  const teardown = () => destroyBody(body);
  res.on('close', teardown);
  res.on('error', teardown);
}

// Lazy singleton on an ephemeral 127.0.0.1 port.
export function startMediaGateway() {
  if (!serverPromise) {
    serverPromise = new Promise((resolve, reject) => {
      const server = http.createServer(handle);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        log('info', 'media_gateway_started', { port });
        resolve({ port, server });
      });
      server.unref();
    });
  }
  return serverPromise;
}

// Plain-HTTP source URL for ffmpeg/ffprobe input.
export async function gatewayUrlFor(key) {
  const { port } = await startMediaGateway();
  return `http://127.0.0.1:${port}/src/${encodeURIComponent(key)}?t=${sign(key)}`;
}
