// Deletion and revocation (customer footage submission §10): every request
// with the inventory of what it touches — account, submissions, files,
// Command feeds and derived copies, evidence, public profiles, retention
// exceptions — and an admin decision that records each step's outcome.
// Files past their deletion date are listed here; nothing deletes on its own.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtBytes } from '../../lib/intake';
import { PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import { Panel, Tag, Toast } from './intakeShared';

const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };
const body = { color: '#e2e8f0' };
const STATUS_TONE = { open: '#fbbf24', completed: '#4ade80', declined: '#94a3b8' };

function target(r) {
  if (r.scope === 'account') return <span>Account · {r.account_email || `#${r.account_id}`}</span>;
  if (r.scope === 'submission') return <Link to={`/command/intake/${r.target_id}`} className="hover:underline" style={{ color: '#38bdf8' }} onClick={e => e.stopPropagation()}>Submission #{r.target_id}</Link>;
  return <span>File #{r.target_id}</span>;
}

export function IntakeDeletionsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canAct = ['admin', 'fulfillment'].includes(user.role);
  useEffect(() => { api.commandIntakeDeletions().then(setData).catch(err => setError(err.message)); }, []);

  async function openRetention(f) {
    setBusy(true); setError('');
    try {
      const { request } = await api.commandIntakeOpenDeletion({ scope: 'file', target_id: f.id, reason: 'retention_expired', note: `Retention date ${f.retention_deadline} passed` });
      navigate(`/command/intake/deletions/${request.id}`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div data-testid="deletions-page">
      <Link to="/command/intake" className="text-sm font-bold hover:underline" style={muted}>← Intake queue</Link>
      <h1 className="text-2xl font-bold text-white mt-3">Deletions &amp; retention</h1>
      <p className="text-sm mt-1 mb-5" style={muted}>Requests from customers and staff, and footage past its deletion date. An admin reviews what each request touches before anything is deleted; every step is recorded.</p>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <p style={muted}>Loading…</p> : (
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl border overflow-x-auto" style={cardStyle}>
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider" style={faint}>
                  <th className="px-4 py-3">Request</th><th className="px-4 py-3">What</th><th className="px-4 py-3">Why</th>
                  <th className="px-4 py-3">Asked by</th><th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center" style={muted}>No deletion requests.</td></tr>}
                {data.requests.map(r => (
                  <tr key={r.id} className="border-t cursor-pointer hover:bg-slate-800/40" style={{ borderColor: '#1e3a5f' }} onClick={() => navigate(`/command/intake/deletions/${r.id}`)} data-testid={`deletion-${r.id}`}>
                    <td className="px-4 py-3 font-bold text-white">#{r.id}<p className="text-xs font-normal" style={faint}>{fmtDate(r.created_at)}</p></td>
                    <td className="px-4 py-3" style={body}>{target(r)}</td>
                    <td className="px-4 py-3" style={body}>{r.reason.replace(/_/g, ' ')}{r.note && <p className="text-xs" style={faint}>{r.note}</p>}</td>
                    <td className="px-4 py-3" style={body}>{r.requested_by_kind}</td>
                    <td className="px-4 py-3"><b style={{ color: STATUS_TONE[r.status] }}>{r.status}</b>{r.decided_by_name && <p className="text-xs" style={faint}>{r.decided_by_name} · {fmtDate(r.decided_at)}</p>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Panel title="Past the retention date" testId="retention-due">
            {data.retention_due.length === 0 ? <p className="text-sm" style={muted}>No footage is past its deletion date.</p> : (
              <div className="flex flex-col">
                {data.retention_due.map(f => (
                  <div key={f.id} className="py-2.5 border-t first:border-t-0 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: '#1e3a5f' }}>
                    <div className="min-w-0">
                      <p className="text-sm text-white">{f.original_name} <span className="text-xs" style={faint}>{f.kind}{f.feed_id ? ` · feed #${f.feed_id}` : ''}</span></p>
                      <p className="text-xs" style={{ color: '#f87171' }}>Delete by {fmtDate(f.retention_deadline)} · <Link to={`/command/intake/${f.submission_id}`} className="font-mono hover:underline" style={{ color: '#38bdf8' }}>{f.public_id}</Link> · {f.email}</p>
                    </div>
                    {canAct && <GhostButton type="button" disabled={busy} onClick={() => openRetention(f)}>Open a request</GhostButton>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Inventory({ inv }) {
  if (!inv || !inv.files) return null;
  const renditions = (inv.renditions || []).reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] || 0) + 1 }), {});
  return (
    <div className="flex flex-col gap-4 text-sm" style={body} data-testid="inventory">
      {inv.account && (
        <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Account</p>
          <p>{inv.account.name} · {inv.account.email} · {inv.account.status} · {inv.account.sessions} active session{inv.account.sessions === 1 ? '' : 's'}</p></div>
      )}
      <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Submissions ({inv.submissions.length})</p>
        {inv.submissions.map(s => <p key={s.id}><Link to={`/command/intake/${s.id}`} className="font-mono hover:underline" style={{ color: '#38bdf8' }}>{s.public_id}</Link> · {s.status}{s.job_id ? ` · job #${s.job_id}` : ''}</p>)}</div>
      <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Uploaded files ({inv.files.length})</p>
        {inv.files.map(f => <p key={f.id}>{f.original_name} <span style={faint}>· {f.kind} · {fmtBytes(f.size_bytes)} · {f.status}{f.feed_id ? ` · feed #${f.feed_id}` : ''}{f.retention_deadline ? ` · delete by ${fmtDate(f.retention_deadline)}` : ''}</span></p>)}</div>
      <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Command copies</p>
        <p>{inv.feeds.length} feed{inv.feeds.length === 1 ? '' : 's'}{inv.feeds.length ? ` (${inv.feeds.map(f => `#${f.id} on job #${f.job_id}`).join(', ')})` : ''} · {Object.entries(renditions).map(([k, n]) => `${n} ${k}`).join(', ') || 'no derived files'}</p>
        {inv.jobs.map(j => <p key={j.id} style={muted}>Job #{j.id} {j.team_name} · {fmtDate(j.game_date)} · metrics {j.metric_release_status.replace(/_/g, ' ')}{j.synthetic ? ' · synthetic' : ''}</p>)}
        <p style={muted}>{inv.evidence.results} measured result{inv.evidence.results === 1 ? '' : 's'} cite this footage ({inv.evidence.published} published)</p></div>
      {inv.athletes.length > 0 && (
        <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Athletes on the account</p>
          <p>{inv.athletes.map(a => `${a.name}${a.is_public ? ' (public profile)' : ''}`).join(', ')}</p></div>
      )}
      {inv.retention_exceptions.length > 0 && (
        <div><p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: '#fbbf24' }}>Before you decide</p>
          {inv.retention_exceptions.map(x => <p key={x} style={{ color: '#fbbf24' }}>• {x}</p>)}</div>
      )}
    </div>
  );
}

export function IntakeDeletionRequestPage() {
  const { requestId } = useParams();
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [note, setNote] = useState('');
  const [steps, setSteps] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.commandIntakeDeletion(requestId).then(r => {
    setData(r);
    setChosen(prev => prev || {
      delete_media: true, revoke_consent: true,
      hide_profiles: (r.inventory?.public_profiles || []).length > 0,
      close_account: r.request.scope === 'account',
    });
  }), [requestId]);
  useEffect(() => { load().catch(err => setToast({ message: err.message, tone: 'error' })); }, [load]);

  if (!data || !chosen) return <><p style={muted}>Loading…</p><Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)} /></>;
  const r = data.request;
  const open = r.status === 'open';
  const result = steps || r.result?.steps;

  async function execute() {
    const actions = Object.keys(chosen).filter(k => chosen[k]);
    if (!window.confirm(`Execute ${actions.length} action${actions.length === 1 ? '' : 's'} for request #${r.id}? Deleted media cannot be recovered.`)) return;
    setBusy(true);
    try {
      const out = await api.commandIntakeExecuteDeletion(r.id, actions, note);
      setSteps(out.steps);
      const failed = out.steps.filter(x => !x.ok).length;
      setToast(failed ? { message: `${failed} step${failed === 1 ? '' : 's'} failed — the request stays open so you can retry.`, tone: 'error' } : { message: 'Deletion completed and recorded.' });
      await load();
    } catch (err) { setToast({ message: err.message, tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function decline() {
    if (!note.trim()) { setToast({ message: 'Record why the request is declined.', tone: 'error' }); return; }
    setBusy(true);
    try { await api.commandIntakeDeclineDeletion(r.id, note); setToast({ message: 'Request declined and recorded.' }); await load(); }
    catch (err) { setToast({ message: err.message, tone: 'error' }); }
    finally { setBusy(false); }
  }

  return (
    <div data-testid="deletion-request" data-status={r.status}>
      <Link to="/command/intake/deletions" className="text-sm font-bold hover:underline" style={muted}>← Deletions &amp; retention</Link>
      <div className="flex items-center gap-3 flex-wrap mt-3">
        <h1 className="text-2xl font-bold text-white">Deletion request #{r.id}</h1>
        <Tag color={STATUS_TONE[r.status]}>{r.status}</Tag>
      </div>
      <p className="text-sm mt-1 mb-5" style={muted}>
        {r.scope} · {r.reason.replace(/_/g, ' ')} · asked by {r.requested_by_kind} on {fmtDateTime(r.created_at)}{r.note ? ` — “${r.note}”` : ''}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-5 items-start">
        <Panel title={open ? 'What this request touches' : 'What it touched (at the decision)'}><Inventory inv={data.inventory} /></Panel>
        <div className="flex flex-col gap-5">
          {open && isAdmin && (
            <Panel title="Decision" testId="deletion-decision">
              <div className="flex flex-col gap-1">
                {Object.entries(data.actions).map(([k, label]) => {
                  const disabled = k === 'close_account' && r.scope !== 'account';
                  return (
                    <label key={k} className={`flex items-start gap-2 text-sm py-1 ${disabled ? 'opacity-50' : 'cursor-pointer'}`} style={body}>
                      <input type="checkbox" checked={!!chosen[k] && !disabled} disabled={disabled} onChange={e => setChosen(c => ({ ...c, [k]: e.target.checked }))} className="mt-1 accent-sky-400" data-testid={`action-${k}`} />
                      <span>{label}{disabled && <span className="block text-xs" style={faint}>Needs an account-wide request.</span>}</span>
                    </label>
                  );
                })}
              </div>
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Decision note (required to decline)"
                className="w-full mt-3 px-3 py-2 rounded-lg border text-white text-sm outline-none" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} />
              <div className="flex gap-2 mt-3">
                <PrimaryButton type="button" onClick={execute} disabled={busy || !Object.values(chosen).some(Boolean)} style={{ backgroundColor: '#f87171' }} data-testid="execute-deletion">Execute</PrimaryButton>
                <GhostButton type="button" onClick={decline} disabled={busy}>Decline</GhostButton>
              </div>
            </Panel>
          )}
          {open && !isAdmin && <Panel title="Decision"><p className="text-sm" style={muted}>An admin reviews and executes or declines deletion requests.</p></Panel>}
          {!open && (
            <Panel title="Decision">
              <p className="text-sm" style={body}>{r.status === 'completed' ? 'Executed' : 'Declined'} by {r.decided_by_name || `#${r.decided_by}`} on {fmtDateTime(r.decided_at)}</p>
              {r.actions.length > 0 && <p className="text-xs mt-1" style={muted}>Actions: {r.actions.map(a => a.replace(/_/g, ' ')).join(', ')}</p>}
              {r.decision_note && <p className="text-xs mt-1" style={muted}>“{r.decision_note}”</p>}
            </Panel>
          )}
          {result?.length > 0 && (
            <Panel title="Steps" testId="deletion-steps">
              {result.map((x, i) => (
                <p key={i} className="text-xs py-0.5" style={{ color: x.ok ? '#bbf7d0' : '#fecaca' }}>{x.ok ? '✓' : '✕'} {x.action.replace(/_/g, ' ')} — {x.target}{x.detail ? `: ${x.detail}` : ''}</p>
              ))}
            </Panel>
          )}
        </div>
      </div>
      <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}
