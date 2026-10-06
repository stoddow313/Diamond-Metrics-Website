// Test support for the intake suites (not a test file itself): a real Express
// app with the same route modules and guards index.js mounts, against the
// caller's temporary database. Callers set DM_DB_PATH / DM_STORAGE=local /
// DM_MEDIA_DIR before importing this module.
import express from 'express';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

export async function startIntakeApp() {
  const { db, hashPassword } = await import('./db.js');
  const { makePrincipals } = await import('./principals.js');
  const { mountAuthRoutes } = await import('./authRoutes.js');
  const { mountCommandRoutes } = await import('./commandRoutes.js');
  const { mountCommandMediaRoutes } = await import('./commandMediaRoutes.js');
  const { mountCustomerAuthRoutes, makeSubmitterGuard, issueToken } = await import('./customerAuth.js');
  const { mountIntakeRoutes, mountIntakeConfigRoute } = await import('./intakeRoutes.js');
  const { mountIntakeCommandRoutes } = await import('./intakeCommandRoutes.js');
  const { mountTeamRoutes } = await import('./teamRoutes.js');
  const { probeIntakeFile } = await import('./intakeMedia.js');
  const { mountTournamentCheckoutRoutes } = await import('./tournamentCheckoutRoutes.js');
  const { mountStripeWebhookRoutes } = await import('./stripeWebhookRoutes.js');
  const { mountPostPurchaseRoutes } = await import('./postPurchaseRoutes.js');
  const { mountTournamentOrderCommandRoutes } = await import('./tournamentOrderCommandRoutes.js');

  const app = express();
  // As in index.js: the Stripe webhook needs the raw body, so it precedes the JSON parser.
  mountStripeWebhookRoutes(app, { db });
  app.use(express.json({ limit: '8mb' }));
  const principals = makePrincipals(db);
  const { requireInternal, requireInternalRole } = principals;
  mountAuthRoutes(app, { db, principals });
  const { createJob } = mountCommandRoutes(app, { db, requireInternal });
  mountCommandMediaRoutes(app, { db, requireInternal });
  mountIntakeCommandRoutes(app, { db, requireInternal, requireInternalRole, createJob });
  mountTeamRoutes(app, { db, requireInternalRole });
  mountIntakeConfigRoute(app);
  const { requireSubmitter } = makeSubmitterGuard(db, principals);
  mountCustomerAuthRoutes(app, { db, principals, requireSubmitter });
  mountIntakeRoutes(app, { db, requireSubmitter });
  mountTournamentCheckoutRoutes(app, { db });
  mountPostPurchaseRoutes(app, { db });
  mountTournamentOrderCommandRoutes(app, { db, requireInternal });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, raw } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (raw) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers, body: payload });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  }

  let n = 0;
  function internal(role = 'admin', name = `${role} ${++n}`) {
    const id = db.prepare('INSERT INTO admins (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(`${role}${n}-${Date.now()}@dm.test`, name, hashPassword('internal-password-1'), role).lastInsertRowid;
    return { id, token: principals.createSession(id), role, name };
  }

  async function customer({ email = `parent${++n}@example.com`, role = 'parent', first = 'Pat', last = `Parent${n}`, verified = true, phone = '' } = {}) {
    const r = await call('POST', '/api/customer/signup', { body: { first_name: first, last_name: last, email, password: 'correct-horse-battery', role, phone } });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    if (verified) {
      const token = issueToken(db, r.body.user.id, 'verify_email', 1);
      const v = await call('POST', '/api/customer/verify', { body: { token } });
      if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
    }
    return { id: r.body.user.id, token: r.body.token, email };
  }

  const fingerprint = buf => `${createHash('sha256').update(buf.subarray(0, 1024 * 1024)).digest('hex')}:${buf.length}`;

  // Register → parts → complete through the real routes (local storage).
  async function upload(token, publicId, { kind = 'video', view = 'behind_home', name = 'game.mp4', bytes = Buffer.from('fake video bytes'), partSize = null, stopAfterPart = null } = {}) {
    const reg = await call('POST', `/api/intake/submissions/${publicId}/files`, {
      token, body: { kind, camera_view: view, original_name: name, size_bytes: bytes.length, content_hash: fingerprint(bytes), mime_type: kind === 'video' ? 'video/mp4' : 'text/csv' },
    });
    if (reg.status >= 400 || !reg.body.upload) return reg;
    const size = partSize || reg.body.upload.part_size;
    const done = new Set((reg.body.upload.uploaded_parts || []).map(p => p.partNumber));
    const parts = [];
    let sent = 0;
    for (let offset = 0, part = 1; offset < bytes.length; offset += size, part++) {
      if (done.has(part)) { parts.push({ partNumber: part }); continue; }
      if (stopAfterPart != null && sent >= stopAfterPart) return { ...reg, interrupted: true, sent };
      const r = await call('POST', `/api/intake/files/${reg.body.file.id}/parts/${part}`, { token, raw: bytes.subarray(offset, offset + size) });
      if (r.status !== 200) throw new Error(`part ${part}: ${JSON.stringify(r.body)}`);
      parts.push({ partNumber: part });
      sent++;
    }
    const done2 = await call('POST', `/api/intake/files/${reg.body.file.id}/complete`, { token, body: { uploadId: reg.body.upload.uploadId, parts } });
    return { ...done2, registered: reg.body, sent };
  }

  const META_1080P60 = { width: 1920, height: 1080, duration_s: 7200, effective_fps: 59.94, nominal_fps: 59.94, codec: 'h264', rotation: 0, vfr: 0 };
  async function probe(fileId, meta = META_1080P60) {
    const file = db.prepare('SELECT * FROM intake_files WHERE id = ?').get(fileId);
    return probeIntakeFile(db, file, { probe: async () => (meta instanceof Error ? Promise.reject(meta) : meta), sourceUrl: async k => k });
  }

  // A ready-to-submit draft: role, athletes, game, service, footage, terms.
  async function draft(token, { role = 'parent', athletes = [{ first_name: 'Rae', last_name: 'Runner', birth_year: 2014, relationship: 'parent' }], game = {}, service = {}, footage = {}, terms = true } = {}) {
    const c = await call('POST', '/api/intake/submissions', { token, body: { source_page: '/pricing', package_key: service.package_key || 'rookie' } });
    if (c.status !== 201) throw new Error(`draft failed: ${JSON.stringify(c.body)}`);
    const pid = c.body.submission.public_id;
    const form = {
      role, athletes,
      game: { date: '2026-09-20', event_label: 'Fall Classic', team_label: 'Canyon Athletics', opponent_label: 'Riverton', level: '12U', ...game },
      service: { package_key: 'rookie', ...service },
      footage: { coverage: 'full', orientation: 'landscape', ...footage },
    };
    const s = await call('PUT', `/api/intake/submissions/${pid}`, { token, body: { step: 'terms', form } });
    if (s.status !== 200) throw new Error(`save failed: ${JSON.stringify(s.body)}`);
    if (terms) {
      const r = await call('POST', `/api/intake/submissions/${pid}/rights`, { token, body: { uses: { analysis: true, results: true, improvement: false }, contact_permission: true, retention_ack: true, guide_ack: true, attest: true } });
      if (r.status !== 201) throw new Error(`rights failed: ${JSON.stringify(r.body)}`);
    }
    return pid;
  }

  const sub = pid => db.prepare('SELECT * FROM intake_submissions WHERE public_id = ?').get(pid);

  return { db, app, principals, call, internal, customer, upload, probe, draft, sub, base, META_1080P60, fingerprint, close: () => new Promise(r => server.close(r)) };
}
