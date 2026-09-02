import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { PrimaryButton, GhostButton, TextInput, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Review & publish (Command M5). The reviewer sees QA flags, every active
// result with evidence, and the exact rollups that will publish — approves
// per result, then releases. Release runs the adapter: approved rollups land
// on the player profile; unavailable stays unavailable with its reason.

const STATUS_COLORS = { draft: '#fbbf24', approved: '#4ade80', published: '#38bdf8', unavailable: '#94a3b8' };

function StatusChip({ value }) {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: STATUS_COLORS[value] || '#94a3b8' }}>
      {value}
    </span>
  );
}

function QaFlag({ flag }) {
  const blocking = flag.level === 'blocking';
  return (
    <div className="rounded-xl border px-4 py-2.5" style={{
      borderColor: blocking ? 'rgba(248, 113, 113, 0.5)' : 'rgba(251, 191, 36, 0.35)',
      backgroundColor: blocking ? 'rgba(248, 113, 113, 0.08)' : 'rgba(251, 191, 36, 0.06)',
    }}>
      <p className="text-sm font-bold" style={{ color: blocking ? '#f87171' : '#fbbf24' }}>
        {blocking ? '⛔ ' : '⚠ '}{flag.label}
      </p>
      <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>{flag.detail}</p>
    </div>
  );
}

