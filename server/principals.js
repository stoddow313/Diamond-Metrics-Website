// Who is calling. Every principal kind has its own session table, so a token
// minted for one kind can never satisfy another kind's guard:
//
//   internal  admins (admin | analyst | reviewer | fulfillment) — Command + Admin
//   player    player_users — an invite-claimed athlete portal (one player per login)
//   staff     staff_users — invite-claimed coach/director dashboards
//   customer  customer_accounts — self-serve footage submitters; one login
//             covers every athlete and team the person is linked to
//
// Lived inside index.js until the intake routes needed the same guards in
// their own modules and tests; the call sites in index.js are unchanged.
import { randomBytes } from 'node:crypto';

export const SESSION_TTL_DAYS = 30;
export const INTERNAL_ROLES = ['admin', 'analyst', 'reviewer', 'fulfillment'];

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function makePrincipals(db) {
  const mint = (table, column, id) => {
    const token = randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO ${table} (token, ${column}, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_TTL_DAYS} days'))`
    ).run(token, id);
    return token;
  };

  const createSession = adminId => mint('sessions', 'admin_id', adminId);
  const createPlayerSession = playerUserId => mint('player_sessions', 'player_user_id', playerUserId);
  const createStaffSession = staffUserId => mint('staff_sessions', 'staff_user_id', staffUserId);
  const createCustomerSession = accountId => mint('customer_sessions', 'account_id', accountId);

  // A deactivated internal account loses its existing sessions at once.
  function internalFromToken(token) {
    if (!token) return null;
    return db.prepare(
      `SELECT s.token, a.id, a.email, a.name, a.role FROM sessions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND a.active = 1`
    ).get(token) || null;
  }

  function playerFromToken(token) {
    if (!token) return null;
    return db.prepare(
      `SELECT ps.token, pu.id AS player_user_id, pu.email, p.*
       FROM player_sessions ps
       JOIN player_users pu ON pu.id = ps.player_user_id
       JOIN players p ON p.id = pu.player_id
       WHERE ps.token = ? AND ps.expires_at > datetime('now')`
    ).get(token);
  }

  function staffFromToken(token) {
    if (!token) return null;
    return db.prepare(
      `SELECT ss.token, su.id AS staff_user_id, su.email, su.name
       FROM staff_sessions ss JOIN staff_users su ON su.id = ss.staff_user_id
       WHERE ss.token = ? AND ss.expires_at > datetime('now')`
    ).get(token);
  }

  function customerFromToken(token) {
    if (!token) return null;
    return db.prepare(
      `SELECT cs.token, ca.* FROM customer_sessions cs
       JOIN customer_accounts ca ON ca.id = cs.account_id
       WHERE cs.token = ? AND cs.expires_at > datetime('now') AND ca.status = 'active'`
    ).get(token) || null;
  }

  function requireAdmin(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const row = internalFromToken(token);
    if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
    // Analysts/reviewers/fulfillment are internal but do not manage the admin surface.
    if (row.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    req.admin = { id: row.id, email: row.email, name: row.name, role: row.role };
    req.sessionToken = token;
    next();
  }

  // Command workspace access: any internal role.
  function requireInternal(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const row = internalFromToken(token);
    if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
    req.internal = { id: row.id, email: row.email, name: row.name, role: row.role };
    req.sessionToken = token;
    next();
  }

  // Internal + one of the named roles (least privilege for specific actions).
  const requireInternalRole = (...roles) => (req, res, next) => requireInternal(req, res, () => {
    if (!roles.includes(req.internal.role)) {
      return res.status(403).json({ error: `${roles.join(' or ')} role required` });
    }
    next();
  });

  function requirePlayer(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const row = playerFromToken(token);
    if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
    req.player = row;
    req.sessionToken = token;
    next();
  }

  function requireStaff(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const row = staffFromToken(token);
    if (!row) return res.status(401).json({ error: 'Session expired or invalid' });
    req.staff = row;
    req.sessionToken = token;
    next();
  }

  // Field Live playback gating: internal or player sessions only, exactly as
  // before the move. Self-serve customer accounts deliberately do not count —
  // anyone can create one, and "signed in" must not mean "may watch a stream".
  function currentUser(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const internal = internalFromToken(token);
    if (internal) return { kind: 'internal', id: internal.id, role: internal.role };
    const player = playerFromToken(token);
    return player ? { kind: 'player', id: player.player_user_id } : null;
  }

  return {
    createSession, createPlayerSession, createStaffSession, createCustomerSession,
    internalFromToken, playerFromToken, staffFromToken, customerFromToken,
    requireAdmin, requireInternal, requireInternalRole, requirePlayer, requireStaff, currentUser,
  };
}
