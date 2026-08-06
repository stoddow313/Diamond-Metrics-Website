import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Field, TextInput, PrimaryButton, GhostButton } from './ui';
import { cardStyle } from './theme';

// Assign coach/director access by email. If the email has no staff account
// yet, an invite link is generated to claim one (mirrors player invites).
export default function AccessPanel({ kind, id, title, subtitle, onError }) {
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState('');
  const [copiedToken, setCopiedToken] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.getAccess(kind, id).then(d => setRows(d.access)).catch(err => onError(err.message));
  }, [kind, id, tick, onError]);

  async function add(e) {
    e.preventDefault();
    try {
      await api.addAccess(kind, id, email.trim());
      setEmail('');
      setTick(t => t + 1);
    } catch (err) { onError(err.message); }
  }

  async function copyInvite(token) {
    await navigator.clipboard.writeText(`${window.location.origin}/claim-staff/${token}`);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(''), 2000);
  }

  return (
    <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
      <h2 className="text-lg font-bold text-white mb-1">{title}</h2>
      <p className="text-xs mb-4" style={{ color: '#94a3b8' }}>{subtitle}</p>

      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Email">
          <TextInput type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="coach@example.com" style={{ minWidth: 260 }} />
        </Field>
        <PrimaryButton type="submit">+ Grant access</PrimaryButton>
      </form>

      {rows === null ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>Nobody has access yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-bold text-white">{r.email}</span>
              <span className="text-xs uppercase px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>{r.role}</span>
              {r.claimed ? (
                <span className="text-xs font-bold" style={{ color: '#4ade80' }}>✓ Claimed{r.claimed_name ? ` — ${r.claimed_name}` : ''}</span>
              ) : r.invite_token ? (
                <GhostButton type="button" onClick={() => copyInvite(r.invite_token)} style={{ padding: '3px 10px', fontSize: 12 }}>
                  {copiedToken === r.invite_token ? 'Copied ✓' : 'Copy invite link'}
                </GhostButton>
              ) : (
                <span className="text-xs" style={{ color: '#64748b' }}>invite expired — remove & re-add</span>
              )}
              <button
                className="text-xs cursor-pointer hover:underline"
                style={{ color: '#64748b' }}
                onClick={async () => {
                  if (!confirm(`Remove ${r.email}'s access?`)) return;
                  try { await api.removeAccess(kind, r.id); setTick(t => t + 1); }
                  catch (err) { onError(err.message); }
                }}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
