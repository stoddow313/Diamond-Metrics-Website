import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { cardStyle } from '../../components/admin/theme';

// Feed viewer (M2): the frame-accurate review surface the M4 workspace
// builds on. Proxies are constant-frame-rate; the displayed frame index is
// round(mediaTime × proxy fps) via requestVideoFrameCallback, and stepping
// seeks to frame centers so boundary rounding can't drift.

export default function FeedViewerPage() {
  const { feedId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(true);
  const videoRef = useRef(null);
  const rvfcRef = useRef(0);
  // Authoritative frame index. Seeks land on frame centers (x.5/fps), so
  // frame = floor(mediaTime × fps): never round, or centers drift +1.
  const frameRef = useRef(0);
  // While a programmatic seek is in flight, rvfc still reports the previous
  // presented frame — ignore those stale ticks or rapid steps lose clicks.
  const pendingSeekRef = useRef(null);

  useEffect(() => {
    api.commandFeed(feedId).then(setData).catch(err => setError(err.message));
  }, [feedId]);

  const proxy = data?.renditions?.find(r => r.kind === 'proxy');
  const fps = proxy?.fps || data?.feed?.effective_fps || 30;

  // Frame counter driven by presented frames, not wall-clock polling.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !proxy) return;
    let cancelled = false;
    const tick = (_now, meta) => {
      if (cancelled) return;
      const f = Math.floor(meta.mediaTime * fps + 1e-6);
      if (pendingSeekRef.current != null) {
        if (f === pendingSeekRef.current) {
          pendingSeekRef.current = null;
          frameRef.current = f;
          setFrame(f);
        }
        // stale presentation from before the seek — ignore
      } else {
        frameRef.current = f;
        setFrame(f);
      }
      rvfcRef.current = video.requestVideoFrameCallback(tick);
    };
    rvfcRef.current = video.requestVideoFrameCallback(tick);
    return () => { cancelled = true; video.cancelVideoFrameCallback?.(rvfcRef.current); };
  }, [proxy, fps]);

  const stepFrames = useCallback(delta => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    // Deterministic stepping: advance from the tracked index, not from a
    // re-read of currentTime that may still be mid-seek.
    const target = Math.max(0, frameRef.current + delta);
    frameRef.current = target;
    pendingSeekRef.current = target;
    video.currentTime = (target + 0.5) / fps;   // seek to frame center
    setFrame(target);
    setPaused(true);
  }, [fps]);

  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(e.shiftKey ? 10 : 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(e.shiftKey ? -10 : -1); }
      if (e.key === ' ') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) { if (v.paused) { v.play(); setPaused(false); } else { v.pause(); setPaused(true); } }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepFrames]);

  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading feed…</p>;
  const { feed } = data;

  return (
    <div>
      <Link to={`/command/jobs/${feed.job_id}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-start justify-between gap-3 mt-1 mb-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">{feed.label} · {feed.team_name} {feed.game_date}</h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            {feed.width}×{feed.height} · source {feed.effective_fps?.toFixed(2)} fps
            {feed.vfr ? ' · VFR normalized in proxy' : ' · CFR'}
            {proxy ? ` · proxy ${proxy.fps?.toFixed(2)} fps` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-black tabular-nums" style={{ color: '#38bdf8' }} data-testid="frame-counter">{frame}</p>
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>frame · {(frame / fps).toFixed(3)}s</p>
        </div>
      </div>

      {!proxy ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold">Proxy not ready</p>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Feed status: {feed.status}{feed.error ? ` — ${feed.error}` : ''}</p>
        </div>
      ) : (
        <>
          <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
            <video
              ref={videoRef}
              src={proxy.url}
              className="w-full block"
              style={{ maxHeight: '62vh', backgroundColor: '#000' }}
              playsInline
              preload="auto"
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
            />
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {[['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10]].map(([label, d]) => (
              <button
                key={label}
                onClick={() => stepFrames(d)}
                className="px-3.5 py-2 rounded-lg border text-sm font-bold cursor-pointer hover:bg-slate-800"
                style={{ borderColor: '#334155', color: '#cfe8ff' }}
              >
                {label} frame{Math.abs(d) > 1 ? 's' : ''}
              </button>
            ))}
            <button
              onClick={() => { const v = videoRef.current; if (v) { if (v.paused) v.play(); else v.pause(); } }}
              className="px-3.5 py-2 rounded-lg text-sm font-bold cursor-pointer"
              style={{ backgroundColor: '#38bdf8', color: '#06122b' }}
            >
              {paused ? 'Play' : 'Pause'}
            </button>
            <span className="text-xs" style={{ color: '#64748b' }}>← / → step 1 · shift+← / → step 10 · space play/pause</span>
          </div>
        </>
      )}
    </div>
  );
}
