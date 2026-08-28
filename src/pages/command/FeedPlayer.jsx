import { useEffect, useRef, useState, useCallback } from 'react';
import { formatTimecode, parseSeek } from '../../lib/timecode';

// Shared frame-accurate player (Command). Proxies are constant-frame-rate;
// frame index = floor(mediaTime × fps) via requestVideoFrameCallback, seeks
// land on frame centers, and stale ticks during seeks are suppressed —
// validated by the M2 frame-accuracy gate. onFrame reports the current
// frame to parents (the measurement drawer marks from it).
//
// Navigation is built for a 1–2 hour game, not a clip: a scrubber, coarse
// ±1s/±10s/±1min jumps, and direct timecode/frame entry. Stepping one frame
// at a time through 400,000 frames is not a workflow.

export default function FeedPlayer({ src, fps, onFrame }) {
  const videoRef = useRef(null);
  const rvfcRef = useRef(0);
  const frameRef = useRef(0);
  const pendingSeekRef = useRef(null);
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(true);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [jumpTo, setJumpTo] = useState('');
  const [jumpError, setJumpError] = useState('');

  const totalFrames = duration ? Math.max(1, Math.round(duration * fps)) : 0;

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
          setSeeking(false);
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

  // Seek to an absolute frame. Landing on the frame's centre keeps the
  // decoder off the boundary, so floor() can't fall to the previous frame.
  const seekToFrame = useCallback(target => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const clamped = Math.max(0, totalFrames ? Math.min(target, totalFrames - 1) : target);
    frameRef.current = clamped;
    pendingSeekRef.current = clamped;
    setSeeking(true);
    video.currentTime = (clamped + 0.5) / fps;
    report(clamped);
    setPaused(true);
  }, [fps, report, totalFrames]);

  const stepFrames = useCallback(delta => seekToFrame(frameRef.current + delta), [seekToFrame]);

  useEffect(() => {
    const onKey = e => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(e.shiftKey ? 10 : 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(e.shiftKey ? -10 : -1); }
      if (e.key === 'j') { e.preventDefault(); stepFrames(-Math.round(fps)); }
      if (e.key === 'l') { e.preventDefault(); stepFrames(Math.round(fps)); }
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) { if (v.paused) { v.play(); setPaused(false); } else { v.pause(); setPaused(true); } }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepFrames, fps]);

  function submitJump(e) {
    e?.preventDefault();
    const parsed = parseSeek(jumpTo, fps);
    if (!parsed) return setJumpError('Use 1:23:45, 23:45, seconds, or #frame');
    setJumpError('');
    seekToFrame(parsed.frame);
    setJumpTo('');
  }

  const btn = { borderColor: '#334155', color: '#cfe8ff' };
  const jumps = [['-1m', -60], ['-10s', -10], ['-1s', -1], ['+1s', 1], ['+10s', 10], ['+1m', 60]];

  return (
    <div>
      <div className="rounded-2xl border overflow-hidden relative" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(15, 23, 42, 0.78)' }}>
        <video
          ref={videoRef}
          src={src}
          className="w-full block"
          style={{ maxHeight: '56vh', backgroundColor: '#000' }}
          playsInline
          preload="auto"
          onLoadedMetadata={e => setDuration(e.target.duration || 0)}
          onSeeking={() => setSeeking(true)}
          onSeeked={() => setSeeking(false)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        />
        {seeking && (
          <span
            className="absolute top-3 left-3 text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded"
            style={{ backgroundColor: 'rgba(6, 18, 43, 0.85)', color: '#38bdf8' }}
            data-testid="seek-indicator"
          >
            seeking…
          </span>
        )}
      </div>

      {/* Scrubber — the only practical way across a two-hour game. */}
      <div className="mt-3">
        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          value={Math.min(frame, Math.max(0, totalFrames - 1))}
          onChange={e => seekToFrame(Number(e.target.value))}
          disabled={!totalFrames}
          className="w-full cursor-pointer"
          style={{ accentColor: '#38bdf8' }}
          aria-label="Seek through the recording"
          data-testid="scrubber"
        />
        <div className="flex items-center justify-between text-xs tabular-nums mt-1" style={{ color: '#94a3b8' }}>
          <span data-testid="current-timecode">{formatTimecode(frame / fps)}</span>
          <span data-testid="total-duration">{formatTimecode(duration)} · {totalFrames.toLocaleString()} frames · {Number(fps.toFixed(2))} fps</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {[['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10]].map(([label, d]) => (
          <button key={label} onClick={() => stepFrames(d)}
            className="px-3 py-2 rounded-lg border text-sm font-bold cursor-pointer hover:bg-slate-800" style={btn}>
            {label}
          </button>
        ))}
        <span className="w-px h-6 mx-1" style={{ backgroundColor: '#334155' }} />
        {jumps.map(([label, secs]) => (
          <button key={label} onClick={() => stepFrames(Math.round(secs * fps))}
            className="px-2.5 py-2 rounded-lg border text-xs font-bold cursor-pointer hover:bg-slate-800" style={btn}>
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

        <form onSubmit={submitJump} className="flex items-center gap-1.5 ml-auto">
          <input
            value={jumpTo}
            onChange={e => setJumpTo(e.target.value)}
            placeholder="1:23:45 or #12345"
            className="px-2.5 py-1.5 rounded-lg border text-sm w-40"
            style={{ borderColor: '#334155', backgroundColor: 'rgba(15,23,42,0.9)', color: '#f8fafc' }}
            data-testid="jump-input"
          />
          <button type="submit" className="px-3 py-1.5 rounded-lg border text-sm font-bold cursor-pointer hover:bg-slate-800" style={btn}>
            Go
          </button>
          <span className="text-right ml-2">
            <span className="text-2xl font-black tabular-nums" style={{ color: '#38bdf8' }} data-testid="frame-counter">{frame}</span>
            <span className="text-[10px] font-bold uppercase tracking-widest ml-1.5" style={{ color: '#64748b' }}>frame</span>
          </span>
        </form>
      </div>
      {jumpError && <p className="text-xs mt-1.5" style={{ color: '#f87171' }}>{jumpError}</p>}
      <p className="text-[10px] mt-2" style={{ color: '#475569' }}>
        ← / → step 1 frame · shift+← / → step 10 · J / L jump one second · space or K play/pause
      </p>
    </div>
  );
}
