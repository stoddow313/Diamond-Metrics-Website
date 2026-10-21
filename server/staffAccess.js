// Staff access by email (coach/director dashboards, event booth logins): an
// assignment row keyed by email, and an invite link when that email has no
// staff account yet. Shared by index.js (teams, tournaments) and
// eventRoutes.js (events).
import { randomBytes } from 'node:crypto';

// Existing account → no invite needed, the assignment alone grants access.
export function upsertStaffInvite(db, email) {
  if (db.prepare('SELECT 1 FROM staff_users WHERE email = ?').get(email)) return null;
  const existing = db.prepare(
    `SELECT token FROM staff_invites WHERE email = ? AND claimed_at IS NULL AND expires_at > datetime('now')`
  ).get(email);
  if (existing) return existing.token;
  const token = randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO staff_invites (token, email, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`).run(token, email);
  return token;
}

// table / col are module constants at every call site, never request input.
export function accessList(db, table, col, id) {
  return db.prepare(
    `SELECT au.*, su.name AS claimed_name,
            CASE WHEN su.id IS NULL THEN 0 ELSE 1 END AS claimed,
            (SELECT token FROM staff_invites si WHERE si.email = au.email AND si.claimed_at IS NULL AND si.expires_at > datetime('now')) AS invite_token
     FROM ${table} au LEFT JOIN staff_users su ON su.email = au.email
     WHERE au.${col} = ? ORDER BY au.email`
  ).all(id);
}
