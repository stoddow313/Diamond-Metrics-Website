// Command M6: structured logs + error capture.
//
// Logs are single-line JSON so Render's log drain (or any collector) can
// parse them without a shipper. Error capture posts to Sentry when
// SENTRY_DSN is set — via Sentry's documented store endpoint, so the
// service stays dependency-free and the SDK is never a deploy risk.
// Without a DSN, errors still land in the structured log.
import { randomUUID } from 'node:crypto';

export const ENV = process.env.DM_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
const RELEASE = process.env.RENDER_GIT_COMMIT || process.env.DM_RELEASE || 'dev';
const SILENT = process.env.DM_LOG_SILENT === '1';   // tests

export function log(level, event, fields = {}) {
  if (SILENT) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, env: ENV, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

// DSN: https://<publicKey>@<host>/<projectId>
export function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    return { endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`, publicKey: url.username };
  } catch {
    return null;
  }
}

const SENTRY = parseDsn(process.env.SENTRY_DSN);
export const errorTrackingEnabled = Boolean(SENTRY);

export function sentryEvent(err, { context = {}, level = 'error' } = {}) {
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level,
    environment: ENV,
    release: RELEASE,
    server_name: process.env.RENDER_SERVICE_NAME || 'diamond-metrics-api',
    exception: {
      values: [{
        type: err?.name || 'Error',
        value: String(err?.message || err),
        stacktrace: { frames: framesFrom(err) },
      }],
    },
    tags: { component: context.component || 'api' },
    extra: context,
  };
}

// Sentry wants oldest frame first; keep it small — stacks are for triage.
function framesFrom(err) {
  const lines = String(err?.stack || '').split('\n').slice(1, 16).reverse();
  return lines.map(l => {
    const m = l.match(/at (.+?) \((.+?):(\d+):(\d+)\)/) || l.match(/at (.+?):(\d+):(\d+)/);
    if (!m) return { function: l.trim() };
    return m.length === 5
      ? { function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }
      : { filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) };
  });
}

export function captureError(err, context = {}) {
  log('error', context.event || 'unhandled_error', {
    message: String(err?.message || err),
    stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | '),
    ...context,
  });
  if (!SENTRY) return;
  // Fire-and-forget: telemetry must never delay or fail a request.
  fetch(SENTRY.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${SENTRY.publicKey}, sentry_client=diamond-metrics/1.0`,
    },
    body: JSON.stringify(sentryEvent(err, { context })),
  }).catch(sendErr => log('warn', 'error_tracking_failed', { message: String(sendErr?.message || sendErr) }));
}

// Request timing. Health checks are noise — Render polls them constantly.
export function requestLogger(req, res, next) {
  if (req.path === '/api/health') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode,
      ms: Number(ms.toFixed(1)),
      role: req.internal?.role,
    });
  });
  next();
}

// Terminal error handler: nothing escapes without a log + capture. Express
// identifies error middleware by arity, so the 4th parameter must stay.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  captureError(err, { event: 'request_failed', method: req.method, path: req.path, role: req.internal?.role });
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
}

export function installProcessHandlers() {
  process.on('unhandledRejection', reason => captureError(reason, { event: 'unhandled_rejection' }));
  process.on('uncaughtException', err => {
    captureError(err, { event: 'uncaught_exception' });
    // Let the platform restart us — a process in an unknown state is worse.
    setTimeout(() => process.exit(1), 250).unref();
  });
}
