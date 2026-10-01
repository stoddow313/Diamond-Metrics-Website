// Internal team (Command logins). Until now the only internal account was the
// seeded admin; fulfillment staff such as Will need their own login with the
// least privilege that does the job (owner decision 2026-10-01). Admin only.
import { hashPassword } from './db.js';
import { INTERNAL_ROLES } from './principals.js';
import { normalizeEmail, isValidEmail } from './intakeLogic.js';
import { settingValue } from './intakeStore.js';

export const ROLE_DESCRIPTIONS = {
  admin: 'Everything: Admin, approvals and releases, deletions, and this page.',
  reviewer: 'Approves and releases metrics and game records.',
  analyst: 'Measures, scores and tags in Command; cannot approve or release.',
  fulfillment: 'Works the intake queue and creates or links Command jobs; cannot approve or release.',
};
const PASSWORD_MIN = 12;

export function mountTeamRoutes(app, { db, requireInternalRole }) {
  const adminOnly = requireInternalRole('admin');
  const audit = (targetId, actorId, action, note) => db.prepare(
    "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('admins', ?, ?, ?, ?)"
  ).run(targetId, actorId, action, note);
  const members = () => db.prepare('SELECT id, email, name, role, active, created_at FROM admins ORDER BY active DESC, name').all();
  const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM admins WHERE role = 'admin' AND active = 1").get().n;

  app.get('/api/command/team', adminOnly, (_req, res) => {
    res.json({
      members: members(),
      roles: INTERNAL_ROLES.map(key => ({ key, description: ROLE_DESCRIPTIONS[key] })),
      intake_default_owner_id: Number(settingValue(db, 'intake_default_owner_id')) || null,
    });
  });

  app.post('/api/command/team', adminOnly, (req, res) => {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    const name = String(b.name || '').trim();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!INTERNAL_ROLES.includes(b.role)) return res.status(400).json({ error: `role must be one of ${INTERNAL_ROLES.join(', ')}` });
    if (String(b.password || '').length < PASSWORD_MIN) return res.status(400).json({ error: `Set a temporary password of at least ${PASSWORD_MIN} characters` });
    if (db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email)) return res.status(409).json({ error: 'An internal login with this email already exists' });
    const id = db.prepare('INSERT INTO admins (email, name, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(email, name, hashPassword(String(b.password)), b.role, req.internal.id).lastInsertRowid;
    audit(id, req.internal.id, 'created', `${name} <${email}> as ${b.role}`);
    res.status(201).json({ members: members() });
  });

  app.put('/api/command/team/:id', adminOnly, (req, res) => {
    const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const self = target.id === req.internal.id;
    const changes = [];
    if ('role' in b && b.role !== target.role) {
      if (!INTERNAL_ROLES.includes(b.role)) return res.status(400).json({ error: `role must be one of ${INTERNAL_ROLES.join(', ')}` });
      if (self) return res.status(409).json({ error: 'You cannot change your own role' });
      if (target.role === 'admin' && target.active && activeAdmins() <= 1) return res.status(409).json({ error: 'This is the last active admin' });
      db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(b.role, target.id);
      changes.push(`role ${target.role} → ${b.role}`);
    }
    if ('active' in b && !!b.active !== !!target.active) {
      if (self) return res.status(409).json({ error: 'You cannot deactivate yourself' });
      if (!b.active && target.role === 'admin' && activeAdmins() <= 1) return res.status(409).json({ error: 'This is the last active admin' });
      db.prepare('UPDATE admins SET active = ? WHERE id = ?').run(b.active ? 1 : 0, target.id);
      // Deactivation ends existing sessions at once (they are refused anyway).
      if (!b.active) db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
      changes.push(b.active ? 'reactivated' : 'deactivated');
    }
    if ('name' in b && String(b.name || '').trim() && b.name !== target.name) {
      db.prepare('UPDATE admins SET name = ? WHERE id = ?').run(String(b.name).trim(), target.id);
      changes.push('name');
    }
    if ('password' in b && b.password) {
      if (String(b.password).length < PASSWORD_MIN) return res.status(400).json({ error: `Passwords need at least ${PASSWORD_MIN} characters` });
      db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), target.id);
      if (!self) db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
      changes.push('password reset');
    }
    if (!changes.length) return res.status(400).json({ error: 'Nothing to change' });
    audit(target.id, req.internal.id, 'updated', changes.join('; '));
    res.json({ members: members() });
  });
}
