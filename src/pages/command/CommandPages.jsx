import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { uploadFeed } from '../../lib/mediaUpload';
import BrandMark from '../../components/BrandMark';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Diamond Metrics Command — internal analyst platform (M1: production queue,
// job setup, job detail). Access: admin | analyst | reviewer. Customer
// surfaces never link here. docs/COMMAND_TDR.md is the decision record.

const STATUS_COLORS = {
  not_started: '#64748b', in_progress: '#38bdf8', ready_for_review: '#fbbf24',
  needs_correction: '#f87171', approved: '#4ade80', released: '#4ade80',
  pending: '#64748b', validated: '#4ade80', not_ordered: '#475569',
};

function StatusBadge({ value }) {
  return (
    <span
      className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: STATUS_COLORS[value] || '#94a3b8' }}
    >
      {String(value).replace(/_/g, ' ')}
    </span>
  );
}

function MethodChip({ method }) {
  const colors = { radar_verified: '#4ade80', frame_timed: '#38bdf8', video_estimated: '#fbbf24', manual: '#94a3b8', scorebook_derived: '#94a3b8' };
  return (
    <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: colors[method] || '#94a3b8' }}>
      {String(method).replace(/_/g, ' ')}
    </span>
  );
}

export function CommandLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <header className="border-b" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.9)' }}>
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/command"><BrandMark /></Link>
            <span className="text-xs font-bold tracking-widest uppercase px-2 py-1 rounded" style={{ backgroundColor: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24' }}>
              Command
            </span>
            <nav className="hidden md:flex items-center gap-4 text-sm font-bold">
              <Link to="/command" className="hover:underline" style={{ color: '#cfe8ff' }}>Production Queue</Link>
              <Link to="/command/new" className="hover:underline" style={{ color: '#cfe8ff' }}>New Job</Link>
              {user?.role === 'admin' && <Link to="/admin" className="hover:underline" style={{ color: '#64748b' }}>Admin ↗</Link>}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm hidden sm:inline" style={{ color: '#94a3b8' }}>
              {user?.name || user?.email} · <span className="uppercase text-xs font-bold" style={{ color: '#38bdf8' }}>{user?.role}</span>
            </span>
            <button
              onClick={async () => { await logout(); navigate('/login'); }}
              className="text-sm font-bold px-4 py-2 rounded-xl border cursor-pointer hover:bg-slate-800"
              style={{ borderColor: '#334155', color: '#cfe8ff' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8" style={{ display: 'block' }}>
        <Outlet />
      </main>
    </div>
  );
}

export function ProductionQueuePage() {
  const [data, setData] = useState(null);
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ status: '', analyst: '' });
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.commandJobs(filters), boot ? Promise.resolve(boot) : api.commandBootstrap()])
      .then(([jobs, bootstrap]) => { setData(jobs.jobs); setBoot(bootstrap); })
      .catch(err => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.analyst]);

  const age = iso => {
    const days = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 86400000);
    return days <= 0 ? 'today' : `${days}d`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Production queue</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Every analysis job, its order, and where it stands. Metric release and game record advance independently.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All statuses</option>
            {(boot?.states?.metric_release || []).map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </Select>
          <Select value={filters.analyst} onChange={e => setFilters(f => ({ ...f, analyst: e.target.value }))}>
            <option value="">All analysts</option>
            {(boot?.analysts || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {data === null ? (
        <p style={{ color: '#94a3b8' }}>Loading queue…</p>
      ) : data.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No jobs in the queue</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Create the first analysis job to start production.</p>
          <Link to="/command/new" className="inline-block mt-4 px-4 py-2 rounded-lg text-sm font-bold" style={{ backgroundColor: '#38bdf8', color: '#06122b' }}>+ New Job</Link>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Package</th>
                <th className="px-4 py-3">Metrics</th>
                <th className="px-4 py-3">Metric release</th>
                <th className="px-4 py-3">Game record</th>
                <th className="px-4 py-3">Analyst</th>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Blocker</th>
              </tr>
            </thead>
            <tbody>
              {data.map(j => (
                <tr key={j.id} className="border-t cursor-pointer hover:bg-slate-800/40" style={{ borderColor: '#1e3a5f' }}
                  onClick={() => navigate(`/command/jobs/${j.id}`)}>
                  <td className="px-4 py-3">
                    <p className="font-bold text-white">{j.team_name}{j.opponent_label ? ` vs ${j.opponent_label}` : ''}</p>
                    <p className="text-xs" style={{ color: '#64748b' }}>{j.game_date}{j.tournament_name ? ` · ${j.tournament_name}` : ''}{j.game_type === 'pro_day' ? ' · Pro Day' : ''}</p>
                  </td>
                  <td className="px-4 py-3" style={{ color: '#cfe8ff' }}>{j.order_label}</td>
                  <td className="px-4 py-3" style={{ color: '#94a3b8' }}>{j.requirement_count}</td>
                  <td className="px-4 py-3"><StatusBadge value={j.metric_release_status} /></td>
                  <td className="px-4 py-3"><StatusBadge value={j.game_record_status} /></td>
                  <td className="px-4 py-3" style={{ color: '#cfe8ff' }}>{j.assigned_name || <span style={{ color: '#475569' }}>unassigned</span>}</td>
                  <td className="px-4 py-3" style={{ color: '#94a3b8' }}>{age(j.created_at)}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: j.blocker_reason ? '#f87171' : '#475569' }}>{j.blocker_reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function NewJobPage() {
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    package_key: 'rookie', team_id: '', opponent_label: '', tournament_game_id: '',
    game_date: '', game_type: 'game', event_label: '', assigned_to: '', due_date: '',
    media_consent: true, sharing_scope: 'internal', notes: '', contact_email: '',
  });
  const navigate = useNavigate();

  useEffect(() => { api.commandBootstrap().then(setBoot).catch(err => setError(err.message)); }, []);

  const activeRegistry = useMemo(() => (boot?.registry || []).filter(r => r.active), [boot]);
  const pkg = boot?.packages?.find(p => p.key === form.package_key);
  const requirementPreview = useMemo(() => {
    if (!pkg) return [];
    return pkg.metric_codes
      .map(code => activeRegistry.find(r => r.metric_code === code))
      .filter(Boolean);
  }, [pkg, activeRegistry]);

  // Selecting a shared tournament game auto-fills date and opponent.
  function selectTournamentGame(id) {
    const tg = boot?.tournament_games?.find(g => String(g.id) === String(id));
    if (!tg) { setForm(f => ({ ...f, tournament_game_id: '' })); return; }
    const home = boot.teams.find(t => t.id === tg.home_team_id);
    const teamId = form.team_id || home?.id || '';
    const opponent = Number(teamId) === tg.home_team_id ? tg.away_team_name : tg.home_team_name;
    setForm(f => ({ ...f, tournament_game_id: id, game_date: tg.game_date, team_id: teamId, opponent_label: opponent }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { job } = await api.commandCreateJob({
        ...form,
        team_id: Number(form.team_id),
        tournament_game_id: form.tournament_game_id ? Number(form.tournament_game_id) : null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
      });
      navigate(`/command/jobs/${job.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!boot) return <p style={{ color: '#94a3b8' }}>{error || 'Loading…'}</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Create analysis job</h1>
      <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
        Jobs bind to existing teams and shared games — never duplicate records. The order activates only the purchased metric requirements.
      </p>
      <ErrorNote>{error}</ErrorNote>

      <form onSubmit={submit} className="flex flex-col gap-6">
        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-4" style={{ fontSize: '1.125rem' }}>Game</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Team">
              <Select value={form.team_id} onChange={e => setForm(f => ({ ...f, team_id: e.target.value }))} required>
                <option value="">—</option>
                {boot.teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.age_group || t.organization_name})</option>)}
              </Select>
            </Field>
            <Field label="Linked tournament game (optional)">
              <Select value={form.tournament_game_id} onChange={e => selectTournamentGame(e.target.value)}>
                <option value="">— standalone game —</option>
                {boot.tournament_games.map(g => <option key={g.id} value={g.id}>{g.game_date} · {g.home_team_name} vs {g.away_team_name}</option>)}
              </Select>
            </Field>
            <Field label="Opponent label">
              <TextInput value={form.opponent_label} onChange={e => setForm(f => ({ ...f, opponent_label: e.target.value }))} placeholder="CC Chargers" />
            </Field>
            <Field label="Game date">
              <TextInput type="date" value={form.game_date} onChange={e => setForm(f => ({ ...f, game_date: e.target.value }))} required />
            </Field>
            <Field label="Session type">
              <Select value={form.game_type} onChange={e => setForm(f => ({ ...f, game_type: e.target.value }))}>
                <option value="game">Game</option>
                <option value="pro_day">Pro Day / controlled session</option>
              </Select>
            </Field>
            <Field label="Event label">
              <TextInput value={form.event_label} onChange={e => setForm(f => ({ ...f, event_label: e.target.value }))} placeholder="Salt Lake Summer Classic pool play" />
            </Field>
          </div>
        </section>

        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Order</h2>
          <p className="text-xs mb-4" style={{ color: '#64748b' }}>
            Only implemented modules are orderable. Inactive registry modules unlock as their delivery phase ships.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
            <Field label="Package">
              <Select value={form.package_key} onChange={e => setForm(f => ({ ...f, package_key: e.target.value }))}>
                {boot.packages.filter(p => p.key !== 'pro').map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Assign analyst">
              <Select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">— unassigned —</option>
                {boot.analysts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
              </Select>
            </Field>
            <Field label="Due date">
              <TextInput type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
            </Field>
          </div>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Activated metric requirements</p>
          <div className="flex flex-wrap gap-2">
            {requirementPreview.map(r => (
              <span key={r.metric_code} className="flex items-center gap-2 text-xs font-bold px-2.5 py-1.5 rounded-lg border" style={{ borderColor: '#1e3a5f', color: '#cfe8ff' }}>
                {r.label} <MethodChip method={r.method} />
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-4" style={{ fontSize: '1.125rem' }}>Consent & notes</h2>
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: '#cfe8ff' }}>
              <input
                type="checkbox"
                checked={form.media_consent}
                onChange={e => setForm(f => ({ ...f, media_consent: e.target.checked }))}
                className="accent-sky-400"
              />
              Order includes media consent (recorded and auditable; legal language pending)
            </label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label="Customer contact email (notifications)">
                <TextInput type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} placeholder="coach@example.com" />
              </Field>
              <Field label="Sharing scope">
                <Select value={form.sharing_scope} onChange={e => setForm(f => ({ ...f, sharing_scope: e.target.value }))}>
                  <option value="internal">Internal only</option>
                  <option value="customer">Customer (numbers only in V1)</option>
                </Select>
              </Field>
              <Field label="Notes">
                <TextInput value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Radar CSV expected from tournament ops" />
              </Field>
            </div>
          </div>
        </section>

        <div>
          <PrimaryButton type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create job'}</PrimaryButton>
        </div>
      </form>
    </div>
  );
}

export function JobDetailPage() {
  const { jobId } = useParams();
  const { user } = useAuth();
  const [job, setJob] = useState(null);
  const [boot, setBoot] = useState(null);
  const [feeds, setFeeds] = useState([]);
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.commandJob(jobId).then(d => setJob(d.job)).catch(err => setError(err.message));
    api.commandBootstrap().then(setBoot).catch(() => {});
    api.commandJobFeeds(jobId).then(d => setFeeds(d.feeds)).catch(() => {});
  }, [jobId]);

  // Poll while any feed is mid-pipeline so statuses land without refreshes.
  useEffect(() => {
    const busy = feeds.some(f => ['uploading', 'uploaded', 'queued', 'processing', 'retrying'].includes(f.status));
    if (!busy) return;
    const t = setInterval(() => {
      api.commandJobFeeds(jobId).then(d => setFeeds(d.feeds)).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [feeds, jobId]);

  async function handleUpload(file) {
    if (!file) return;
    setError('');
    setUploadPct(0);
    try {
      await uploadFeed(jobId, file, { label: 'Behind Home', onProgress: p => setUploadPct(p) });
      const d = await api.commandJobFeeds(jobId);
      setFeeds(d.feeds);
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploadPct(null);
    }
  }

  async function transition(kind, to) {
    setError('');
    try {
      const { job: updated } = await api.commandJobStatus(jobId, kind, to);
      setJob(updated);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleRequirement(r) {
    try {
      await api.commandToggleRequirement(r.id, !r.enabled);
      const { job: updated } = await api.commandJob(jobId);
      setJob(updated);
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !job) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!job) return <p style={{ color: '#94a3b8' }}>Loading job…</p>;

  const nextMetric = {
    not_started: ['in_progress'], in_progress: ['ready_for_review'],
    ready_for_review: ['approved', 'needs_correction'], needs_correction: ['in_progress'],
    approved: ['released'], released: ['needs_correction'],
  }[job.metric_release_status] || [];

  return (
    <div>
      <Link to="/command" className="text-xs hover:underline" style={{ color: '#64748b' }}>← Production queue</Link>
      <div className="flex items-start justify-between gap-4 mt-1 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {job.team_name}{job.opponent_label ? ` vs ${job.opponent_label}` : ''}
          </h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            {job.game_date} · {job.order_label}{job.tournament_name ? ` · ${job.tournament_name}` : ''}{job.game_type === 'pro_day' ? ' · Pro Day session' : ''}
            {job.media_consent ? '' : ' · no media consent'}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <StatusBadge value={job.metric_release_status} />
          <span className="text-xs" style={{ color: '#475569' }}>metrics</span>
          <StatusBadge value={job.game_record_status} />
          <span className="text-xs" style={{ color: '#475569' }}>game record</span>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="flex flex-col gap-6">
        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Video feeds</h2>
          <p className="text-xs mb-3" style={{ color: '#64748b' }}>
            Originals stream to storage in resumable 50 MB parts; the worker inspects, flags VFR, and builds the constant-frame-rate review proxy.
          </p>
          {feeds.length === 0 && <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>No feeds attached yet.</p>}
          {feeds.map(f => (
            <div key={f.id} className="flex items-center justify-between gap-3 py-2.5 border-t" style={{ borderColor: '#1e3a5f' }}>
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  {f.label} <span className="font-normal text-xs" style={{ color: '#64748b' }}>{f.original_name}</span>
                </p>
                <p className="text-xs" style={{ color: '#64748b' }}>
                  {f.width ? `${f.width}×${f.height} · ` : ''}{f.effective_fps ? `${f.effective_fps.toFixed(2)} fps · ` : ''}
                  {f.vfr ? 'VFR (normalized in proxy) · ' : ''}{f.error || ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge value={f.status} />
                {f.status === 'ready' && (
                  <Link to={`/command/feeds/${f.id}`} className="text-xs font-bold hover:underline" style={{ color: '#38bdf8' }}>Open viewer</Link>
                )}
                {['failed', 'retrying'].includes(f.status) && (
                  <GhostButton onClick={async () => { await api.commandRetryFeed(f.id).catch(e => setError(e.message)); const d = await api.commandJobFeeds(jobId); setFeeds(d.feeds); }}>Retry</GhostButton>
                )}
              </div>
            </div>
          ))}
          <div className="mt-3">
            {uploadPct == null ? (
              <label className="inline-block px-4 py-2 rounded-lg text-sm font-bold cursor-pointer" style={{ backgroundColor: '#38bdf8', color: '#06122b' }}>
                + Attach video feed
                <input type="file" accept="video/*,.mp4,.mov,.mts,.m2ts" className="hidden" onChange={e => handleUpload(e.target.files?.[0])} />
              </label>
            ) : (
              <div className="w-full rounded-full h-2 overflow-hidden" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)' }}>
                <div className="h-2 rounded-full transition-all" style={{ width: `${Math.round(uploadPct * 100)}%`, backgroundColor: '#38bdf8' }} />
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Metric requirements</h2>
          <p className="text-xs mb-4" style={{ color: '#64748b' }}>The job checklist is generated from these. M2 adds feeds + capture readiness against them.</p>
          {job.requirements.map(r => (
            <div key={r.id} className="flex items-center justify-between py-2.5 border-t gap-3" style={{ borderColor: '#1e3a5f' }}>
              <div className="min-w-0">
                <p className="text-sm font-bold" style={{ color: r.enabled ? '#f8fafc' : '#475569' }}>
                  {r.label} <span className="ml-1 text-[10px] font-bold uppercase" style={{ color: '#64748b' }}>tier {r.availability_tier} · {r.recipe_version}</span>
                </p>
                <p className="text-xs truncate" style={{ color: '#64748b' }}>{r.capture_requirements}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <MethodChip method={r.method} />
                <GhostButton onClick={() => toggleRequirement(r)}>{r.enabled ? 'Disable' : 'Enable'}</GhostButton>
              </div>
            </div>
          ))}
        </section>
        </div>

        <div className="flex flex-col gap-6">
          <section className="rounded-2xl border p-6" style={cardStyle}>
            <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Status</h2>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>
              Approve/release requires reviewer or admin. Signed in as <b style={{ color: '#38bdf8' }}>{user?.role}</b>.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                to={`/command/jobs/${job.id}/radar`}
                className="px-4 py-2 rounded-xl text-sm font-bold"
                style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}
              >
                Radar queue →
              </Link>
              <Link
                to={`/command/jobs/${job.id}/running`}
                className="px-4 py-2 rounded-xl text-sm font-bold"
                style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}
              >
                Running queue →
              </Link>
              {nextMetric.map(to => (
                <PrimaryButton key={to} onClick={() => transition('metric_release', to)}>
                  Metrics → {to.replace(/_/g, ' ')}
                </PrimaryButton>
              ))}
              {job.game_record_status === 'pending' && (
                <GhostButton onClick={() => transition('game_record', 'not_ordered')}>Game record: not ordered</GhostButton>
              )}
              {job.game_record_status === 'not_ordered' && (
                <GhostButton onClick={() => transition('game_record', 'pending')}>Game record: reopen</GhostButton>
              )}
            </div>
          </section>

          <section className="rounded-2xl border p-6" style={cardStyle}>
            <h2 className="text-lg font-bold text-white mb-3" style={{ fontSize: '1.125rem' }}>Assignment</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Analyst">
                <Select
                  value={job.assigned_to || ''}
                  onChange={async e => {
                    try {
                      const { job: updated } = await api.commandUpdateJob(job.id, { assigned_to: e.target.value ? Number(e.target.value) : null });
                      setJob(updated);
                    } catch (err) { setError(err.message); }
                  }}
                >
                  <option value="">— unassigned —</option>
                  {(boot?.analysts || []).map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
                </Select>
              </Field>
              <Field label="Blocker reason">
                <TextInput
                  value={job.blocker_reason || ''}
                  onChange={e => setJob(jb => ({ ...jb, blocker_reason: e.target.value }))}
                  onBlur={async e => {
                    try {
                      const { job: updated } = await api.commandUpdateJob(job.id, { blocker_reason: e.target.value });
                      setJob(updated);
                    } catch (err) { setError(err.message); }
                  }}
                  placeholder="waiting on footage"
                />
              </Field>
            </div>
          </section>

          <section className="rounded-2xl border p-6" style={cardStyle}>
            <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Game record sources</h2>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>
              GameChanger scorecards and manual scores attach here for later validation — they never block metric release.
            </p>
            {(job.game_record_sources || []).length === 0 ? (
              <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>No game-record source attached yet.</p>
            ) : (job.game_record_sources || []).map(g => (
              <p key={g.id} className="text-xs py-1.5 border-t" style={{ borderColor: '#1e3a5f', color: '#cfe8ff' }}>
                <b>{g.source_kind.replace(/_/g, ' ')}</b>{g.label ? ` · ${g.label}` : ''} ·{' '}
                <span style={{ color: '#fbbf24' }}>{g.validation_status.replace(/_/g, ' ')}</span>
                <span style={{ color: '#475569' }}> · {g.created_by_name || ''} {g.created_at}</span>
              </p>
            ))}
            <GhostButton
              onClick={async () => {
                try {
                  const label = window.prompt('Source label (e.g. GameChanger export — vs Chargers 8/7):');
                  if (label === null) return;
                  const { job: updated } = await api.commandAttachGameRecordSource(job.id, { source_kind: 'gamechanger_export', label });
                  setJob(updated);
                } catch (err) { setError(err.message); }
              }}
            >
              + Attach GameChanger scorecard
            </GhostButton>
          </section>

          <section className="rounded-2xl border p-6" style={cardStyle}>
            <h2 className="text-lg font-bold text-white mb-1" style={{ fontSize: '1.125rem' }}>Customer notifications</h2>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>
              Auditable events{job.contact_email ? ` · contact: ${job.contact_email}` : ' · no contact email on order'} · email sends automatically once the provider is configured.
            </p>
            {(job.notifications || []).length === 0 ? (
              <p className="text-sm" style={{ color: '#94a3b8' }}>No events yet.</p>
            ) : (job.notifications || []).map(n => (
              <p key={n.id} className="text-xs py-1.5 border-t" style={{ borderColor: '#1e3a5f', color: '#cfe8ff' }}>
                <b>{n.event_key.replace(/_/g, ' ')}</b> · {n.audience} ·{' '}
                <span style={{ color: n.email_status === 'sent' ? '#4ade80' : n.email_status === 'failed' ? '#f87171' : '#64748b' }}>email {n.email_status}</span>
                <span style={{ color: '#475569' }}> · {n.created_at}</span>
              </p>
            ))}
          </section>

          <section className="rounded-2xl border p-6" style={cardStyle}>
            <h2 className="text-lg font-bold text-white mb-3" style={{ fontSize: '1.125rem' }}>Audit trail</h2>
            {job.audit.length === 0 ? (
              <p className="text-sm" style={{ color: '#94a3b8' }}>No actions yet.</p>
            ) : job.audit.map(a => (
              <p key={a.id} className="text-xs py-1.5 border-t" style={{ borderColor: '#1e3a5f', color: '#94a3b8' }}>
                <b style={{ color: '#cfe8ff' }}>{a.actor_name || 'system'}</b> · {a.action.replace(/_/g, ' ')}
                {a.prev_state || a.new_state ? <span> · {a.prev_state || '—'} → <b style={{ color: '#f8fafc' }}>{a.new_state || '—'}</b></span> : null}
                {a.note ? <span> · {a.note}</span> : null}
                <span style={{ color: '#475569' }}> · {a.created_at}</span>
              </p>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
