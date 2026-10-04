// Self-serve customer accounts (customer footage submission §4): create an
// account, verify the email, reset a forgotten password, and the guard every
// intake route uses. Existing coach (staff) and player-portal logins work
// too: they resolve to the same contact record by email, so one person never
// ends up with two identities.
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from './db.js';
import { ROLES, normalizeEmail, isValidEmail, normalizePhone } from './intakeLogic.js';
import { addEvent, getAccount, provisionAccount, verifiedAthletes, verifiedTeams, accountView } from './intakeStore.js';
import { sendAccountEmail, publicUrl, emailConfigured } from './notifications.js';
import { makeLimiter, rateLimit, clientIp } from './rateLimit.js';
import { bearerToken } from './principals.js';

export const PASSWORD_MIN = 10;
const VERIFY_TTL_HOURS = 48;
const RESET_TTL_HOURS = 1;
const CONTACT_METHODS = ['email', 'text', 'phone'];

const hashToken = token => createHash('sha256').update(String(token)).digest('hex');

export function issueToken(db, accountId, purpose, ttlHours) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO customer_tokens (token_hash, account_id, purpose, expires_at) VALUES (?, ?, ?, datetime('now', '+${ttlHours} hours'))`
  ).run(hashToken(token), accountId, purpose);
  return token;
}

export function consumeToken(db, token, purpose) {
  const row = db.prepare(
    `SELECT *, (expires_at <= datetime('now')) AS expired FROM customer_tokens WHERE token_hash = ? AND purpose = ?`
  ).get(hashToken(token), purpose);
  if (!row) return { error: 'This link is not valid.' };
  if (row.used_at) return { error: 'This link has already been used.' };
  if (row.expired) return { error: 'This link has expired.' };
  db.prepare("UPDATE customer_tokens SET used_at = datetime('now') WHERE token_hash = ?").run(row.token_hash);
  return { accountId: row.account_id };
}

// What /api/auth/login and /api/auth/me return for a customer session.
export function customerUser(account) {
  return {
    id: account.id,
    email: account.email,
    name: `${account.first_name} ${account.last_name}`.trim() || account.email,
    role: 'customer',
    customer_role: account.role,
    email_verified: !!account.email_verified_at,
  };
}

export function markEmailVerified(db, accountId, { via, actorKind, actorId = null }) {
  const account = getAccount(db, accountId);
  if (!account || account.email_verified_at) return account;
  db.prepare("UPDATE customer_accounts SET email_verified_at = datetime('now'), verified_via = ?, updated_at = datetime('now') WHERE id = ?").run(via, accountId);
  addEvent(db, { accountId, actorKind, actorId, type: 'email_verified', message: via === 'staff' ? 'Email verified by staff (manual fallback)' : 'Email verified by link' });
  return getAccount(db, accountId);
}

export async function sendVerification(db, account) {
  const token = issueToken(db, account.id, 'verify_email', VERIFY_TTL_HOURS);
  return sendAccountEmail(db, { account, kind: 'verify_email', url: publicUrl(`/account/verify?token=${token}`) });
}

// The intake guard. Any of the three external login kinds may submit; each
// resolves to one customer_accounts row.
export function makeSubmitterGuard(db, principals) {
  function resolveSubmitter(token) {
    const customer = principals.customerFromToken(token);
    if (customer) return { account: customer, via: 'customer' };
    const staff = principals.staffFromToken(token);
    if (staff) {
      const [first = '', ...rest] = String(staff.name || '').trim().split(/\s+/);
      return { account: provisionAccount(db, { email: staff.email, first_name: first, last_name: rest.join(' '), role: 'coach', staff_user_id: staff.staff_user_id }), via: 'staff' };
    }
    const player = principals.playerFromToken(token);
    if (player) {
      return { account: provisionAccount(db, { email: player.email, role: 'parent', player_user_id: player.player_user_id, player_id: player.id }), via: 'player' };
    }
    return null;
  }

  function requireSubmitter(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Sign in to continue' });
    const resolved = resolveSubmitter(token);
    if (!resolved) return res.status(401).json({ error: 'Your session has expired — sign in again' });
    if (resolved.account.status !== 'active') return res.status(403).json({ error: 'This account is closed. Contact Diamond Metrics if you think that is a mistake.' });
    req.account = resolved.account;
    req.submitterVia = resolved.via;
    next();
  }

  return { resolveSubmitter, requireSubmitter };
}

export function mountCustomerAuthRoutes(app, { db, principals, requireSubmitter }) {
  const ipHour = makeLimiter({ limit: 20, windowMs: 60 * 60 * 1000 });
  const emailHour = makeLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
  const accountHour = makeLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
  const bodyEmail = req => normalizeEmail(req.body?.email) || null;

  app.post('/api/customer/signup',
    rateLimit([{ limiter: ipHour, key: clientIp, message: 'Too many sign-ups from this network.' }, { limiter: emailHour, key: bodyEmail }]),
    async (req, res) => {
      const b = req.body || {};
      const email = normalizeEmail(b.email);
      const first = String(b.first_name || '').trim();
      const last = String(b.last_name || '').trim();
      const role = String(b.role || '');
      if (!first || !last) return res.status(400).json({ error: 'Your first and last name are required' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      if (String(b.password || '').length < PASSWORD_MIN) return res.status(400).json({ error: `Choose a password of at least ${PASSWORD_MIN} characters` });
      if (!ROLES[role]) return res.status(400).json({ error: 'Choose your role' });
      const preferred = CONTACT_METHODS.includes(b.preferred_contact) ? b.preferred_contact : 'email';

      // One person, one login. An email that already signs in somewhere keeps
      // that login; its contact record is linked the first time it submits.
      const existing = db.prepare('SELECT password_hash FROM customer_accounts WHERE email = ?').get(email);
      if (existing?.password_hash) return res.status(409).json({ error: 'An account with this email already exists — sign in instead.', code: 'account_exists' });
      const otherLogin = existing
        || db.prepare('SELECT 1 FROM staff_users WHERE email = ?').get(email)
        || db.prepare('SELECT 1 FROM player_users WHERE email = ?').get(email)
        || db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email);
      if (otherLogin) return res.status(409).json({ error: 'This email already has a Diamond Metrics login — sign in with that password instead.', code: 'login_exists' });

      const phone = String(b.phone || '').trim();
      const id = db.prepare(
        `INSERT INTO customer_accounts (email, password_hash, first_name, last_name, phone, phone_normalized, role, preferred_contact, organization)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(email, hashPassword(String(b.password)), first, last, phone, normalizePhone(phone), role, preferred, String(b.organization || '').trim()).lastInsertRowid;
      addEvent(db, { accountId: id, actorKind: 'customer', actorId: id, type: 'account_created', message: `${ROLES[role].label} account created` });
      const account = getAccount(db, id);
      const token = principals.createCustomerSession(id);
      // Sending must not hold the response; the outcome is on the audit row.
      sendVerification(db, account).catch(() => {});
      res.status(201).json({ token, user: customerUser(account), email_delivery: emailConfigured() });
    });

  app.post('/api/customer/verify', rateLimit([{ limiter: ipHour, key: clientIp }]), (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ error: 'The verification link is incomplete.' });
    const r = consumeToken(db, token, 'verify_email');
    if (r.error) return res.status(400).json({ error: `${r.error} Sign in and request a new verification email.` });
    const account = markEmailVerified(db, r.accountId, { via: 'email_link', actorKind: 'customer', actorId: r.accountId });
    res.json({ ok: true, email: account.email });
  });

  app.post('/api/customer/resend-verification', requireSubmitter,
    rateLimit([{ limiter: accountHour, key: req => `verify:${req.account.id}`, message: 'Too many verification emails.' }]),
    async (req, res) => {
      if (req.account.email_verified_at) return res.status(400).json({ error: 'Your email is already verified.' });
      const r = await sendVerification(db, req.account);
      res.json({ ok: true, delivered: r.delivered, email_delivery: emailConfigured() });
    });

  // Never reveals whether an account exists.
  app.post('/api/customer/forgot-password',
    rateLimit([{ limiter: ipHour, key: clientIp }, { limiter: emailHour, key: req => `reset:${bodyEmail(req)}` }]),
    async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const account = isValidEmail(email) ? db.prepare("SELECT * FROM customer_accounts WHERE email = ? AND status = 'active'").get(email) : null;
      if (account?.password_hash) {
        // Without a provider sendAccountEmail logs the link in development
        // only — never in production, where anyone reading the logs could
        // take the account over.
        const token = issueToken(db, account.id, 'reset_password', RESET_TTL_HOURS);
        await sendAccountEmail(db, { account, kind: 'reset_password', url: publicUrl(`/account/reset?token=${token}`) });
      }
      res.json({ ok: true, email_delivery: emailConfigured() });
    });

  app.post('/api/customer/reset-password', rateLimit([{ limiter: ipHour, key: clientIp }]), (req, res) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Choose a password of at least ${PASSWORD_MIN} characters` });
    const r = consumeToken(db, token, 'reset_password');
    if (r.error) return res.status(400).json({ error: `${r.error} Request a new reset link.` });
    db.prepare("UPDATE customer_accounts SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(password), r.accountId);
    // Every existing session ends — a reset is how you lock out whoever else had it.
    db.prepare('DELETE FROM customer_sessions WHERE account_id = ?').run(r.accountId);
    addEvent(db, { accountId: r.accountId, actorKind: 'customer', actorId: r.accountId, type: 'password_reset', message: 'Password reset by email link; all sessions signed out' });
    // Following a reset link proves control of the inbox.
    markEmailVerified(db, r.accountId, { via: 'email_link', actorKind: 'customer', actorId: r.accountId });
    res.json({ ok: true });
  });

  app.get('/api/customer/me', requireSubmitter, (req, res) => {
    res.json({
      account: { ...accountView(req.account), via: req.submitterVia },
      athletes: verifiedAthletes(db, req.account.id),
      teams: verifiedTeams(db, req.account.id).map(t => ({ team_id: t.team_id, name: t.name, age_group: t.age_group, organization_name: t.organization_name })),
      email_delivery: emailConfigured(),
    });
  });

  app.put('/api/customer/me', requireSubmitter, (req, res) => {
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
    if ('first_name' in b) { const v = String(b.first_name || '').trim(); if (!v) return res.status(400).json({ error: 'First name is required' }); put('first_name', v); }
    if ('last_name' in b) { const v = String(b.last_name || '').trim(); if (!v) return res.status(400).json({ error: 'Last name is required' }); put('last_name', v); }
    if ('phone' in b) { const v = String(b.phone || '').trim(); put('phone', v); put('phone_normalized', normalizePhone(v)); }
    if ('role' in b) { if (!ROLES[b.role]) return res.status(400).json({ error: 'Choose a valid role' }); put('role', b.role); }
    if ('preferred_contact' in b) { if (!CONTACT_METHODS.includes(b.preferred_contact)) return res.status(400).json({ error: 'Choose email, text or phone' }); put('preferred_contact', b.preferred_contact); }
    if ('organization' in b) put('organization', String(b.organization || '').trim());
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    db.prepare(`UPDATE customer_accounts SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, req.account.id);
    addEvent(db, { accountId: req.account.id, actorKind: 'customer', actorId: req.account.id, type: 'profile_updated', message: `Updated ${Object.keys(b).filter(k => k !== 'email').join(', ')}` });
    res.json({ account: accountView(getAccount(db, req.account.id)) });
  });
}
