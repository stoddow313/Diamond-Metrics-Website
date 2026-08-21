import { useEffect, useRef, useState, useCallback } from 'react';

// Shared frame-accurate player (Command). Proxies are constant-frame-rate;
// frame index = floor(mediaTime × fps) via requestVideoFrameCallback, seeks
// land on frame centers, and stale ticks during seeks are suppressed —
// validated by the M2 frame-accuracy gate. onFrame reports the current
// frame to parents (the measurement drawer marks from it).

export default function FeedPlayer({ src, fps, onFrame }) {
  const videoRef = useRef(null);
  const rvfcRef = useRef(0);
  const frameRef = useRef(0);
  const pendingSeekRef = useRef(null);
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(true);

  const report = useCallback(f => {
    setFrame(f);
    onFrame?.(f);
  }, [onFrame]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let cancelled = false;
    const tick = (_now, meta) => {
      if (cancelled) return;
      const f = Math.floor(meta.mediaTime * fps + 1e-6);
      if (pendingSeekRef.current != null) {
        if (f === pendingSeekRef.current) {
          pendingSeekRef.current = null;
          frameRef.current = f;
          report(f);
        }
      } else {
        frameRef.current = f;
        report(f);
      }
      rvfcRef.current = video.requestVideoFrameCallback(tick);
    };
    rvfcRef.current = video.requestVideoFrameCallback(tick);
    return () => { cancelled = true; video.cancelVideoFrameCallback?.(rvfcRef.current); };
  }, [src, fps, report]);

  const stepFrames = useCallback(delta => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const target = Math.max(0, frameRef.current + delta);
    frameRef.current = target;
    pendingSeekRef.current = target;
    video.currentTime = (target + 0.5) / fps;
    report(target);
    setPaused(true);
  }, [fps, report]);

  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
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

  return (
    <div>
      <div className="rounded-2xl border overflow-hidden" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(15, 23, 42, 0.78)' }}>
        <video
          ref={videoRef}
          src={src}
          className="w-full block"
          style={{ maxHeight: '56vh', backgroundColor: '#000' }}
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
            {label}
          </button>
        ))}
        <button
          onClick={() => { const v = videoRef.current; if (v) { if (v.paused) v.play(); else v.pause(); } }}
          className="px-3.5 py-2 rounded-lg text-sm font-bold cursor-pointer"
          style={{ backgroundColor: '#38bdf8', color: '#06122b' }}
        >
          {paused ? 'Play' : 'Pause'}
        </button>
        <span className="ml-auto text-right">
          <span className="text-2xl font-black tabular-nums" style={{ color: '#38bdf8' }} data-testid="frame-counter">{frame}</span>
          <span className="text-[10px] font-bold uppercase tracking-widest ml-2" style={{ color: '#64748b' }}>
            frame · {(frame / fps).toFixed(3)}s
          </span>
        </span>
      </div>
    </div>
  );
}
