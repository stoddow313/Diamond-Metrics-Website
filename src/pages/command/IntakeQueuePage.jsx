// Will's intake queue (customer footage submission §8): every submission with
// its stage, who sent it, the athlete candidates, the game, files, consent,
// owner, last activity and the next action. Stage chips carry live counts.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Film, Paperclip } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { fmtDate, parseServerDate } from '../../lib/intake';
import { TextInput, Select, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { StageChip, FlagTags } from './intakeShared';
import { STAGES } from './intakeStages';

const OPEN = ['new', 'needs_identity_review', 'needs_customer_action', 'ready_for_job', 'in_analysis', 'metrics_released', 'game_record_pending'];
const faint = { color: '#64748b' };

// "due tomorrow 11:54 AM", "due Oct 9" — or how overdue it is.
function dueLabel(utc) {
  const d = parseServerDate(utc);
  if (!d) return '';
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `due today ${time}`;
  if (days === 1) return `due tomorrow ${time}`;
  if (days === -1) return `due yesterday ${time}`;
  return `due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export default function IntakeQueuePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const owner = params.get('owner') || '';
  const q = params.get('q') || '';
  const includeTest = params.get('test') !== '0';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(q);

  const set = (k, v) => setParams(p => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) set('q', search.trim()); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let live = true;
    const stage = view === 'open' || view === 'all' ? '' : view;
    api.commandIntakeQueue({ stage, owner: owner === 'mine' ? user.id : owner, q, include_test: includeTest ? '' : '0' })
      .then(r => { if (live) { setData(r); setError(''); } })
      .catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [view, owner, q, includeTest, user.id]);

  const rows = useMemo(() => (data ? (view === 'open' ? data.rows.filter(r => OPEN.includes(r.stage)) : data.rows) : []), [data, view]);
  const openCount = data ? OPEN.reduce((n, k) => n + (data.counts[k] || 0), 0) : 0;
  const chips = data ? [
    { key: 'open', label: 'Open', n: openCount },
    ...data.stages.filter(s => s.key !== 'draft').map(s => ({ key: s.key, label: STAGES[s.key]?.label || s.label, n: data.counts[s.key] || 0, hint: STAGES[s.key]?.tip })),
    { key: 'draft', label: 'Drafts', n: data.counts.draft || 0, hint: STAGES.draft.tip },
    { key: 'all', label: 'All' },
  ] : [];

  return (
    <div data-testid="intake-queue">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-white">Intake queue</h1>
          <InfoTip label="About the intake queue" size={16}>Customer footage submissions. Check identity and consent, then create or link the Command job. Every action is audited.</InfoTip>
        </div>
        <div className="flex gap-3 items-center text-sm font-bold">
          <Link to="/command/intake/deletions" className="hover:underline" style={{ color: '#38bdf8' }}>Deletions &amp; retention</Link>
          {user.role === 'admin' && <Link to="/command/team" className="hover:underline" style={{ color: '#38bdf8' }}>Team &amp; settings</Link>}
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap mb-4" role="tablist" aria-label="Stage">
        {chips.map(c => (
          <Tooltip key={c.key} content={c.hint} asChild>
            <button type="button" role="tab" aria-selected={view === c.key} onClick={() => set('view', c.key === 'open' ? '' : c.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border" data-testid={`stage-${c.key}`}
              style={view === c.key ? { backgroundColor: 'rgba(56, 189, 248, 0.15)', borderColor: '#38bdf8', color: '#38bdf8' } : { borderColor: '#1e3a5f', color: '#94a3b8' }}>
              {c.label}{c.n != null && <span className="ml-1.5" style={{ color: c.n ? '#e2e8f0' : '#475569' }}>{c.n}</span>}
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap mb-4 items-center">
        <div className="w-72 max-w-full"><TextInput value={search} onChange={e => setSearch(e.target.value)} placeholder="Search number, name, email, team, athlete…" aria-label="Search" /></div>
        <div className="w-52">
          <Select value={owner} onChange={e => set('owner', e.target.value)} aria-label="Owner">
            <option value="">Any owner</option>
            <option value="mine">Mine</option>
            <option value="unassigned">Unassigned</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs font-bold cursor-pointer" style={{ color: '#94a3b8' }}>
          <input type="checkbox" checked={includeTest} onChange={e => set('test', e.target.checked ? '' : '0')} className="accent-sky-400" />
          Show test
        </label>
      </div>

      <ErrorNote>{error}</ErrorNote>
      {!data ? <p style={{ color: '#94a3b8' }}>Loading…</p> : rows.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">Nothing here</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>{view === 'open' ? 'No open submissions. New ones land here as soon as a customer submits.' : 'No submissions match this filter.'}</p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-x-auto" style={cardStyle}>
          <table className="w-full text-sm min-w-[880px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={faint}>
                <th className="px-4 py-3">Submission</th>
                <th className="px-4 py-3">Submitter</th>
                <th className="px-4 py-3">Athletes</th>
                <th className="px-4 py-3">Game</th>
                <th className="px-4 py-3">Files</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const overdue = r.flags.includes('overdue');
                const flags = ['missing', 'revoked'].includes(r.consent) ? ['no_consent', ...r.flags] : r.flags;
                return (
                  <tr key={r.id} className="border-t cursor-pointer hover:bg-slate-800/40 align-top" style={{ borderColor: '#1e3a5f' }}
                    onClick={() => navigate(`/command/intake/${r.id}`)} data-testid={`row-${r.public_id}`}>
                    <td className="px-4 py-3">
                      <p className="font-bold text-white font-mono text-xs">{r.public_id}</p>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <StageChip stage={r.stage} focusable={false} />
                        <FlagTags flags={flags} synthetic={r.synthetic} focusable={false} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-white">{r.submitter.name}</p>
                      <p className="text-xs capitalize" style={faint}>{r.submitter.role}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p style={{ color: '#cfe8ff' }}>{r.athletes.names.join(', ') || <span style={{ color: '#475569' }}>—</span>}</p>
                      {r.athletes.unresolved > 0 && <p className="text-xs" style={{ color: '#fbbf24' }}>{r.athletes.unresolved} to resolve</p>}
                    </td>
                    <td className="px-4 py-3">
                      <p style={{ color: '#cfe8ff' }}>{r.team || '—'}{r.opponent ? ` vs ${r.opponent}` : ''}</p>
                      <p className="text-xs" style={faint}>
                        {[r.game_date && fmtDate(r.game_date), r.package_label].filter(Boolean).join(' · ')}
                        {r.job_id && <span style={{ color: '#38bdf8' }}> · Job #{r.job_id}</span>}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: '#94a3b8' }}>
                      {r.kind === 'inquiry' ? '—' : (
                        <span className="inline-flex items-center gap-2.5">
                          <Tooltip content={`${r.files.videos} video${r.files.videos === 1 ? '' : 's'}${r.files.checking ? ` · ${r.files.checking} being checked` : ''}${r.files.action ? ` · ${r.files.action} unreadable` : ''}`} focusable={false}>
                            <span className="inline-flex items-center gap-1" style={{ color: r.files.action ? '#f87171' : r.files.checking ? '#38bdf8' : '#94a3b8' }}><Film size={13} aria-hidden="true" />{r.files.videos}</span>
                          </Tooltip>
                          {r.files.supporting > 0 && (
                            <Tooltip content={`${r.files.supporting} supporting file${r.files.supporting === 1 ? '' : 's'}`} focusable={false}>
                              <span className="inline-flex items-center gap-1"><Paperclip size={13} aria-hidden="true" />{r.files.supporting}</span>
                            </Tooltip>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ color: '#cfe8ff' }}>{r.owner?.name || <span style={{ color: '#475569' }}>—</span>}</td>
                    <td className="px-4 py-3">
                      <p style={{ color: '#e2e8f0' }}>{r.next_action || '—'}</p>
                      {r.due_at && <p className="text-xs" style={{ color: overdue ? '#f87171' : '#64748b' }}>{dueLabel(r.due_at)}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
