// What a customer sees after submitting (customer footage submission §3 step
// 6–7, §9, §10): their own submissions, each with received → processing →
// analysis → metrics ready, the game record tracked separately, requests
// from our team, results with plain-language reasons, and deletion requests.
// Never internal notes, match confidence, diagnostics or anyone else's data.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useIntakeConfig, fmtDate, fmtDateTime, timeAgo, GAME_RECORD_LABEL } from '../../lib/intake';
import { PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import { Card, PageTitle, Banner, StatusPill, TextArea, SectionTitle, Issues } from './ui';
import { EmailVerifyBanner } from './AccountPages';
import UploadPanel from './UploadPanel';

const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };
const CHECKING = ['uploaded', 'processing'];

export function MySubmissionsPage() {
  const [list, setList] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => Promise.all([api.intakeSubmissions(), api.customerMe()])
    .then(([l, m]) => { setList(l.submissions); setMe(m); })
    .catch(err => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!list) return <><ErrorNote>{error}</ErrorNote>{!error && <p style={muted}>Loading your submissions…</p>}</>;
  const drafts = list.filter(s => s.status.key === 'draft');
  const sent = list.filter(s => s.status.key !== 'draft');
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="My submissions"
        actions={<Link to="/submit?source=my_submissions" className="px-4 py-2 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>Submit footage</Link>} />
      <EmailVerifyBanner me={me} onChecked={load} />
      {drafts.length > 0 && (
        <div>
          <SectionTitle>Not sent yet</SectionTitle>
          <div className="flex flex-col gap-3">
            {drafts.map(s => <SubmissionCard key={s.public_id} s={s} to={`/submit/${s.public_id}`} action="Continue" />)}
          </div>
        </div>
      )}
      <div>
        {drafts.length > 0 && <SectionTitle>Sent</SectionTitle>}
        {sent.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-white font-bold mb-4">No submissions yet</p>
            <Link to="/submit?source=my_submissions" className="inline-block px-4 py-2 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>Submit footage</Link>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {sent.map(s => <SubmissionCard key={s.public_id} s={s} to={`/submissions/${s.public_id}`} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function SubmissionCard({ s, to, action }) {
  const what = [s.game_date && fmtDate(s.game_date), s.team && `${s.team}${s.opponent ? ` vs ${s.opponent}` : ''}`].filter(Boolean).join(' · ');
  return (
    <Link to={to} className="block rounded-2xl border p-4 hover:bg-slate-800/40 transition-colors" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }} data-testid={`submission-${s.public_id}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white">
            {what || (s.kind === 'inquiry' ? 'Hall of Fame request' : 'Game details not added yet')}
            {s.test && <span className="ml-2 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded align-middle" style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>test</span>}
          </p>
          <p className="text-xs mt-1" style={muted}>
            {s.public_id}{s.package_label ? ` · ${s.package_label}` : ''}{s.athletes.length ? ` · ${s.athletes.join(', ')}` : ''}
          </p>
        </div>
        <div className="flex sm:flex-col items-center sm:items-end gap-2 shrink-0">
          <StatusPill status={s.status} focusable={false} />
          <span className="text-xs" style={faint}>{action ? <span className="font-bold" style={{ color: '#38bdf8' }}>{action} →</span> : `updated ${timeAgo(s.updated_at)}`}</span>
        </div>
      </div>
    </Link>
  );
}

// Received → checking → analysis → metrics ready, with the full game record
// (box score) on its own line: metrics can be ready while it is in progress.
const STAGES = ['Received', 'Footage checked', 'In analysis', 'Metrics ready'];
// How many stages are finished, and which one (if any) is under way.
const PLAN = {
  processing: { done: 1, active: 1 },
  received: { done: 2, active: null },
  analysis: { done: 2, active: 2 },
  metrics_ready: { done: 4, active: null },
  complete: { done: 4, active: null },
};

function Progress({ sub }) {
  const key = sub.status.key;
  if (['closed', 'declined'].includes(key) || sub.kind === 'inquiry') return null;
  const record = sub.status.game_record;   // set once a Command job exists
  const plan = PLAN[key] || (record ? { done: 2, active: 2 } : { done: 1, active: 1 });   // action required: wherever it stopped
  return (
    <Card className="p-5" data-testid="progress">
      <ol className="grid grid-cols-4 gap-2">
        {STAGES.map((label, i) => {
          const done = i < plan.done;
          const active = i === plan.active;
          const color = done ? '#4ade80' : active ? (key === 'action_required' ? '#fbbf24' : '#38bdf8') : '#334155';
          return (
            <li key={label} className="flex flex-col gap-2" data-state={done ? 'done' : active ? 'active' : 'todo'}>
              <div className="h-1.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-xs font-bold" style={{ color: done || active ? '#e2e8f0' : '#64748b' }}>{label}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 pt-4 border-t flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: '#1e3a5f' }} data-testid="game-record">
        <span className="text-sm flex items-center gap-1.5" style={{ color: '#cbd5e1' }}>
          Full game record (box score)
          <InfoTip label="About the game record">The box score is finished separately from your metrics, so metrics can be ready first.</InfoTip>
        </span>
        <span className="text-sm font-bold" style={{ color: record === 'complete' ? '#4ade80' : record === 'in_progress' ? '#38bdf8' : '#94a3b8' }}>
          {record ? GAME_RECORD_LABEL[record] : 'Not started'}
        </span>
      </div>
    </Card>
  );
}

function Results({ results }) {
  if (!results) return null;
  if (results.athletes.length === 0) {
    return <Card className="p-5"><SectionTitle>Results</SectionTitle><p className="text-sm" style={muted}>Results appear once the athletes in this game are confirmed.</p></Card>;
  }
  return (
    <Card className="p-5" data-testid="results">
      <SectionTitle hint="Every result is reviewed by an analyst. An unavailable metric is never counted as zero in your averages.">Results</SectionTitle>
      <div className="flex flex-col gap-6">
        {results.athletes.map(a => (
          <div key={a.name}>
            <p className="text-base font-bold text-white mb-2">{a.name}</p>
            <div className="flex flex-col">
              {a.metrics.map(m => (
                <div key={m.metric} className="py-2.5 border-t first:border-t-0 grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-1" style={{ borderColor: '#1e3a5f' }}>
                  <p className="text-sm font-bold" style={{ color: '#cfe8ff' }}>{m.metric}</p>
                  {m.available ? (
                    <div>
                      <p className="text-sm text-white">
                        {m.values.map(v => <span key={v.label} className="mr-4"><span style={muted}>{v.label}: </span><b>{v.value}{v.unit ? ` ${v.unit}` : ''}</b></span>)}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-wider mt-0.5" style={{ color: '#4ade80' }}>{m.source}</p>
                    </div>
                  ) : (
                    <p className="text-sm font-bold flex items-center gap-1.5" style={{ color: '#fbbf24' }} data-testid="unavailable">
                      Unavailable
                      {m.reasons.length > 0 && <InfoTip label={`Why ${m.metric} is unavailable`}>{m.reasons.join(' ')}</InfoTip>}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Reply({ publicId, onSent, prompt }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    setBusy(true); setError('');
    try { const { submission } = await api.intakeReply(publicId, text); setText(''); onSent(submission); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2">
      <TextArea value={text} onChange={e => setText(e.target.value)} placeholder={prompt} maxLength={2000} data-testid="reply" />
      <ErrorNote>{error}</ErrorNote>
      <div><PrimaryButton type="button" onClick={send} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</PrimaryButton></div>
    </div>
  );
}

function MessageUs({ publicId, onSent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 pt-4 border-t" style={{ borderColor: '#1e3a5f' }}>
      {open
        ? <Reply publicId={publicId} onSent={x => { setOpen(false); onSent(x); }} prompt="A question or something we should know about this game…" />
        : <button type="button" onClick={() => setOpen(true)} className="text-sm font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Send us a message</button>}
    </div>
  );
}

function Deletion({ sub, publicId, onDone }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  if (sub.deletion?.status === 'open') {
    return <p className="text-xs" style={muted}>Deletion requested {fmtDate(sub.deletion.created_at)} — we’ll confirm when it’s done.</p>;
  }
  if (sub.deletion?.status === 'completed') return <p className="text-xs" style={muted}>Deletion completed.</p>;
  if (!sub.can.request_deletion) return null;
  async function request() {
    setError('');
    try { const { submission } = await api.intakeRequestDeletion(publicId, note); setOpen(false); onDone(submission); }
    catch (err) { setError(err.message); }
  }
  return open ? (
    <div className="flex flex-col gap-3">
      <p className="text-sm flex items-center gap-1.5" style={{ color: '#cbd5e1' }}>
        We’ll delete the footage and every copy made from it.
        <InfoTip>We confirm with you when it’s done. Results already delivered may stay unless you ask us to withdraw them.</InfoTip>
      </p>
      <TextArea value={note} onChange={e => setNote(e.target.value)} placeholder="Anything we should know? (optional)" rows={2} />
      <ErrorNote>{error}</ErrorNote>
      <div className="flex gap-2">
        <PrimaryButton type="button" onClick={request} style={{ backgroundColor: '#f87171' }}>Request deletion</PrimaryButton>
        <GhostButton type="button" onClick={() => setOpen(false)}>Cancel</GhostButton>
      </div>
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="text-xs font-bold hover:underline cursor-pointer" style={{ color: '#94a3b8' }}>Ask us to delete this footage</button>
  );
}

export function SubmissionStatusPage() {
  const { publicId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const config = useIntakeConfig();
  const [sub, setSub] = useState(null);
  const [error, setError] = useState('');
  const justSent = params.get('sent') === '1';

  const refresh = useCallback(() => api.intakeSubmission(publicId).then(({ submission }) => {
    if (submission.status.key === 'draft') { navigate(`/submit/${publicId}`, { replace: true }); return null; }
    setSub(submission);
    return submission;
  }), [publicId, navigate]);

  useEffect(() => {
    refresh().catch(err => setError(err.status === 404 ? 'We couldn’t find that submission.' : err.message));
  }, [refresh]);

  // While a video is still being checked, keep the page current. (The upload
  // panel polls for itself when it is showing.)
  const checking = !!sub && !sub.can.add_files && sub.files.some(f => CHECKING.includes(f.status));
  useEffect(() => {
    if (!checking) return undefined;
    const t = setInterval(() => { refresh().catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [checking, refresh]);

  if (error) return <Banner tone="error" title="Something went wrong">{error} <Link to="/submissions" className="font-bold underline">Back to my submissions</Link></Banner>;
  if (!sub || !config) return <p style={muted}>Loading…</p>;

  const s = sub.status;
  const g = sub.game;
  const action = s.key === 'action_required';
  const timeline = [...sub.timeline].reverse();
  const views = Object.fromEntries(config.camera_views.map(v => [v.key, v.label]));
  const kinds = Object.fromEntries(config.file_kinds.map(k => [k.key, k.label]));

  return (
    <div className="flex flex-col gap-6" data-testid="submission-status" data-status={s.key}>
      {justSent && (
        <Banner tone="success" title={sub.kind === 'inquiry' ? 'Request received' : 'Submission received'}>
          Your number is <b className="text-white" data-testid="public-id">{sub.public_id}</b>. {sub.kind === 'inquiry'
            ? 'Our team will contact you to plan the capture.'
            : 'We’ll keep this page updated, and ask here if we need anything.'}
        </Banner>
      )}
      <PageTitle eyebrow={`Submission ${sub.public_id}`} title={[g.date && fmtDate(g.date), g.team && `${g.team}${g.opponent ? ` vs ${g.opponent}` : ''}`].filter(Boolean).join(' · ') || (sub.kind === 'inquiry' ? 'Hall of Fame request' : 'Your submission')}
        actions={<StatusPill status={s} />}>
        {sub.test && <span className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>Test</span>}
      </PageTitle>

      <Progress sub={sub} />

      {action && (
        <Card className="p-5" style={{ borderColor: 'rgba(251, 191, 36, 0.5)' }} data-testid="action-required">
          <SectionTitle>We need something from you</SectionTitle>
          <p className="text-sm mb-4 whitespace-pre-line" style={{ color: '#e2e8f0' }}>{sub.message || s.detail}</p>
          {sub.can.add_files && (
            <div className="mb-5">
              <UploadPanel publicId={publicId} config={config} sub={sub} onRefresh={refresh} />
            </div>
          )}
          {sub.can.reply && <Reply publicId={publicId} onSent={setSub} prompt="Reply to our team…" />}
        </Card>
      )}

      <Results results={sub.results} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] gap-6 items-start">
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <SectionTitle>Updates</SectionTitle>
            <ol className="flex flex-col" data-testid="timeline">
              {timeline.map(e => (
                <li key={e.id} className="py-2.5 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }}>
                  <p className="text-xs" style={faint}><b style={{ color: e.from === 'You' ? '#cfe8ff' : '#38bdf8' }}>{e.from}</b> · {fmtDateTime(e.at)}</p>
                  <p className="text-sm mt-0.5 whitespace-pre-line" style={{ color: '#e2e8f0' }}>{e.message}</p>
                </li>
              ))}
            </ol>
            {sub.can.reply && !action && <MessageUs publicId={publicId} onSent={setSub} />}
          </Card>
          {!(action && sub.can.add_files) && sub.files.length > 0 && (
            <Card className="p-5">
              <SectionTitle>Files</SectionTitle>
              <Issues issues={sub.capture_notes} className="mb-1" />
              {sub.files.map(f => (
                <div key={f.id} className="py-2.5 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }} data-testid={`file-${f.id}`}>
                  <div className="flex justify-between gap-3">
                    <p className="text-sm font-bold text-white min-w-0 truncate">{f.kind === 'video' ? (f.label || views[f.camera_view]) : kinds[f.kind]}</p>
                    <span className="text-xs font-bold shrink-0" style={{ color: f.status === 'ready' ? '#4ade80' : f.status === 'needs_customer_action' ? '#f87171' : '#38bdf8' }}>{f.status_label}</span>
                  </div>
                  <p className="text-xs truncate" style={faint}>{f.original_name}{f.summary ? ` · ${f.summary}` : ''}</p>
                  <Issues issues={f.issues} />
                </div>
              ))}
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <SectionTitle>Details</SectionTitle>
            <dl className="text-sm flex flex-col gap-2">
              <div><dt className="text-xs" style={faint}>Package</dt><dd style={{ color: '#e2e8f0' }}>{sub.package?.label || '—'}</dd></div>
              {(g.event || g.level) && <div><dt className="text-xs" style={faint}>Event</dt><dd style={{ color: '#e2e8f0' }}>{[g.event, g.level].filter(Boolean).join(' · ')}</dd></div>}
              {g.location && <div><dt className="text-xs" style={faint}>Location</dt><dd style={{ color: '#e2e8f0' }}>{g.location}</dd></div>}
              {sub.athletes.length > 0 && <div><dt className="text-xs" style={faint}>Athletes</dt><dd style={{ color: '#e2e8f0' }}>{sub.athletes.map(a => `${a.first_name} ${a.last_name}`.trim()).join(', ')}</dd></div>}
              <div><dt className="text-xs" style={faint}>Submitted</dt><dd style={{ color: '#e2e8f0' }}>{fmtDateTime(sub.submitted_at)}</dd></div>
              {sub.rights && (
                <div>
                  <dt className="text-xs" style={faint}>Footage terms</dt>
                  <dd className="flex items-center gap-1.5" style={{ color: '#e2e8f0' }}>
                    {sub.rights.action === 'revoke' ? 'Withdrawn' : `Accepted ${fmtDate(sub.rights.accepted_at)}`}
                    <InfoTip label="About the footage terms">
                      {`Version ${sub.rights.version}. Kept ${sub.rights.retention_days} days after upload.${sub.rights.permitted_uses?.improvement ? ' You allowed use to improve our tools.' : ''}${sub.rights.contact_permission ? '' : ' You asked us not to contact you about it.'}`}
                    </InfoTip>
                  </dd>
                </div>
              )}
            </dl>
            {(sub.deletion || sub.can.request_deletion) && (
              <div className="mt-4 pt-3 border-t" style={{ borderColor: '#1e3a5f' }}><Deletion sub={sub} publicId={publicId} onDone={setSub} /></div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
