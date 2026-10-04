// One customer submission as Will sees it (customer footage submission §8–§10):
// the task, identity decisions with candidates and reasons, the game and
// duplicate signals, files with their technical check, consent records,
// customer messages kept apart from internal notes, the audit timeline, and
// the hand-off into Command — create or link the job. Reading is open to every
// internal role; acting needs fulfillment or admin. Detail that is only
// sometimes needed (match reasons, probe output, consent wording) lives in
// tooltips so the page reads at a glance.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BadgeCheck, Check, Eye, Lock, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtBytes, timeAgo, parseServerDate } from '../../lib/intake';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { Issues } from '../intake/ui';
import { StageChip, FlagTags, Tag, Panel, Toast } from './intakeShared';
import { STAGES } from './intakeStages';

const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };
const body = { color: '#e2e8f0' };
const STATUS_LABEL = { ...Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.label])), linked: 'Linked to a job' };
const PAYMENT_LABEL = { unconfirmed: 'Not confirmed', confirmed: 'Confirmed', not_required: 'Not required', waived: 'Waived' };
const RESOLUTION = {
  pending: ['Needs a decision', '#fbbf24'], deferred: ['Deferred', '#fbbf24'], linked_existing: ['Linked to existing player', '#4ade80'],
  new_player: ['New private player', '#4ade80'], guest: ['Guest placeholder', '#94a3b8'],
};
const CONFIDENCE_TONE = { high: '#4ade80', medium: '#fbbf24', low: '#94a3b8' };
const USE_LABEL = { analysis: 'Analysis', results: 'Share results', improvement: 'Improve tools' };
const WARNING_LABEL = { unreadable_file: 'Unreadable file', payment_unconfirmed: 'Payment unconfirmed', email_unverified: 'Email unverified', draft_terms: 'Draft terms' };

function TextArea(props) {
  return <textarea rows={3} {...props} className="w-full px-3 py-2 rounded-lg border text-white text-sm outline-none focus:border-sky-400" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} />;
}

TextArea.labelable = true;

// A small rounded chip; `tip` explains it.
function Chip({ children, color = '#94a3b8', tip, icon: Icon, testId }) {
  const chip = (
    <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color }} data-testid={testId}>
      {Icon && <Icon size={12} strokeWidth={2.4} aria-hidden="true" />}{children}
    </span>
  );
  return tip ? <Tooltip content={tip} className="rounded-full">{chip}</Tooltip> : chip;
}

// A link-styled button that opens a small form in place.
function Reveal({ label, children, open, onOpen }) {
  return open ? children : (
    <button type="button" onClick={onOpen} className="text-xs font-bold hover:underline cursor-pointer self-start" style={muted}>{label}</button>
  );
}

const pad = n => String(n).padStart(2, '0');
const toLocalInput = utc => {
  const d = parseServerDate(utc);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
};
const toUtc = local => (local ? new Date(local).toISOString().slice(0, 19).replace('T', ' ') : null);

