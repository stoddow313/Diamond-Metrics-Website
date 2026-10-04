// The one sign-in endpoint for every principal kind, plus who-am-I and
// sign-out. Moved out of index.js so it can be tested with the routes that
// depend on it; behaviour is unchanged apart from the customer branch.
import { verifyPassword } from './db.js';
import { customerUser } from './customerAuth.js';
import { makeLimiter, rateLimit, clientIp } from './rateLimit.js';

export function mountAuthRoutes(app, { db, principals }) {
  const { createSession, createPlayerSession, createStaffSession, createCustomerSession, playerFromToken, staffFromToken, customerFromToken } = principals;

  // One login endpoint for all roles: admins, then players, then staff, then
  // self-serve customers. Limited per network and per email so a password
  // cannot be guessed at speed.
  const loginByIp = makeLimiter({ limit: 60, windowMs: 15 * 60 * 1000 });
  const loginByEmail = makeLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const loginLimits = rateLimit([
    { limiter: loginByIp, key: clientIp, message: 'Too many sign-in attempts from this network.' },
    { limiter: loginByEmail, key: req => String(req.body?.email || '').toLowerCase().trim() || null, message: 'Too many sign-in attempts for this email.' },
  ]);
  app.post('/api/auth/login', loginLimits, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const normEmail = String(email).toLowerCase().trim();

    const admin = db.prepare('SELECT * FROM admins WHERE email = ? AND active = 1').get(normEmail);
    if (admin && verifyPassword(password, admin.password_hash)) {
      const token = createSession(admin.id);
      return res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role || 'admin' } });
    }

    const pu = db.prepare(
      `SELECT pu.*, p.first_name, p.last_name, p.slug FROM player_users pu
       JOIN players p ON p.id = pu.player_id WHERE pu.email = ?`
    ).get(normEmail);
    if (pu && verifyPassword(password, pu.password_hash)) {
      const token = createPlayerSession(pu.id);
      return res.json({
        token,
        admin: { email: pu.email, name: `${pu.first_name} ${pu.last_name}`, role: 'player', slug: pu.slug },
      });
    }

    const su = db.prepare('SELECT * FROM staff_users WHERE email = ?').get(normEmail);
    if (su && verifyPassword(password, su.password_hash)) {
      const token = createStaffSession(su.id);
      return res.json({ token, admin: { email: su.email, name: su.name, role: 'staff' } });
    }

    // Self-serve customer accounts (footage intake). A contact linked from a
    // coach/player login has no password of its own and never matches here.
    const ca = db.prepare("SELECT * FROM customer_accounts WHERE email = ? AND status = 'active'").get(normEmail);
    if (ca?.password_hash && verifyPassword(password, ca.password_hash)) {
      const token = createCustomerSession(ca.id);
      return res.json({ token, admin: customerUser(ca) });
    }

    res.status(401).json({ error: 'Invalid email or password' });
  });

  app.get('/api/auth/me', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const adminRow = db.prepare(
      `SELECT a.id, a.email, a.name, a.role FROM sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND a.active = 1`
    ).get(token);
    if (adminRow) return res.json({ admin: { ...adminRow, role: adminRow.role || 'admin' } });

    const playerRow = playerFromToken(token);
    if (playerRow) {
      return res.json({
        admin: { email: playerRow.email, name: `${playerRow.first_name} ${playerRow.last_name}`, role: 'player', slug: playerRow.slug },
      });
    }

    const staffRow = staffFromToken(token);
    if (staffRow) {
      return res.json({ admin: { email: staffRow.email, name: staffRow.name, role: 'staff' } });
    }

    const customerRow = customerFromToken(token);
    if (customerRow) return res.json({ admin: customerUser(customerRow) });
    res.status(401).json({ error: 'Session expired or invalid' });
  });

  app.post('/api/auth/logout', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      db.prepare('DELETE FROM player_sessions WHERE token = ?').run(token);
      db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
      db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(token);
    }
    res.json({ ok: true });
  });
}
