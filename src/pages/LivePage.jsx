import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

// Distance behind the live edge, in seconds. This is the whole quality/latency
// trade: every second here is a second of network jitter the viewer never sees.
// Measured on the POC — 0.67 s stutters on a phone over Wi-Fi, 3 s does not.
const BUFFER_STEPS = [3, 6, 10];
const HLS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js';

// One shared promise rather than a listener per mount: a second mount could
// otherwise attach to a script tag that had already fired its load event and
// wait forever.
let hlsLoad = null;
function loadHls() {
  if (window.Hls) return Promise.resolve();
  if (!hlsLoad) {
    hlsLoad = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = HLS_SRC;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Could not load the video player.'));
      document.head.appendChild(el);
    });
  }
  return hlsLoad;
}

function useHlsScript() {
  const [ready, setReady] = useState(() => Boolean(window.Hls));
  useEffect(() => {
    if (ready) return undefined;
    let cancelled = false;
    loadHls().then(() => { if (!cancelled) setReady(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready]);
  return ready;
}

export default function LivePage() {
  const { id } = useParams();
  const hlsReady = useHlsScript();
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const stallsRef = useRef([]);
  const stepRef = useRef(0);

  const [stream, setStream] = useState(null);
  const [error, setError] = useState('');
  const [buffering, setBuffering] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);

  // Poll rather than push: a game is hours long and this is two fields of JSON.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/live/streams/${id}/public`, {
          headers: localStorage.dm_token ? { Authorization: `Bearer ${localStorage.dm_token}` } : {},
        });
        if (res.status === 401) throw new Error('Sign in to watch this stream.');
        if (!res.ok) throw new Error('This stream could not be found.');
        if (!cancelled) { setStream(await res.json()); setError(''); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    poll();
    const timer = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id]);

  const play = useCallback(() => {
    videoRef.current?.play()
      .then(() => setNeedsTap(false))
      // Autoplay refusal is the common case on mobile, not the edge case.
      .catch(() => setNeedsTap(true));
  }, []);

  const signPlayback = useCallback(async () => {
    const res = await fetch(`/api/live/streams/${id}/playback`, {
      headers: localStorage.dm_token ? { Authorization: `Bearer ${localStorage.dm_token}` } : {},
    });
    if (!res.ok) throw new Error('Could not get a playback link.');
    return (await res.json()).url;
  }, [id]);

  // Attach once the stream is actually live; tear down when it is not.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hlsReady || stream?.status !== 'live') return undefined;
    let cancelled = false;
    let resignTimer;

    (async () => {
      try {
        const url = await signPlayback();
        if (cancelled) return;

        if (window.Hls?.isSupported()) {
          const hls = new window.Hls({
            lowLatencyMode: true,          // engages only if the playlist advertises parts
            backBufferLength: 10,
            liveSyncDuration: BUFFER_STEPS[stepRef.current],
            liveMaxLatencyDuration: BUFFER_STEPS[stepRef.current] + 12,
          });
          hlsRef.current = hls;
          hls.on(window.Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            // A 401 mid-stream is a viewer token that aged out, not a failure.
            if (data.response?.code === 401) return void signPlayback().then((u) => hls.loadSource(u)).catch(() => {});
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          });
          hls.loadSource(url);
          hls.attachMedia(video);
        } else {
          video.src = url;                 // Safari plays HLS natively
        }
        play();
        // Tokens live five minutes; re-sign before that so a long watch survives.
        resignTimer = setInterval(() => {
          signPlayback().then((u) => { if (hlsRef.current) hlsRef.current.loadSource(u); else video.src = u; })
            .catch(() => {});
        }, 4 * 60 * 1000);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(resignTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [hlsReady, stream?.status, signPlayback, play]);

  // Three stalls in a minute means this connection cannot hold the current
  // distance from the edge. Give it more room rather than letting it stutter.
  function onWaiting() {
    setBuffering(true);
    const now = Date.now();
    stallsRef.current = stallsRef.current.filter((t) => now - t < 60000).concat(now);
    if (stallsRef.current.length < 3 || stepRef.current >= BUFFER_STEPS.length - 1 || !hlsRef.current) return;
    stepRef.current += 1;
    stallsRef.current = [];
    hlsRef.current.config.liveSyncDuration = BUFFER_STEPS[stepRef.current];
    hlsRef.current.config.liveMaxLatencyDuration = BUFFER_STEPS[stepRef.current] + 12;
  }

  const live = stream?.status === 'live';

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 flex flex-col">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-slate-800">
        <BrandMark className="h-6 w-auto" />
        <span
          className={`rounded-full px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-widest ${
            live ? 'bg-rose-500 text-white' : 'border border-slate-700 text-slate-400'
          }`}
        >
          {live ? 'Live' : stream?.ended_at ? 'Ended' : 'Not started'}
        </span>
        <h1 className="min-w-0 truncate text-base font-semibold">{stream?.label || 'Field Live'}</h1>
      </header>

      <main className="flex flex-1 items-center justify-center p-3">
        <div className="relative aspect-video w-full max-w-5xl overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            playsInline
            controls
            muted
            onWaiting={onWaiting}
            onPlaying={() => setBuffering(false)}
          />

          {buffering && live && (
            <div className="absolute left-3 top-3 rounded-full bg-slate-950/80 px-3 py-1.5 text-[0.65rem] uppercase tracking-widest">
              Buffering
            </div>
          )}

          {needsTap && live && (
            <button
              type="button"
              onClick={play}
              className="absolute inset-0 grid place-content-center gap-2 bg-slate-950/70 text-slate-100"
            >
              <span className="text-lg font-semibold">Tap to watch</span>
              <span className="text-sm text-slate-400">Your browser blocked autoplay.</span>
            </button>
          )}

          {!live && (
            <div className="absolute inset-0 grid place-content-center gap-2 px-6 text-center">
              <p className="text-lg font-semibold">
                {error ? 'Cannot play this stream' : stream?.ended_at ? 'This game has ended' : 'Not live yet'}
              </p>
              <p className="max-w-sm text-sm text-slate-400">
                {error || (stream?.ended_at
                  ? 'The recording will appear here once it has been processed.'
                  : 'This page starts playing on its own when the stream begins.')}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