export default function IntakeRecordPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const canAct = ['admin', 'fulfillment'].includes(user.role);
  const isAdmin = user.role === 'admin';
  const [rec, setRec] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.commandIntakeRecord(id).then(r => { setRec(r); return r; }), [id]);
  useEffect(() => { load().catch(err => setLoadError(err.message)); }, [load]);
  const checking = !!rec?.files.some(f => ['uploaded', 'processing'].includes(f.status));
  useEffect(() => {
    if (!checking) return undefined;
    const t = setInterval(() => { load().catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [checking, load]);

  // Every action returns the refreshed record (or we re-read it).
  const act = useCallback(async (fn, ok) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.submission) setRec(r); else await load();
      if (ok) setToast({ message: typeof ok === 'function' ? ok(r) : ok });
      return r || true;
    } catch (err) {
      setToast({ message: err.message, tone: 'error' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!rec) return <p style={muted}>Loading…</p>;
  const s = rec.submission;
  const flags = [
    s.escalated_at && 'escalated', s.payment_status === 'unconfirmed' && s.kind === 'footage' && 'payment_unconfirmed',
    !rec.account.email_verified && 'email_unverified', s.kind === 'inquiry' && 'hall_of_fame',
  ].filter(Boolean);
  const shared = { rec, act, canAct, isAdmin, busy };

  return (
    <div data-testid="intake-record" data-stage={s.stage}>
      <Link to="/command/intake" className="text-sm font-bold hover:underline" style={muted}>← Intake queue</Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mt-3 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-white font-mono">{s.public_id}</h1>
            <StageChip stage={s.stage} />
            <FlagTags flags={flags} synthetic={!!s.synthetic} />
          </div>
          <p className="text-sm mt-1" style={muted}>
            {s.kind === 'inquiry' ? 'Hall of Fame request' : s.package?.label || 'No package'} · {rec.account.first_name} {rec.account.last_name} ({rec.account.role_label}) ·{' '}
            {s.submitted_at
              ? <Tooltip content={s.source_page ? `Started from the “${s.source_page}” link` : null}><span>{fmtDateTime(s.submitted_at)}</span></Tooltip>
              : 'not submitted yet'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip icon={Eye} color="#7dd3fc" tip={s.customer_status.detail} testId="customer-sees">Customer sees: {s.customer_status.label}</Chip>
          {!canAct && <Tag color="#94a3b8">read only — {user.role}</Tag>}
        </div>
      </div>

      {s.escalated_at && (
        <div className="rounded-xl border px-4 py-3 mb-5 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: '#f87171', backgroundColor: 'rgba(239, 68, 68, 0.08)' }}>
          <p className="text-sm" style={{ color: '#fecaca' }}>Escalated to an admin {timeAgo(s.escalated_at)} — the timeline says what needs deciding.</p>
          {isAdmin && <GhostButton type="button" disabled={busy} onClick={() => act(() => api.commandIntakeUpdate(s.id, { escalated: false }), 'Escalation cleared')}>Clear escalation</GhostButton>}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <JobPanel {...shared} />
          <AthletesPanel {...shared} />
          <GamePanel {...shared} />
          <FilesPanel {...shared} />
          <CommunicatePanel {...shared} />
          <TimelinePanel rec={rec} />
        </div>
        <div className="flex flex-col gap-5 min-w-0">
          <TaskPanel {...shared} />
          <ContactPanel {...shared} />
          <RightsPanel rec={rec} />
          <NotificationsPanel rec={rec} />
          <ActionsPanel {...shared} navigate={navigate} />
        </div>
      </div>
      <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}

// ── Task: owner, next action, due, blocked, payment, status ─────────────
function TaskPanel({ rec, act, canAct, isAdmin, busy }) {
  const s = rec.submission;
  const initial = () => ({
    owner_id: s.owner_id || '', next_action: s.next_action || '', due_at: toLocalInput(s.due_at), blocked_reason: s.blocked_reason || '',
    payment_status: s.payment_status, status: s.status, synthetic: !!s.synthetic,
  });
  const [f, setF] = useState(initial);
  const [escalating, setEscalating] = useState(false);
  const [escalation, setEscalation] = useState('');
  const [seen, setSeen] = useState(s.updated_at);
  if (seen !== s.updated_at) { setSeen(s.updated_at); setF(initial()); }   // the record changed: show it
  const locked = ['draft', 'closed', 'declined'].includes(s.status);
  const statuses = s.job_id ? ['linked', 'needs_customer_action'] : ['new', 'needs_identity_review', 'needs_customer_action', 'ready_for_job'];
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  function save() {
    const was = initial();
    const changes = {};
    for (const k of Object.keys(f)) if (f[k] !== was[k]) changes[k] = f[k];
    if ('due_at' in changes) changes.due_at = toUtc(changes.due_at);
    if ('owner_id' in changes) changes.owner_id = changes.owner_id ? Number(changes.owner_id) : null;
    if (!Object.keys(changes).length) return;
    act(() => api.commandIntakeUpdate(s.id, changes), 'Saved');
  }

  return (
    <Panel title="Task" testId="task-panel">
      <div className="flex flex-col gap-3">
        <Field label="Owner">
          <Select value={f.owner_id} onChange={e => set('owner_id', e.target.value)} disabled={!canAct}>
            <option value="">Unassigned</option>
            {rec.owners.map(o => <option key={o.id} value={o.id}>{o.name} ({o.role})</option>)}
          </Select>
        </Field>
        <Field label="Next action"><TextInput value={f.next_action} onChange={e => set('next_action', e.target.value)} disabled={!canAct} /></Field>
        <Field label="Due"><TextInput type="datetime-local" value={f.due_at} onChange={e => set('due_at', e.target.value)} disabled={!canAct} /></Field>
        <Field label="Blocked by"><TextInput value={f.blocked_reason} onChange={e => set('blocked_reason', e.target.value)} disabled={!canAct} placeholder="Optional" /></Field>
        {s.kind === 'footage' && (
          <Field label="Payment">
            <Select value={f.payment_status} onChange={e => set('payment_status', e.target.value)} disabled={!canAct} data-testid="payment-status">
              {Object.entries(PAYMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
            {s.order_reference && <p className="text-xs mt-1" style={muted}>Order <b className="text-white">{s.order_reference}</b></p>}
          </Field>
        )}
        <Field label="Stage">
          <Select value={f.status} onChange={e => set('status', e.target.value)} disabled={!canAct || locked} data-testid="status-select">
            {!statuses.includes(s.status) && <option value={s.status}>{STATUS_LABEL[s.status] || s.status}</option>}
            {statuses.map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
          </Select>
        </Field>
        {!s.job_id && (
          <div className="flex items-center gap-1.5">
            <label className="flex items-center gap-2 text-xs font-bold cursor-pointer" style={muted}>
              <input type="checkbox" checked={f.synthetic} onChange={e => set('synthetic', e.target.checked)} disabled={!canAct} className="accent-sky-400" />
              Test submission
            </label>
            <InfoTip label="About test submissions">Kept out of customer profiles, notifications and analytics, and can never join a real job.</InfoTip>
          </div>
        )}
        {canAct && <PrimaryButton type="button" onClick={save} disabled={busy}>Save task</PrimaryButton>}
        {canAct && !s.escalated_at && !locked && (
          <div className="pt-3 border-t flex flex-col gap-2" style={{ borderColor: '#1e3a5f' }}>
            <Reveal label="Escalate to an admin…" open={escalating} onOpen={() => setEscalating(true)}>
              <TextArea rows={2} value={escalation} onChange={e => setEscalation(e.target.value)} placeholder="What does an admin need to decide?" />
              <div className="flex gap-2">
                <GhostButton type="button" disabled={busy || !escalation.trim()} onClick={async () => { if (await act(() => api.commandIntakeEscalate(s.id, escalation), 'Escalated to an admin')) { setEscalation(''); setEscalating(false); } }}>Escalate to admin</GhostButton>
                <GhostButton type="button" onClick={() => setEscalating(false)}>Cancel</GhostButton>
              </div>
            </Reveal>
          </div>
        )}
        {isAdmin && s.escalated_at && <p className="text-xs" style={muted}>Escalated — clear it from the banner once decided.</p>}
      </div>
    </Panel>
  );
}

// ── Command job: suggestions, link, create, attach more ─────────────────
function JobPanel({ rec, act, canAct, busy }) {
  const s = rec.submission;
  const [jobId, setJobId] = useState('');
  const [creating, setCreating] = useState(false);
  const unattached = rec.files.filter(f => f.kind === 'video' && !f.feed_id && ['uploaded', 'processing', 'ready'].includes(f.status));

  if (rec.job) {
    return (
      <Panel title="Command job" testId="job-panel">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <Link to={`/command/jobs/${rec.job.id}`} className="text-base font-bold hover:underline" style={{ color: '#38bdf8' }}>Job #{rec.job.id} — {rec.job.team_name}</Link>
            <p className="text-xs mt-1" style={muted}>{fmtDate(rec.job.game_date)} · {rec.job.package_key} · metrics {rec.job.metric_release_status.replace(/_/g, ' ')} · game record {rec.job.game_record_status.replace(/_/g, ' ')}</p>
          </div>
          {rec.job.synthetic && <Tag color="#fbbf24">synthetic</Tag>}
        </div>
        {unattached.length > 0 && (
          <div className="mt-4 pt-4 border-t flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: '#1e3a5f' }}>
            <p className="text-sm" style={{ color: '#fbbf24' }}>{unattached.length} new video{unattached.length === 1 ? '' : 's'} not on the job yet</p>
            {canAct && <PrimaryButton type="button" disabled={busy} onClick={() => act(() => api.commandIntakeAttachFiles(s.id), r => `Attached ${r.attached.length} video${r.attached.length === 1 ? '' : 's'} to job #${rec.job.id}`)}>Attach to the job</PrimaryButton>}
          </div>
        )}
      </Panel>
    );
  }

  const { blockers, ready } = rec.checks;
  const warnings = rec.checks.warnings.map(w => (typeof w === 'string' ? { code: w, text: w } : w));
  const candidates = rec.game.job_candidates;
  return (
    <Panel title="Command job" testId="job-panel">
      {blockers.length > 0 && (
        <ul className="text-sm flex flex-col gap-1 mb-3" data-testid="job-blockers">
          {blockers.map(b => <li key={b} className="flex items-start gap-2" style={{ color: '#fecaca' }}><X size={15} strokeWidth={2.6} className="mt-0.5 shrink-0" style={{ color: '#f87171' }} aria-hidden="true" />{b}</li>)}
        </ul>
      )}
      {ready && <p className="text-sm mb-3 flex items-center gap-2" style={{ color: '#4ade80' }}><Check size={15} strokeWidth={2.6} aria-hidden="true" />Ready for a job</p>}
      {warnings.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-4" data-testid="job-warnings">
          {warnings.map(w => <Chip key={w.code} icon={TriangleAlert} color="#fbbf24" tip={w.text}>{WARNING_LABEL[w.code] || w.text}</Chip>)}
        </div>
      )}

      {s.kind !== 'inquiry' && (
        <>
          {candidates.length > 0 && (
            <div className="flex flex-col gap-2 mb-4">
              <p className="text-xs font-bold uppercase tracking-wider" style={faint}>Existing job{candidates.length === 1 ? '' : 's'} for this game</p>
              {candidates.map(j => (
                <div key={j.id} className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: j.other_side ? '#334155' : '#1e3a5f' }} data-testid={`job-candidate-${j.id}`}>
                  <p className="text-sm flex items-center gap-1.5 flex-wrap min-w-0" style={body}>
                    <Link to={`/command/jobs/${j.id}`} className="font-bold hover:underline" style={{ color: '#38bdf8' }}>#{j.id}</Link>
                    {j.team_name}{j.opponent_label ? ` vs ${j.opponent_label}` : ''} · {fmtDate(j.game_date)}
                    <InfoTip label="Why this job is suggested">{[j.reasons.join(' · '), j.tournament_name].filter(Boolean).join(' · ')}</InfoTip>
                    {j.other_side && <Chip color="#fbbf24" tip="The other team’s job for this game — link only your own team’s job.">Other team</Chip>}
                    {j.synthetic && <Tag color="#fbbf24">synthetic</Tag>}
                  </p>
                  {canAct && !j.other_side && <GhostButton type="button" disabled={busy || !ready} onClick={() => act(() => api.commandIntakeLinkJob(s.id, j.id), `Linked to job #${j.id}`)}>Link</GhostButton>}
                </div>
              ))}
            </div>
          )}
          {canAct && (creating
            ? <CreateJobForm rec={rec} act={act} busy={busy} ready={ready} onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
            : (
              <div className="flex items-center gap-2 flex-wrap">
                <PrimaryButton type="button" onClick={() => setCreating(true)} disabled={!ready} data-testid="open-create-job">Create a new Command job…</PrimaryButton>
                <span className="text-xs mx-1" style={faint}>or link</span>
                <TextInput value={jobId} onChange={e => setJobId(e.target.value.replace(/\D/g, ''))} placeholder="Job #" aria-label="Job number" style={{ width: '6.5rem' }} />
                <GhostButton type="button" disabled={busy || !ready || !jobId} onClick={() => act(() => api.commandIntakeLinkJob(s.id, Number(jobId)), `Linked to job #${jobId}`)}>Link job</GhostButton>
              </div>
            ))}
        </>
      )}
    </Panel>
  );
}

function CreateJobForm({ rec, act, busy, ready, onDone, onCancel }) {
  const s = rec.submission;
  const [boot, setBoot] = useState(null);
  const [bootError, setBootError] = useState('');
  const cands = rec.game.team_candidates;
  const [f, setF] = useState({
    team_choice: cands[0] ? String(cands[0].team_id) : '',
    new_team: { name: s.team_label || '', organization_name: rec.account.organization || '', age_group: s.level || '' },
    game_date: s.game_date || '', opponent_label: s.opponent_label || '', event_label: s.event_label || '',
    tournament_game_id: '', package_key: s.package?.command_package || 'rookie', assigned_to: '', due_date: '', notes: '',
  });
  useEffect(() => { api.commandBootstrap().then(setBoot).catch(err => setBootError(err.message)); }, []);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    const body = {
      game_date: f.game_date, opponent_label: f.opponent_label, event_label: f.event_label,
      tournament_game_id: f.tournament_game_id ? Number(f.tournament_game_id) : null, package_key: f.package_key,
      assigned_to: f.assigned_to ? Number(f.assigned_to) : null, due_date: f.due_date || null, notes: f.notes,
    };
    if (f.team_choice === 'new') body.new_team = f.new_team;
    else body.team_id = Number(f.team_choice);
    const r = await act(() => api.commandIntakeCreateJob(s.id, body), x => `Created Command job #${x.job_id}`);
    if (r) onDone(r);
  }

  const packages = (boot?.packages || []).filter(p => p.orderable);
  const suggested = cands.length ? cands.map(t => `${t.name}${t.age_group ? ` · ${t.age_group}` : ''}: ${t.reasons.join(', ')}`).join('. ') : '';
  return (
    <form onSubmit={submit} className="rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: '#38bdf8' }} data-testid="create-job-form">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm font-bold text-white">New Command job from {s.public_id}</p>
        {s.package?.fulfillment_note && <Chip color="#fbbf24" tip={s.package.fulfillment_note}>Requested Pro — fulfilled as Rookie</Chip>}
        {s.kind === 'footage' && !s.package?.command_package && s.package_key === 'custom' && <Chip color="#fbbf24" tip="Custom request — confirm the scope with the customer and pick the package that covers it.">Custom — confirm scope</Chip>}
      </div>
      <ErrorNote>{bootError}</ErrorNote>
      <Field label="Team" hint={suggested ? `Suggested — ${suggested}.` : undefined}>
        <Select value={f.team_choice} onChange={e => set('team_choice', e.target.value)} data-testid="job-team">
          <option value="">Choose the team…</option>
          {cands.length > 0 && (
            <optgroup label="Suggested">
              {cands.map(t => <option key={t.team_id} value={t.team_id}>{t.name}{t.age_group ? ` · ${t.age_group}` : ''}</option>)}
            </optgroup>
          )}
          <optgroup label="All teams">
            {(boot?.teams || []).filter(t => !cands.some(c => c.team_id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}{t.age_group ? ` · ${t.age_group}` : ''} — {t.organization_name}</option>)}
          </optgroup>
          <option value="new">+ A new team…</option>
        </Select>
        {f.team_choice === 'new' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
            <TextInput value={f.new_team.name} onChange={e => set('new_team', { ...f.new_team, name: e.target.value })} placeholder="Team name" />
            <TextInput value={f.new_team.organization_name} onChange={e => set('new_team', { ...f.new_team, organization_name: e.target.value })} placeholder="Organization" />
            <TextInput value={f.new_team.age_group} onChange={e => set('new_team', { ...f.new_team, age_group: e.target.value })} placeholder="Age group" />
          </div>
        )}
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Game date"><TextInput type="date" value={f.game_date} onChange={e => set('game_date', e.target.value)} required /></Field>
        <Field label="Opponent"><TextInput value={f.opponent_label} onChange={e => set('opponent_label', e.target.value)} /></Field>
        <Field label="Event"><TextInput value={f.event_label} onChange={e => set('event_label', e.target.value)} /></Field>
      </div>
      {rec.game.tournament_games.length > 0 && (
        <Field label="Tournament game">
          <Select value={f.tournament_game_id} onChange={e => set('tournament_game_id', e.target.value)}>
            <option value="">None</option>
            {rec.game.tournament_games.map(g => <option key={g.id} value={g.id}>{g.tournament_name}: {g.home_team_name} vs {g.away_team_name}{g.game_time ? ` · ${g.game_time}` : ''}</option>)}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Package">
          <Select value={f.package_key} onChange={e => set('package_key', e.target.value)}>
            {packages.length === 0 && <option value={f.package_key}>{f.package_key}</option>}
            {packages.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Analyst">
          <Select value={f.assigned_to} onChange={e => set('assigned_to', e.target.value)}>
            <option value="">Unassigned</option>
            {(boot?.analysts || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Due"><TextInput type="date" value={f.due_date} onChange={e => set('due_date', e.target.value)} /></Field>
      </div>
      <Field label="Notes for analysts"><TextArea rows={2} value={f.notes} onChange={e => set('notes', e.target.value)} placeholder="Optional" /></Field>
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy || !ready || !f.team_choice} data-testid="create-job">Create job</PrimaryButton>
        <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>
      </div>
    </form>
  );
}

// ── Identity ─────────────────────────────────────────────────────────────
function AthletesPanel({ rec, act, canAct, busy }) {
  const s = rec.submission;
  return (
    <Panel title="Athletes" hint="Nothing links automatically — every decision is yours, and audited." testId="athletes-panel">
      {rec.athletes.length === 0 && <p className="text-sm" style={muted}>No athletes listed{rec.files.some(f => f.kind === 'roster') ? ' — a roster file is attached.' : '.'}</p>}
      <div className="flex flex-col gap-4">
        {rec.athletes.map(a => <AthleteCard key={a.id} a={a} sub={s} act={act} canAct={canAct} busy={busy} hasJob={!!rec.job} />)}
      </div>
    </Panel>
  );
}

function Confidence({ c }) {
  return (
    <Tooltip content={`Score ${c.score} — ${c.reasons.join(' · ')}`} className="rounded-full">
      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full capitalize" data-testid="confidence"
        style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: CONFIDENCE_TONE[c.confidence] }}>
        {c.confidence}
      </span>
    </Tooltip>
  );
}

function AthleteCard({ a, sub, act, canAct, busy, hasJob }) {
  const [note, setNote] = useState('');
  const [playerId, setPlayerId] = useState('');
  const open = ['pending', 'deferred'].includes(a.resolution);
  const [label, tone] = RESOLUTION[a.resolution] || [a.resolution, '#94a3b8'];
  const resolve = (body, ok) => act(() => api.commandIntakeResolveAthlete(sub.id, a.id, body), ok).then(r => { if (r) { setNote(''); setPlayerId(''); } });
  const strong = a.candidates.some(c => c.confidence !== 'low');
  const locked = ['draft', 'closed', 'declined'].includes(sub.status);
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: open ? 'rgba(251, 191, 36, 0.4)' : '#1e3a5f' }} data-testid={`athlete-${a.id}`} data-resolution={a.resolution}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-base font-bold text-white flex items-center gap-2 flex-wrap">
            {a.first_name} {a.last_name}
            {a.ownership && <Chip color="#c4b5fd" tip="Linking adds this athlete to the submitter’s account (a family relationship).">Family</Chip>}
          </p>
          <p className="text-xs" style={muted}>
            {[a.birth_year && `born ${a.birth_year}`, a.age_band, a.team_label, a.jersey && `#${a.jersey}`, `submitter: ${a.relationship_label}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Tag color={tone}>{label}</Tag>
      </div>
      {a.player && (
        <p className="text-sm mt-2" style={body}>
          → Player #{a.player.id} {a.player.first_name} {a.player.last_name}
          <span className="text-xs" style={faint}> · {a.player.is_public ? 'public profile' : 'private'}{a.on_job_roster === true ? ' · on the job roster' : ''}</span>
        </p>
      )}
      {a.resolution_note && <p className="text-xs mt-1" style={muted}>Note: {a.resolution_note}</p>}

      {open && (
        <div className="mt-3">
          {a.ambiguous && (
            <p className="mb-2" data-testid="ambiguous">
              <Chip icon={TriangleAlert} color="#fbbf24" tip="More than one reasonable match (or no confident one) — choose explicitly.">Ambiguous — choose explicitly</Chip>
            </p>
          )}
          {a.candidates.length === 0 ? (
            <p className="text-xs mb-2" style={muted}>No existing player matches by name.</p>
          ) : (
            <div className="flex flex-col gap-1.5 mb-3">
              {a.candidates.map(c => (
                <div key={c.player_id} className="rounded-lg px-3 py-2 flex items-center justify-between gap-3 flex-wrap" style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }} data-testid={`candidate-${c.player_id}`}>
                  <p className="text-sm flex items-center gap-2 flex-wrap min-w-0" style={body}>
                    <b>{c.name}</b>
                    <span className="text-xs" style={faint}>#{c.player_id}{c.date_of_birth ? ` · born ${String(c.date_of_birth).slice(0, 4)}` : c.grad_year ? ` · class of ${c.grad_year}` : ''}{c.teams.length ? ` · ${c.teams.join(', ')}` : ''}{c.placeholder ? ' · guest placeholder' : ''}</span>
                    <Confidence c={c} />
                  </p>
                  {canAct && !locked && <GhostButton type="button" disabled={busy} onClick={() => resolve({ action: 'link', player_id: c.player_id, note }, `Linked ${a.first_name} to player #${c.player_id}`)}>Link</GhostButton>}
                </div>
              ))}
            </div>
          )}
          {canAct && !locked && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="Reason" aria-label="Reason" />
                <InfoTip label="When a reason is needed">{strong ? 'Needed to defer, or to create a new player when a reasonable match exists.' : 'Needed to defer.'}</InfoTip>
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <GhostButton type="button" disabled={busy || (strong && !note.trim())} onClick={() => resolve({ action: 'new_player', note }, 'New private player created')}>New private player</GhostButton>
                <GhostButton type="button" disabled={busy} onClick={() => resolve({ action: 'guest', note }, 'Marked as a guest placeholder')}>Guest placeholder</GhostButton>
                <GhostButton type="button" disabled={busy || !note.trim()} onClick={() => resolve({ action: 'defer', note }, 'Deferred')}>Defer</GhostButton>
                <span className="flex items-center gap-1.5">
                  <TextInput value={playerId} onChange={e => setPlayerId(e.target.value.replace(/\D/g, ''))} placeholder="Player #" aria-label="Player number" style={{ width: '6.5rem' }} />
                  <GhostButton type="button" disabled={busy || !playerId} onClick={() => resolve({ action: 'link', player_id: Number(playerId), note }, `Linked to player #${playerId}`)}>Link</GhostButton>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {!open && canAct && !hasJob && !locked && (
        <button type="button" disabled={busy} onClick={() => resolve({ action: 'reset' }, 'Decision reset')} className="text-xs mt-2 hover:underline cursor-pointer" style={faint}>Undo this decision</button>
      )}
    </div>
  );
}

// ── Game context and duplicates ──────────────────────────────────────────
function GamePanel({ rec, act, canAct, busy }) {
  const s = rec.submission;
  const ctx = s.footage_context || {};
  return (
    <Panel title={s.kind === 'inquiry' ? 'Event' : 'Game'} testId="game-panel">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <p style={body}><span style={faint}>Date </span>{s.game_date ? fmtDate(s.game_date) : '—'}</p>
        <p style={body}><span style={faint}>Event </span>{ctx.no_event ? 'Regular-season game' : s.event_label || '—'}</p>
        <p style={body}><span style={faint}>Team </span>{s.team_label || '—'}</p>
        <p style={body}><span style={faint}>Opponent </span>{s.opponent_label || '—'}</p>
        <p style={body}><span style={faint}>Level </span>{s.level || '—'}</p>
        <p style={body}><span style={faint}>Location </span>{s.location || '—'}</p>
        {s.kind === 'footage' && <p style={body}><span style={faint}>Footage </span>{[ctx.coverage === 'full' ? 'full game' : ctx.coverage === 'clips' ? 'clips' : '', ctx.orientation, ctx.known_resolution, ctx.known_fps && `${ctx.known_fps} fps`, ctx.side_angle && 'side angle filmed'].filter(Boolean).join(' · ') || '—'}</p>}
        {s.requested_metrics && <p style={body}><span style={faint}>Requested </span>{s.requested_metrics}</p>}
      </div>
      {ctx.key_plays && <p className="text-sm mt-2 rounded-lg px-3 py-2" style={{ ...body, backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>“{ctx.key_plays}”</p>}

      <p className="text-xs font-bold uppercase tracking-wider mt-4 mb-2" style={faint}>Team in our records</p>
      {rec.game.team_candidates.length === 0 ? <p className="text-sm" style={muted}>No match — the job form can create one.</p> : (
        <div className="flex flex-col gap-1.5">
          {rec.game.team_candidates.map(t => {
            const confirmed = s.team_id === t.team_id;
            return (
              <div key={t.team_id} className="flex items-center justify-between gap-3 flex-wrap text-sm">
                <span className="flex items-center gap-1.5" style={body}>
                  {t.name}{t.age_group ? ` · ${t.age_group}` : ''}
                  <InfoTip label="Why this team matches">{t.organization_name} — {t.reasons.join(', ')}</InfoTip>
                </span>
                {confirmed ? <Tag color="#4ade80">confirmed</Tag> : canAct && !s.job_id && <GhostButton type="button" disabled={busy} onClick={() => act(() => api.commandIntakeUpdate(s.id, { team_id: t.team_id }), `Team confirmed: ${t.name}`)}>Confirm</GhostButton>}
              </div>
            );
          })}
        </div>
      )}
      {rec.game.submission_duplicates.length > 0 && (
        <div data-testid="same-game">
          <p className="text-xs font-bold uppercase tracking-wider mt-4 mb-2" style={{ color: '#fbbf24' }}>Other submissions of this game</p>
          {rec.game.submission_duplicates.map(d => (
            <p key={d.id} className="text-sm" style={body}>
              <Link to={`/command/intake/${d.id}`} className="font-mono font-bold hover:underline" style={{ color: '#38bdf8' }}>{d.public_id}</Link> from {d.first_name} {d.last_name} ({d.role}){d.same_account ? ' — same account' : ''}{d.job_id ? ` · job #${d.job_id}` : ''}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Files ────────────────────────────────────────────────────────────────
function FileDetails({ f }) {
  const fps = f.effective_fps || f.nominal_fps;
  return (
    <span className="flex flex-col gap-1">
      <span className="text-white break-all">{f.original_name}</span>
      {f.uploaded_at && <span>Uploaded {fmtDateTime(f.uploaded_at)}</span>}
      {f.width && <span>{f.width}×{f.height}{f.rotation ? ` · rotated ${f.rotation}°` : ''} · {fps ? `${Number(fps).toFixed(2)} fps` : '? fps'}{f.vfr ? ' (variable)' : ''} · {f.codec || '?'}</span>}
      {f.diagnostics && <span className="font-mono text-[11px] break-all" style={muted}>{f.diagnostics}</span>}
      {f.retention_deadline && f.status !== 'deleted' && <span>Delete by {fmtDate(f.retention_deadline)}</span>}
    </span>
  );
}

function FilesPanel({ rec, act, canAct, busy }) {
  const s = rec.submission;
  async function download(f) {
    try { const { url } = await api.commandIntakeDownload(s.id, f.id); window.open(url, '_blank', 'noopener'); }
    catch (err) { act(() => Promise.reject(err)); }
  }
  return (
    <Panel title="Files" testId="files-panel">
      <Issues issues={rec.capture_notes} prefix="Customer sees: " className="mb-2" />
      {rec.files.length === 0 && <p className="text-sm" style={muted}>No files.</p>}
      <div className="flex flex-col">
        {rec.files.map(f => {
          const fps = f.effective_fps || f.nominal_fps;
          const sendable = s.job_id && f.status === 'ready' && (f.kind === 'radar_csv' || (f.kind === 'scorecard' && /\.csv$/i.test(f.original_name)));
          const title = f.kind === 'video' ? (f.view_label || 'Video') : f.kind_label;
          const length = !f.duration_s ? '?' : f.duration_s < 60 ? `${Math.round(f.duration_s)} s` : `${Math.round(f.duration_s / 60)} min`;
          const spec = f.width ? `${Math.min(f.width, f.height)}p · ${fps ? Math.round(fps) : '?'} fps · ${length}` : f.original_name;
          const dupes = [...f.duplicates.intake.map(d => `submission ${d.public_id}`), ...f.duplicates.command.map(d => `feed #${d.feed_id} on job #${d.job_id}`)];
          return (
            <div key={f.id} className="py-3 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }} data-testid={`intake-file-${f.id}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{title}{f.label && f.label !== title ? ` · ${f.label}` : ''}</p>
                  <p className="text-xs flex items-center gap-1.5" style={muted}>
                    <span className="truncate">{spec} · {fmtBytes(f.size_bytes)}</span>
                    <InfoTip label="File details" maxWidth={340}><FileDetails f={f} /></InfoTip>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Tag color={f.status === 'ready' ? '#4ade80' : f.status === 'needs_customer_action' ? '#f87171' : '#38bdf8'}>{f.status.replace(/_/g, ' ')}</Tag>
                  {!['uploading', 'paused', 'deleted'].includes(f.status) && f.storage_key && <GhostButton type="button" onClick={() => download(f)}>Download</GhostButton>}
                  {canAct && sendable && <GhostButton type="button" disabled={busy} onClick={() => act(() => api.commandIntakeSendToJob(s.id, f.id), r => (r.result?.duplicate ? 'Already imported into the job' : 'Sent to the job'))}>Send to job</GhostButton>}
                </div>
              </div>
              {(f.feed || dupes.length > 0 || f.overdue_retention) && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  {f.feed && (
                    <Tooltip content={`On job #${f.feed.job_id} · ${f.feed.status}${f.feed.error ? ` — ${f.feed.error}` : ''}`} focusable={false}>
                      <Link to={`/command/feeds/${f.feed.id}`} className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full hover:underline" data-testid="feed-link"
                        style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
                        Feed #{f.feed.id}{f.feed.status !== 'ready' ? ` · ${f.feed.status}` : ''}
                      </Link>
                    </Tooltip>
                  )}
                  {dupes.length > 0 && <Chip icon={TriangleAlert} color="#fbbf24" tip={`Same file elsewhere: ${dupes.join(', ')}`}>Duplicate</Chip>}
                  {f.overdue_retention && <Chip color="#f87171" tip={`Delete by ${fmtDate(f.retention_deadline)}`}>Past retention date</Chip>}
                </div>
              )}
              <Issues issues={f.issues} prefix="Customer sees: " />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── Customer messages and internal notes — one box, two clearly marked modes
function CommunicatePanel({ rec, act, canAct, busy }) {
  const s = rec.submission;
  const [mode, setMode] = useState('customer');
  const [message, setMessage] = useState('');
  const [requestAction, setRequestAction] = useState(true);
  const [note, setNote] = useState('');
  if (!canAct) return null;
  const open = !['draft', 'closed', 'declined'].includes(s.status);
  const customer = mode === 'customer';
  const tab = (key, Icon, label, tip) => (
    <Tooltip content={tip} asChild>
      <button type="button" role="tab" aria-selected={mode === key} onClick={() => setMode(key)} data-testid={`mode-${key}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border"
        style={mode === key
          ? (key === 'customer' ? { backgroundColor: 'rgba(56, 189, 248, 0.15)', borderColor: '#38bdf8', color: '#38bdf8' } : { backgroundColor: 'rgba(148, 163, 184, 0.15)', borderColor: '#94a3b8', color: '#e2e8f0' })
          : { borderColor: '#1e3a5f', color: '#94a3b8' }}>
        <Icon size={13} aria-hidden="true" />{label}
      </button>
    </Tooltip>
  );
  return (
    <Panel title="Message" testId="message-panel" aside={(
      <div className="flex gap-1.5" role="tablist" aria-label="Who sees it">
        {tab('customer', Eye, 'To the customer', `Shown on their submission page${rec.account.email_verified ? ' and sent by email' : ''}.`)}
        {tab('note', Lock, 'Internal note', 'Staff only — never shown to the customer.')}
      </div>
    )}>
      {customer ? (
        <>
          <TextArea value={message} onChange={e => setMessage(e.target.value)} disabled={!open} placeholder={open ? 'e.g. Which inning does the second file start in?' : 'The submission is not open'} />
          <div className="flex items-center justify-between gap-3 flex-wrap mt-2">
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-xs font-bold cursor-pointer" style={muted}>
                <input type="checkbox" checked={requestAction} onChange={e => setRequestAction(e.target.checked)} className="accent-sky-400" />
                Needs an answer
              </label>
              <InfoTip label="About needs an answer">Moves the submission to “Waiting on customer”. They can reply and add files from their page.</InfoTip>
            </div>
            <PrimaryButton type="button" disabled={busy || !open || !message.trim()} onClick={async () => { if (await act(() => api.commandIntakeMessage(s.id, message, requestAction), 'Message sent')) setMessage(''); }}>Send to customer</PrimaryButton>
          </div>
        </>
      ) : (
        <div data-testid="note-panel">
          <TextArea value={note} onChange={e => setNote(e.target.value)} placeholder="What you checked, decided or are waiting on" />
          <div className="flex justify-end mt-2"><GhostButton type="button" disabled={busy || !note.trim()} onClick={async () => { if (await act(() => api.commandIntakeNote(s.id, note), 'Note added')) setNote(''); }}>Add note</GhostButton></div>
        </div>
      )}
    </Panel>
  );
}

function TimelinePanel({ rec }) {
  const [customerOnly, setCustomerOnly] = useState(false);
  const events = [...rec.timeline].reverse().filter(e => !customerOnly || e.visibility === 'customer');
  return (
    <Panel title="Timeline" hint="Every event is recorded and can’t be edited or deleted." testId="timeline-panel" aside={(
      <button type="button" aria-pressed={customerOnly} onClick={() => setCustomerOnly(v => !v)} data-testid="customer-view"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer border"
        style={customerOnly ? { backgroundColor: 'rgba(56, 189, 248, 0.15)', borderColor: '#38bdf8', color: '#38bdf8' } : { borderColor: '#1e3a5f', color: '#94a3b8' }}>
        <Eye size={13} aria-hidden="true" />Customer view
      </button>
    )}>
      <ol className="flex flex-col">
        {events.map(e => {
          const visible = e.visibility === 'customer';
          return (
            <li key={e.id} className="py-2.5 border-t first:border-t-0 grid grid-cols-[minmax(0,1fr)_auto] gap-3" style={{ borderColor: '#1e3a5f' }}>
              <div className="min-w-0">
                <p className="text-xs" style={faint}>
                  <b style={{ color: e.actor_kind === 'customer' ? '#cfe8ff' : e.actor_kind === 'staff' ? '#38bdf8' : '#94a3b8' }}>{e.actor}</b> · {e.type.replace(/_/g, ' ')} · {fmtDateTime(e.at)}
                </p>
                <p className="text-sm mt-0.5 whitespace-pre-line break-words" style={body}>{e.message}</p>
              </div>
              <Tooltip content={visible ? 'The customer sees this' : 'Internal — staff only'} focusable={false}>
                <span className="w-6 h-6 rounded-md inline-flex items-center justify-center" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: visible ? '#38bdf8' : '#64748b' }} data-visibility={e.visibility}>
                  {visible ? <Eye size={13} aria-hidden="true" /> : <Lock size={13} aria-hidden="true" />}
                  <span className="sr-only">{visible ? 'customer-visible' : 'internal'}</span>
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ── Contact ──────────────────────────────────────────────────────────────
function ContactPanel({ rec, act, canAct, busy }) {
  const a = rec.account;
  const [verifying, setVerifying] = useState(false);
  const [note, setNote] = useState('');
  return (
    <Panel title="Contact" testId="contact-panel">
      <p className="text-base font-bold text-white">{a.first_name} {a.last_name}</p>
      <p className="text-xs" style={muted}>{a.role_label}{a.organization ? ` · ${a.organization}` : ''}{a.is_test ? ' · test account' : ''}{a.status !== 'active' ? ` · ${a.status}` : ''}</p>
      <div className="text-sm mt-3 flex flex-col gap-1" style={body}>
        <p className="break-all flex items-center gap-2 flex-wrap">
          {a.email}
          {a.email_verified
            ? <Chip icon={BadgeCheck} color="#4ade80" tip={a.verified_via === 'staff' ? 'Confirmed by staff' : 'Confirmed from the verification link'}>Verified</Chip>
            : <Chip color="#fbbf24">Not verified</Chip>}
        </p>
        {a.phone && <p>{a.phone}</p>}
        <p className="text-xs" style={muted}>Prefers {a.preferred_contact} · since {fmtDate(a.created_at)}{a.linked_logins.staff ? ' · has a coach login' : ''}{a.linked_logins.player ? ' · has a player login' : ''}</p>
      </div>
      {canAct && !a.email_verified && (
        <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: '#1e3a5f' }}>
          <Reveal label="Verify the email manually…" open={verifying} onOpen={() => setVerifying(true)}>
            <div className="flex items-center gap-1.5">
              <TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="How you confirmed it" aria-label="How you confirmed it" />
              <InfoTip label="About manual verification">Until email is switched on, confirm the address yourself — for example, they replied from it — and record how. It’s audited.</InfoTip>
            </div>
            <GhostButton type="button" disabled={busy || !note.trim()} onClick={async () => { if (await act(() => api.commandIntakeVerifyEmail(a.id, note), 'Email marked verified')) { setNote(''); setVerifying(false); } }} data-testid="verify-email">Mark email verified</GhostButton>
          </Reveal>
        </div>
      )}
      {canAct && (
        <div className="flex items-center gap-1.5 mt-3">
          <label className="flex items-center gap-2 text-xs font-bold cursor-pointer" style={muted}>
            <input type="checkbox" checked={a.is_test} disabled={busy} onChange={e => act(() => api.commandIntakeSetTestAccount(a.id, e.target.checked), e.target.checked ? 'Marked as a test account' : 'No longer a test account')} className="accent-sky-400" />
            Internal test account
          </label>
          <InfoTip label="About test accounts">Its open submissions become test submissions: they can never join a real job and send no customer notifications.</InfoTip>
        </div>
      )}
      {rec.contact_duplicates.length > 0 && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }}>
          <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: '#fbbf24' }}>Possibly the same person</p>
          {rec.contact_duplicates.map(d => (
            <p key={`${d.kind}${d.id}`} className="text-xs flex items-center gap-1.5" style={body}>{d.label}<InfoTip label="Why">{d.reason}</InfoTip></p>
          ))}
        </div>
      )}
      {(rec.verified_athletes.length > 0 || rec.verified_teams.length > 0) && (
        <div className="mt-3 pt-3 border-t text-xs flex flex-col gap-1" style={{ borderColor: '#1e3a5f', ...body }}>
          {rec.verified_athletes.length > 0 && <p><span style={faint}>Verified athletes </span>{rec.verified_athletes.map(x => `${x.first_name} ${x.last_name}`).join(', ')}</p>}
          {rec.verified_teams.length > 0 && <p><span style={faint}>Verified teams </span>{rec.verified_teams.map(t => t.name).join(', ')}</p>}
        </div>
      )}
      {rec.prior_submissions.length > 0 && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }}>
          <p className="text-xs font-bold uppercase tracking-wider mb-1" style={faint}>Earlier submissions</p>
          {rec.prior_submissions.map(p => (
            <p key={p.id} className="text-xs" style={body}>
              <Link to={`/command/intake/${p.id}`} className="font-mono font-bold hover:underline" style={{ color: '#38bdf8' }}>{p.public_id}</Link> · {p.status.replace(/_/g, ' ')}{p.game_date ? ` · ${fmtDate(p.game_date)}` : ''}{p.team_label ? ` · ${p.team_label}` : ''}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Consent records (immutable; newest first) ───────────────────────────
function RightsPanel({ rec }) {
  const rows = [...rec.rights].reverse();
  return (
    <Panel title="Consent" hint="Each acceptance is a permanent record of the exact wording shown. It can’t be edited, only superseded." testId="rights-panel">
      {rows.length === 0 && <p className="text-sm" style={{ color: '#f87171' }}>No footage terms accepted.</p>}
      {rows.map(r => (
        <div key={r.id} className="py-2 border-t first:border-t-0 text-xs flex flex-col gap-1.5" style={{ borderColor: '#1e3a5f', ...body }}>
          <p className="flex items-center gap-2 flex-wrap">
            <Tag color={r.action === 'grant' ? '#4ade80' : '#f87171'}>{r.action === 'grant' ? 'accepted' : 'revoked'}</Tag>
            <span style={faint}>{fmtDateTime(r.created_at)}</span>
            {!!r.pending_legal && <Tag color="#fbbf24" title="Accepted under draft wording that legal has not approved yet">draft terms</Tag>}
            <InfoTip label="Consent details" maxWidth={340}>
              <span className="flex flex-col gap-1">
                {r.attestation && <span>“{r.attestation}”</span>}
                <span>Version {r.policy_version} · guide {r.guide_version}{r.guide_ack ? ' (read)' : ''}</span>
                <span>Keep {r.retention_days} days, until {fmtDate(r.retention_deadline)}</span>
                {r.athlete_ids.length > 0 && <span>Covers {r.athlete_ids.map(x => `${x.first_name} ${x.last_name}`).join(', ')}</span>}
                <span className="font-mono text-[11px] break-all" style={muted}>sha256 {String(r.policy_hash).slice(0, 16)}… · {r.actor_kind}{r.ip ? ` · ${r.ip}` : ''}</span>
              </span>
            </InfoTip>
          </p>
          <p className="flex gap-x-3 gap-y-1 flex-wrap">
            {[...Object.entries(r.permitted_uses).map(([k, v]) => [USE_LABEL[k] || k, v]), ['Contact', r.contact_permission]].map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1" style={{ color: v ? '#cbd5e1' : '#64748b' }}>
                {v ? <Check size={12} strokeWidth={2.6} style={{ color: '#4ade80' }} aria-hidden="true" /> : <X size={12} strokeWidth={2.6} aria-hidden="true" />}{k}
              </span>
            ))}
          </p>
          {r.restrictions && <p style={{ color: '#fbbf24' }}>Restrictions: {r.restrictions}</p>}
        </div>
      ))}
    </Panel>
  );
}

function NotificationsPanel({ rec }) {
  if (!rec.notifications.length) return null;
  const tone = { sent: '#4ade80', queued: '#38bdf8', failed: '#f87171', skipped: '#94a3b8', suppressed_synthetic: '#fbbf24', no_permission: '#94a3b8' };
  return (
    <Panel title="Customer notifications">
      {[...rec.notifications].reverse().map(n => (
        <p key={n.id} className="text-xs py-1" style={body}>
          {n.event_key.replace(/_/g, ' ')} · <b style={{ color: tone[n.email_status] || '#94a3b8' }}>{n.email_status.replace(/_/g, ' ')}</b> <span style={faint}>{fmtDateTime(n.created_at)}</span>
          {n.email_error && <span className="block" style={{ color: '#f87171' }}>{n.email_error}</span>}
        </p>
      ))}
    </Panel>
  );
}

// ── Close, decline, reopen, and deletion requests ───────────────────────
function ActionsPanel({ rec, act, canAct, busy, navigate }) {
  const s = rec.submission;
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [c, setC] = useState({ outcome: 'closed', reason: '', customer_message: '' });
  const [d, setD] = useState({ scope: 'submission', reason: 'customer_request', note: '' });
  const [reopenNote, setReopenNote] = useState('');
  const closed = ['closed', 'declined'].includes(s.status);
  const canClose = canAct && s.status !== 'draft' && !closed;
  if (!canAct && rec.deletion_requests.length === 0 && !closed) return null;
  return (
    <Panel title={closed ? (s.status === 'declined' ? 'Declined' : 'Closed') : 'Close or delete'}>
      <div className="flex flex-col gap-3">
        {closed && (
          <div className="flex flex-col gap-2">
            <p className="text-sm" style={body}>{s.close_reason}</p>
            {s.customer_message && <p className="text-xs" style={muted}>Told the customer: “{s.customer_message}”</p>}
            {canAct && s.close_reason !== 'customer_discarded_draft' && (
              <>
                <TextInput value={reopenNote} onChange={e => setReopenNote(e.target.value)} placeholder="Why it’s being reopened (optional)" aria-label="Why it’s being reopened" />
                <GhostButton type="button" disabled={busy} onClick={() => act(() => api.commandIntakeReopen(s.id, reopenNote), 'Reopened')}>Reopen</GhostButton>
              </>
            )}
          </div>
        )}
        {rec.deletion_requests.map(r => (
          <p key={r.id} className="text-xs" style={body}>
            <Link to={`/command/intake/deletions/${r.id}`} className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Deletion request #{r.id}</Link> · {r.scope} · <b style={{ color: r.status === 'open' ? '#fbbf24' : r.status === 'completed' ? '#4ade80' : '#94a3b8' }}>{r.status}</b> <span style={faint}>{fmtDate(r.created_at)}</span>
          </p>
        ))}
        {canClose && (
          <Reveal label="Close or decline…" open={closing} onOpen={() => { setClosing(true); setDeleting(false); }}>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Select value={c.outcome} onChange={e => setC(x => ({ ...x, outcome: e.target.value }))} aria-label="Outcome">
                  <option value="closed">Close</option>
                  <option value="declined">Decline</option>
                </Select>
                <InfoTip label="Close or decline">Close when it’s done, a duplicate or no longer needed. Decline when we can’t take it on — the customer is told why. Nothing is deleted either way.</InfoTip>
              </div>
              <TextInput value={c.reason} onChange={e => setC(x => ({ ...x, reason: e.target.value }))} placeholder="Why (internal)" aria-label="Why (internal)" />
              <TextArea rows={2} value={c.customer_message} onChange={e => setC(x => ({ ...x, customer_message: e.target.value }))} placeholder={c.outcome === 'declined' ? 'What we tell the customer (required)' : 'Message to the customer (optional)'} />
              <div className="flex gap-2">
                <GhostButton type="button" disabled={busy || !c.reason.trim() || (c.outcome === 'declined' && !c.customer_message.trim())}
                  onClick={() => window.confirm(`${c.outcome === 'declined' ? 'Decline' : 'Close'} ${s.public_id}? Nothing is deleted.`) && act(() => api.commandIntakeClose(s.id, c), c.outcome === 'declined' ? 'Declined' : 'Closed')}>
                  {c.outcome === 'declined' ? 'Decline submission' : 'Close submission'}
                </GhostButton>
                <GhostButton type="button" onClick={() => setClosing(false)}>Cancel</GhostButton>
              </div>
            </div>
          </Reveal>
        )}
        {canAct && (
          <Reveal label="Open a deletion request…" open={deleting} onOpen={() => { setDeleting(true); setClosing(false); }}>
            <div className="flex flex-col gap-2">
              <Select value={d.scope} onChange={e => setD(x => ({ ...x, scope: e.target.value }))} aria-label="What to delete">
                <option value="submission">This submission’s footage</option>
                <option value="account">The whole account</option>
              </Select>
              <Select value={d.reason} onChange={e => setD(x => ({ ...x, reason: e.target.value }))} aria-label="Why">
                <option value="customer_request">Customer asked (email or phone)</option>
                <option value="consent_revoked">Consent revoked</option>
                <option value="retention_expired">Retention date passed</option>
                <option value="other">Other</option>
              </Select>
              <TextInput value={d.note} onChange={e => setD(x => ({ ...x, note: e.target.value }))} placeholder="Note" aria-label="Note" />
              <div className="flex gap-2">
                <GhostButton type="button" disabled={busy} onClick={async () => {
                  const r = await act(() => api.commandIntakeOpenDeletion({ scope: d.scope, target_id: d.scope === 'account' ? rec.account.id : s.id, reason: d.reason, note: d.note }), 'Deletion request opened');
                  if (r?.request) navigate(`/command/intake/deletions/${r.request.id}`);
                }}>Open request</GhostButton>
                <GhostButton type="button" onClick={() => setDeleting(false)}>Cancel</GhostButton>
              </div>
            </div>
          </Reveal>
        )}
      </div>
    </Panel>
  );
}