export default function ReviewPage() {
  const { jobId } = useParams();
  const { user } = useAuth();
  const canDecide = ['reviewer', 'admin'].includes(user?.role);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [releasing, setReleasing] = useState(false);
  const [overrideNote, setOverrideNote] = useState({});

  const load = useCallback(() => api.commandReview(jobId).then(setData).catch(err => setError(err.message)), [jobId]);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    if (!data) return [];
    const byPlayer = new Map();
    for (const r of data.results) {
      if (!byPlayer.has(r.player_id)) {
        byPlayer.set(r.player_id, { player_id: r.player_id, name: `${r.first_name} ${r.last_name}`, slug: r.slug, metrics: new Map() });
      }
      const g = byPlayer.get(r.player_id);
      if (!g.metrics.has(r.metric_code)) g.metrics.set(r.metric_code, []);
      g.metrics.get(r.metric_code).push(r);
    }
    return [...byPlayer.values()].map(g => ({ ...g, metrics: [...g.metrics.entries()] }));
  }, [data]);

  async function submitOverride(metricCode) {
    setError('');
    try {
      await api.commandCaptureOverride(jobId, metricCode, overrideNote[metricCode] || '');
      setOverrideNote(v => ({ ...v, [metricCode]: '' }));
      await load();
    } catch (err) { setError(err.message); }
  }

  async function removeOverride(metricCode) {
    setError('');
    try {
      await api.commandRemoveCaptureOverride(jobId, metricCode);
      await load();
    } catch (err) { setError(err.message); }
  }

  async function decide(resultId, decision) {
    setError('');
    try {
      await api.commandDecideResult(resultId, decision);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function transition(to) {
    setError('');
    setReleasing(to === 'released');
    try {
      await api.commandJobStatus(jobId, 'metric_release', to);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setReleasing(false);
    }
  }

  if (!data) return <p style={{ color: '#94a3b8' }}>{error || 'Loading review…'}</p>;

  const { job, qa_flags, metrics, capture = [] } = data;
  const metricInfo = code => metrics.find(m => m.metric_code === code) || { label: code, unit: '', decimals: 2 };
  const planFor = (playerId, code) => data.plan.find(p => p.player_id === playerId && p.metric_code === code);
  const blocking = qa_flags.filter(f => f.level === 'blocking');
  const status = job.metric_release_status;
  const evidenceLine = r => {
    if (r.evidence_kind === 'measurement') return `frames ${r.start_frame}–${r.end_frame} @ ${r.fps_used} fps`;
    if (r.evidence_kind === 'radar_reading') {
      // Provenance first (file, row, raw reading), then the analyst's
      // confirmation as a separate clause — the source never becomes "manual"
      // because someone confirmed it.
      const origin = r.reading_source === 'manual'
        ? `manual radar entry${r.reading_created_by_name ? ` by ${r.reading_created_by_name}` : ''}`
        : `CSV ${r.reading_import_filename || ''} · row ${r.reading_row ?? '?'}${r.reading_velocity != null ? ` · raw ${r.reading_velocity} mph` : ''}`;
      const when = r.source_timestamp ? ` · ${r.source_timestamp}` : '';
      const type = r.pitch_type && r.pitch_type !== 'unknown' ? ` · ${r.pitch_type}` : '';
      const confirmed = r.reading_confirmed_by_name
        ? ` · confirmed by ${r.reading_confirmed_by_name}${r.reading_confirmed_at ? ` ${String(r.reading_confirmed_at).slice(0, 16)} UTC` : ''}`
        : '';
      return `${origin}${when}${type}${confirmed}`;
    }
    return r.evidence_kind;
  };

  return (
    <div>
      <Link to={`/command/jobs/${jobId}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-center justify-between gap-3 mt-1 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Review &amp; publish</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Approve each verified result, then release — approved rollups publish to player profiles. Nothing unapproved or unavailable ever does.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip value={status} />
          {canDecide && status === 'ready_for_review' && (
            <>
              <GhostButton onClick={() => transition('needs_correction')}>Needs correction</GhostButton>
              <PrimaryButton onClick={() => transition('approved')} disabled={blocking.length > 0}>Approve job</PrimaryButton>
            </>
          )}
          {canDecide && status === 'approved' && (
            <PrimaryButton onClick={() => transition('released')} disabled={releasing}>
              {releasing ? 'Releasing…' : 'Release metrics'}
            </PrimaryButton>
          )}
          {canDecide && status === 'released' && (
            <GhostButton onClick={() => transition('needs_correction')}>Reopen for correction</GhostButton>
          )}
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* What each state means, and the guarantee that matters. */}
      <div className="rounded-2xl border p-4 mb-4" style={cardStyle}>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Result states</span>
          {[
            ['draft', 'measured, not yet reviewed'],
            ['approved', 'reviewed — publishes on release'],
            ['published', 'live on the athlete profile'],
            ['unavailable', 'could not be measured — never a zero'],
          ].map(([k, meaning]) => (
            <span key={k} className="flex items-center gap-1.5">
              <StatusChip value={k} />
              <span className="text-xs" style={{ color: '#64748b' }}>{meaning}</span>
            </span>
          ))}
        </div>
        <p className="text-xs mt-2.5" style={{ color: '#475569' }}>
          Nothing reaches an athlete&apos;s profile until it is approved <em>and</em> the job is released — a draft result cannot affect a profile.
        </p>
      </div>

      {/* Recipe-based capture QA, per ordered metric. */}
      {capture.length > 0 && (
        <section className="rounded-2xl border p-5 mb-4" style={cardStyle}>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Capture requirements</p>
          {capture.map(c => {
            const tone = { ok: '#4ade80', warning: '#fbbf24', blocked: '#f87171', overridden: '#fbbf24', not_applicable: '#64748b' }[c.status];
            return (
              <div key={c.metric_code} className="py-2 border-t" style={{ borderColor: '#1e3a5f' }}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm font-bold text-white">{c.label}</span>
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: tone }}>
                    {c.status === 'not_applicable' ? `derived from ${c.derived_from?.replace(/_/g, ' ')}` : c.status}
                  </span>
                </div>
                {c.best_feed && (
                  <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>
                    best feed: {c.best_feed.name} — {c.best_feed.height}p · {c.best_feed.fps ? Number(c.best_feed.fps.toFixed(2)) : '?'} fps
                  </p>
                )}
                {(c.issues || []).map((i, n) => (
                  <p key={n} className="text-xs mt-0.5" style={{ color: i.severity === 'blocking' ? '#f87171' : '#fbbf24' }}>{i.detail}</p>
                ))}
                {c.override && <p className="text-xs mt-0.5" style={{ color: '#fbbf24' }}>Override on record: &ldquo;{c.override.note}&rdquo;</p>}
                {canDecide && c.status === 'blocked' && (
                  <div className="flex gap-2 mt-2">
                    <TextInput
                      value={overrideNote[c.metric_code] || ''}
                      onChange={e => setOverrideNote(v => ({ ...v, [c.metric_code]: e.target.value }))}
                      placeholder="Reason for overriding this requirement"
                    />
                    <GhostButton onClick={() => submitOverride(c.metric_code)}>Override</GhostButton>
                  </div>
                )}
                {canDecide && c.status === 'overridden' && (
                  <GhostButton onClick={() => removeOverride(c.metric_code)}>Remove override</GhostButton>
                )}
              </div>
            );
          })}
        </section>
      )}

      {qa_flags.length > 0 && (
        <div className="grid md:grid-cols-2 gap-2 mb-5">
          {qa_flags.map((f, i) => <QaFlag key={`${f.code}-${i}`} flag={f} />)}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No results yet</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Confirm radar readings or time attempts first — results land here for review.</p>
        </div>
      ) : groups.map(group => (
        <section key={group.player_id} className="rounded-2xl border mb-4 overflow-hidden" style={cardStyle}>
          <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: '#1e3a5f' }}>
            <p className="text-base font-bold text-white">{group.name}</p>
            <a href={`/p/${group.slug}`} target="_blank" rel="noreferrer" className="text-xs hover:underline" style={{ color: '#38bdf8' }}>
              Public profile ↗
            </a>
          </div>
          {group.metrics.map(([code, results]) => {
            const info = metricInfo(code);
            const plan = planFor(group.player_id, code);
            return (
              <div key={code} className="px-5 py-3 border-b last:border-b-0" style={{ borderColor: '#1e3a5f' }}>
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>{info.label}</p>
                  {plan && (
                    <p className="text-xs" style={{ color: plan.rollup.released ? '#4ade80' : '#fbbf24' }}>
                      {plan.rollup.released
                        ? `will publish: ${plan.rollup.entries.map(e => `${e.metric_key} ${e.value}`).join(' · ')}`
                        : 'nothing releasable — publishes as unavailable'}
                    </p>
                  )}
                </div>
                {results.map(r => (
                  <div key={r.id} className="flex items-center gap-3 py-1.5 flex-wrap">
                    <span className="text-sm font-bold tabular-nums w-24" style={{ color: r.value != null ? '#f8fafc' : '#64748b' }}>
                      {r.value != null ? `${Number(r.value).toFixed(info.decimals)} ${info.unit}` : '—'}
                    </span>
                    <StatusChip value={r.status} />
                    <span className="text-xs flex-1 min-w-40" style={{ color: '#64748b' }}>
                      {r.status === 'unavailable' ? `${r.unavailable_reason.replace(/_/g, ' ')}${r.evidence_kind === 'measurement' ? '' : ''}` : evidenceLine(r)}
                    </span>
                    {canDecide && r.status === 'draft' && (
                      <PrimaryButton onClick={() => decide(r.id, 'approved')}>Approve</PrimaryButton>
                    )}
                    {canDecide && r.status === 'approved' && (
                      <GhostButton onClick={() => decide(r.id, 'draft')}>Return</GhostButton>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      ))}

      {data.history.length > 0 && (
        <section className="rounded-2xl border p-5 mt-5" style={cardStyle}>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Correction history</p>
          {data.history.map(h => (
            <p key={h.id} className="text-xs py-1 border-t" style={{ borderColor: '#1e3a5f', color: '#64748b' }} data-testid="history-row">
              #{h.id} {h.first_name} {h.last_name} · {h.metric_code.replace(/_/g, ' ')} · {h.value != null ? h.value : '—'} ·{' '}
              {h.status === 'withdrawn'
                ? <>withdrawn{h.restore_status ? ` (was ${h.restore_status})` : ''}{h.withdrawn_reason ? <span style={{ color: '#fbbf24' }}> — {h.withdrawn_reason}</span> : ''}{h.withdrawn_by ? ` · ${h.withdrawn_by}${h.withdrawn_at ? ` ${String(h.withdrawn_at).slice(0, 16)} UTC` : ''}` : ''}. Restoring the same reading revives this result.</>
                : `superseded by #${h.superseded_by}`}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
