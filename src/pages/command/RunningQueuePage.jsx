import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import FeedPlayer from './FeedPlayer';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Running queue + measurement drawer (Command M4). The analyst creates a
// home-to-first or steal attempt, marks start/end frames on the frame-
// accurate player, and the system computes elapsed time from the proxy's
// effective FPS — frames, FPS, feed, and version stored as evidence. A
// clean candidate should take 10–15 seconds (PRD Phase 4 gate). Unavailable
// always requires a controlled reason.

const VALIDITY_COLORS = { valid: '#4ade80', unavailable: '#fbbf24' };

// Two feeds on one job usually share a label ("Behind Home"), which makes
// the selector ambiguous — and picking the wrong one means measuring the
// wrong footage at a different frame rate. Identify each by its file and
// real capture spec, and show the exact fps (59.94 is not 60).
function describeFeed(f) {
  const fps = f.proxy_fps || f.effective_fps;
  const rate = fps ? `${Number(fps.toFixed(2))} fps` : 'fps unknown';
  const size = f.width && f.height ? `${f.height}p` : '';
  const name = f.original_name || f.label;
  return `${name} — ${[size, rate].filter(Boolean).join(' · ')}${f.vfr ? ' · VFR' : ''}`;
}

export default function RunningQueuePage() {
  const { jobId } = useParams();
  const [data, setData] = useState(null);
  const [feedDetail, setFeedDetail] = useState(null);   // renditions + playback URL for the selected feed
  const [selectedFeedId, setSelectedFeedId] = useState(null);
  const [error, setError] = useState('');
  const [sticky, setSticky] = useState({ player_id: '', attempt_type: 'home_to_first' });
  const [activeAttemptId, setActiveAttemptId] = useState(null);
  const [marks, setMarks] = useState({ start: null, end: null });
  const [currentFrame, setCurrentFrame] = useState(0);
  const [unavailableReason, setUnavailableReason] = useState('base_not_visible');
  const [unavailableNote, setUnavailableNote] = useState('');

  const load = () => api.commandAttempts(jobId).then(setData).catch(err => setError(err.message));
  useEffect(() => {
    api.commandAttempts(jobId).then(d => {
      setData(d);
      const ready = d.feeds.find(f => f.status === 'ready');
      if (ready) setSelectedFeedId(ready.id);
    }).catch(err => setError(err.message));
  }, [jobId]);

  useEffect(() => {
    if (!selectedFeedId) return;
    api.commandFeed(selectedFeedId).then(setFeedDetail).catch(err => setError(err.message));
  }, [selectedFeedId]);

  const proxy = feedDetail?.renditions?.find(r => r.kind === 'proxy');
  const fps = proxy?.fps || feedDetail?.feed?.effective_fps || 30;
  const activeAttempt = useMemo(
    () => data?.attempts?.find(a => a.id === activeAttemptId) || null,
    [data, activeAttemptId]
  );
  const elapsedPreview = marks.start != null && marks.end != null && marks.end > marks.start
    ? ((marks.end - marks.start) / fps).toFixed(3)
    : null;

  async function createAttempt() {
    setError('');
    try {
      const { attempt } = await api.commandCreateAttempt(jobId, {
        attempt_type: sticky.attempt_type,
        player_id: Number(sticky.player_id),
        feed_id: selectedFeedId,
        timecode_s: currentFrame / fps,
      });
      await load();
      setActiveAttemptId(attempt.id);
      setMarks({ start: null, end: null });
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveMeasurement() {
    if (!activeAttempt || marks.start == null || marks.end == null) return;
    setError('');
    try {
      await api.commandMeasureAttempt(activeAttempt.id, {
        start_frame: marks.start, end_frame: marks.end, rendition_id: proxy?.id,
      });
      await load();
      // Save-and-advance: clear marks, jump to the next unmeasured attempt.
      setMarks({ start: null, end: null });
      const next = data.attempts.find(a => a.id !== activeAttempt.id && !a.measurement_id);
      setActiveAttemptId(next ? next.id : null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveUnavailable() {
    if (!activeAttempt) return;
    setError('');
    try {
      await api.commandAttemptUnavailable(activeAttempt.id, { reason: unavailableReason, note: unavailableNote });
      setUnavailableNote('');
      await load();
      setMarks({ start: null, end: null });
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return <p style={{ color: '#94a3b8' }}>{error || 'Loading running queue…'}</p>;

  const readyFeeds = data.feeds.filter(f => f.status === 'ready');

  return (
    <div>
      <Link to={`/command/jobs/${jobId}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-center justify-between gap-3 mt-1 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Running queue</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Mark contact/committed-movement and base-touch frames — the system computes the time and keeps the evidence. Unavailable always carries a reason.
          </p>
        </div>
        <div className="flex gap-2 items-end">
          <Field label="Feed">
            <Select value={selectedFeedId || ''} onChange={e => setSelectedFeedId(Number(e.target.value))}>
              {readyFeeds.map(f => (
                <option key={f.id} value={f.id}>{describeFeed(f)}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {readyFeeds.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No ready feed</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Attach and process a video feed on the job before timing attempts.</p>
        </div>
      ) : (
        <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-5 items-start">
          <div>
            {proxy && <FeedPlayer src={proxy.url} fps={fps} onFrame={setCurrentFrame} />}
          </div>

          <div className="flex flex-col gap-4">
            {/* new attempt */}
            <section className="rounded-2xl border p-4" style={cardStyle}>
              <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color: '#94a3b8' }}>New attempt</p>
              <div className="flex flex-col gap-3">
                <Field label="Runner (carries forward)">
                  <Select value={sticky.player_id} onChange={e => setSticky(s => ({ ...s, player_id: e.target.value }))}>
                    <option value="">—</option>
                    {data.roster.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
                  </Select>
                </Field>
                <div className="flex gap-2">
                  {data.attempt_types.map(t => (
                    <button key={t} onClick={() => setSticky(s => ({ ...s, attempt_type: t }))}
                      className="flex-1 px-2 py-2 rounded-lg text-xs font-bold cursor-pointer"
                      style={sticky.attempt_type === t ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
                      {t.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
                <PrimaryButton onClick={createAttempt} disabled={!sticky.player_id}>+ Create at frame {currentFrame}</PrimaryButton>
              </div>
            </section>

            {/* measurement drawer */}
            {activeAttempt && (
              <section className="rounded-2xl border p-4" style={{ ...cardStyle, borderColor: '#38bdf8' }}>
                <p className="text-[11px] font-bold uppercase tracking-widest mb-1" style={{ color: '#38bdf8' }}>Measuring</p>
                <p className="text-sm font-bold text-white mb-3">
                  {activeAttempt.first_name} {activeAttempt.last_name} · {activeAttempt.payload.attempt_type.replace(/_/g, ' ')}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <GhostButton onClick={() => setMarks(m => ({ ...m, start: currentFrame }))}>
                    Mark start{marks.start != null ? `: ${marks.start}` : ''}
                  </GhostButton>
                  <GhostButton onClick={() => setMarks(m => ({ ...m, end: currentFrame }))}>
                    Mark end{marks.end != null ? `: ${marks.end}` : ''}
                  </GhostButton>
                </div>
                <p className="text-center text-2xl font-black mb-3 tabular-nums" style={{ color: elapsedPreview ? '#4ade80' : '#334155' }}>
                  {elapsedPreview ? `${elapsedPreview}s` : '—'}
                </p>
                <PrimaryButton onClick={saveMeasurement} disabled={!elapsedPreview}>Save measurement</PrimaryButton>
                <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }}>
                  <div className="flex gap-2">
                    <Select value={unavailableReason} onChange={e => setUnavailableReason(e.target.value)}>
                      {data.unavailable_reasons.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                    </Select>
                    <TextInput value={unavailableNote} onChange={e => setUnavailableNote(e.target.value)} placeholder="note" />
                  </div>
                  <GhostButton onClick={saveUnavailable}>
                    Save as unavailable
                  </GhostButton>
                </div>
              </section>
            )}

            {/* attempts list */}
            <section className="rounded-2xl border p-4" style={cardStyle}>
              <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>
                Attempts ({data.attempts.length})
              </p>
              {data.attempts.length === 0 && <p className="text-sm" style={{ color: '#64748b' }}>None yet.</p>}
              {data.attempts.map(a => (
                <button key={a.id} onClick={() => { setActiveAttemptId(a.id); setMarks({ start: a.start_frame, end: a.end_frame }); }}
                  className="w-full text-left py-2 border-t cursor-pointer hover:bg-slate-800/40 px-1 -mx-1"
                  style={{ borderColor: '#1e3a5f' }}>
                  <span className="text-sm font-bold" style={{ color: a.id === activeAttemptId ? '#38bdf8' : '#f8fafc' }}>
                    {a.first_name} {a.last_name}
                  </span>
                  <span className="text-xs ml-2" style={{ color: '#64748b' }}>{a.payload.attempt_type.replace(/_/g, ' ')}</span>
                  <span className="float-right text-xs font-bold" style={{ color: VALIDITY_COLORS[a.validity] || '#64748b' }}>
                    {a.validity === 'valid' ? `${a.elapsed_s?.toFixed(2)}s` : a.validity === 'unavailable' ? a.unavailable_reason?.replace(/_/g, ' ') : 'unmeasured'}
                  </span>
                </button>
              ))}
            </section>

            {/* rollup preview */}
            <section className="rounded-2xl border p-4" style={cardStyle}>
              <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Draft rollups</p>
              {data.summaries.length === 0 ? (
                <p className="text-sm" style={{ color: '#64748b' }}>Save measurements to see best/average build live.</p>
              ) : data.summaries.map(s => (
                <p key={`${s.player_id}:${s.metric_code}`} className="text-xs py-1.5 border-t" style={{ borderColor: '#1e3a5f', color: '#94a3b8' }}>
                  <b style={{ color: '#f8fafc' }}>{s.name}</b> · {s.metric_code.replace(/_/g, ' ')} ·{' '}
                  {s.attempts > 0
                    ? <><b style={{ color: '#4ade80' }}>{s.best}s</b> best · {s.average}s avg · {s.attempts} attempts</>
                    : 'no valid attempts'}
                  {s.unavailable > 0 && <span style={{ color: '#fbbf24' }}> · {s.unavailable} unavailable</span>}
                </p>
              ))}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
