// Command logins (admin only): give fulfillment staff such as Will their own
// least-privilege login, change roles, deactivate, reset passwords, and choose
// who owns new intake submissions by default. Every change is audited.
import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/intake';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import { Panel, Tag, Toast } from './intakeShared';

const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };
const PASSWORD_MIN = 12;

// A readable temporary password to hand over in person or by phone.
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length);   // reject the biased tail
  let out = '';
  while (out.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < 16) out += alphabet[b % alphabet.length];
    }
  }
  return out.replace(/(.{4})(?!$)/g, '$1-');
}

export default function TeamPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'fulfillment', password: '' });
  const [resetFor, setResetFor] = useState(null);
  const [resetPw, setResetPw] = useState('');

  useEffect(() => {
    Promise.all([api.commandTeam(), api.commandIntakeSettings()])
      .then(([t, s]) => { setData(t); setSettings(s); })
      .catch(err => setError(err.message));
  }, []);

  async function run(fn, ok) {
    setBusy(true);
    try { const r = await fn(); if (r?.members) setData(d => ({ ...d, members: r.members })); setToast({ message: ok }); return r; }
    catch (err) { setToast({ message: err.message, tone: 'error' }); return null; }
    finally { setBusy(false); }
  }

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data || !settings) return <p style={muted}>Loading…</p>;
  const active = data.members.filter(m => m.active);

  async function create(e) {
    e.preventDefault();
    const r = await run(() => api.commandTeamCreate(form), `Login created for ${form.name}. Share the temporary password with them directly.`);
    if (r) setForm({ name: '', email: '', role: 'fulfillment', password: '' });
  }

  return (
    <div data-testid="team-page">
      <h1 className="text-2xl font-bold text-white">Team &amp; settings</h1>
      <p className="text-sm mt-1 mb-6" style={muted}>Internal Command logins. Give each person the least access that does their job.</p>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] gap-6 items-start">
        <div className="rounded-2xl border overflow-x-auto" style={cardStyle}>
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={faint}>
                <th className="px-4 py-3">Person</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Password</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map(m => {
                const self = m.id === user.id;
                return (
                  <tr key={m.id} className="border-t align-top" style={{ borderColor: '#1e3a5f', opacity: m.active ? 1 : 0.6 }} data-testid={`member-${m.email}`}>
                    <td className="px-4 py-3">
                      <p className="font-bold text-white">{m.name}{self && <span className="ml-2"><Tag color="#38bdf8">you</Tag></span>}</p>
                      <p className="text-xs" style={faint}>{m.email} · since {fmtDate(m.created_at)}</p>
                    </td>
                    <td className="px-4 py-3 w-48">
                      <Select value={m.role} disabled={self || busy} onChange={e => run(() => api.commandTeamUpdate(m.id, { role: e.target.value }), `${m.name} is now ${e.target.value}`)}>
                        {data.roles.map(r => <option key={r.key} value={r.key}>{r.key}</option>)}
                      </Select>
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" disabled={self || busy} onClick={() => (m.active ? window.confirm(`Deactivate ${m.name}? They are signed out at once.`) : true) && run(() => api.commandTeamUpdate(m.id, { active: !m.active }), m.active ? `${m.name} deactivated` : `${m.name} reactivated`)}
                        className="text-xs font-bold hover:underline cursor-pointer disabled:cursor-default disabled:no-underline" style={{ color: m.active ? '#4ade80' : '#94a3b8' }}>
                        {m.active ? 'Active' : 'Deactivated'}{!self && <span style={faint}> · {m.active ? 'deactivate' : 'reactivate'}</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {resetFor === m.id ? (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex gap-1.5"><TextInput value={resetPw} onChange={e => setResetPw(e.target.value)} placeholder={`${PASSWORD_MIN}+ characters`} aria-label={`New password for ${m.name}`} /><GhostButton type="button" onClick={() => setResetPw(temporaryPassword())}>Generate</GhostButton></div>
                          <div className="flex gap-1.5">
                            <GhostButton type="button" disabled={busy || resetPw.length < PASSWORD_MIN} onClick={async () => { if (await run(() => api.commandTeamUpdate(m.id, { password: resetPw }), `Password reset for ${m.name}${self ? '' : ' — they were signed out'}`)) { setResetFor(null); setResetPw(''); } }}>Save</GhostButton>
                            <GhostButton type="button" onClick={() => { setResetFor(null); setResetPw(''); }}>Cancel</GhostButton>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => { setResetFor(m.id); setResetPw(''); }} className="text-xs font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Reset password</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-6">
          <Panel title="Add a person" testId="add-member">
            <form onSubmit={create} className="flex flex-col gap-3">
              <Field label="Name"><TextInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></Field>
              <Field label="Email (their sign-in)"><TextInput type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></Field>
              <Field label="Role">
                <div className="flex flex-col gap-1.5">
                  {data.roles.map(r => (
                    <label key={r.key} className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: '#e2e8f0' }}>
                      <input type="radio" name="role" checked={form.role === r.key} onChange={() => setForm(f => ({ ...f, role: r.key }))} className="mt-1 accent-sky-400" />
                      <span><b>{r.key}</b> <span className="text-xs" style={muted}>— {r.description}</span></span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field label={`Temporary password (${PASSWORD_MIN}+ characters)`}>
                <div className="flex gap-1.5">
                  <TextInput value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required minLength={PASSWORD_MIN} aria-label="Temporary password" />
                  <GhostButton type="button" onClick={() => setForm(f => ({ ...f, password: temporaryPassword() }))}>Generate</GhostButton>
                </div>
                <p className="text-xs mt-1" style={faint}>Give it to them in person or by phone — not by email. They can’t change it themselves yet, so reset it here if needed.</p>
              </Field>
              <PrimaryButton type="submit" disabled={busy}>Create login</PrimaryButton>
            </form>
          </Panel>

          <Panel title="Intake" testId="intake-settings">
            <Field label="Who owns new submissions">
              <Select value={settings.default_owner_id || ''} disabled={busy}
                onChange={async e => {
                  const r = await run(() => api.commandIntakeUpdateSettings({ default_owner_id: e.target.value ? Number(e.target.value) : null }), 'Default owner saved');
                  if (r) setSettings(r);
                }}>
                <option value="">Nobody — they arrive unassigned</option>
                {active.map(m => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
              </Select>
            </Field>
            <p className="text-xs mt-2" style={faint}>Each new submission is assigned to this person, with a due time for its first review.</p>
          </Panel>
        </div>
      </div>
      <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}
