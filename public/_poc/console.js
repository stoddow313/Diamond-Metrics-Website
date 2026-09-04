// Field Live POC console.
// Same origin as the control plane, so no CORS and no API base to configure.

const $ = (id) => document.getElementById(id);

const state = {
  streams: [],
  selectedId: localStorage.getItem('fl.selected') || null,
  detail: null,
  health: null,
  hls: null,
  whip: null,
  event: null,
  liveCopyIndex: 0,
  /** Set once the operator picks a session themselves; stops auto-following. */
  userPinned: false,
  latencyReadings: [],
};

// ── api ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const token = localStorage.getItem('dm_token');
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/live${path}`, { ...options, headers });
  if (res.status === 401) {
    throw new Error('Sign in to Command first — this page uses the same session.');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

// ── health ──────────────────────────────────────────────────────────────────

async function pollHealth() {
  try {
    state.health = await api('/health');
    setDot('dot-api', true);
    const relay = state.health.relay;
    setDot('dot-relay', relay.reachable);
    $('relay-counts').textContent = relay.reachable
      ? `${relay.publishing} publishing${relay.readers === null ? '' : ` · ${relay.readers} watching`}`
      : `unreachable — ${relay.error}`;
  } catch {
    state.health = null;
    setDot('dot-api', false);
    setDot('dot-relay', false);
    $('relay-counts').textContent = 'control plane unreachable';
  }
}

function setDot(id, ok, live = false) {
  const el = $(id);
  el.className = `dot ${live ? 'live' : ok ? 'ok' : 'bad'}`;
}

// ── sessions ────────────────────────────────────────────────────────────────

async function loadStreams() {
  state.streams = await api('/streams');
  $('session-count').textContent = state.streams.length ? `${state.streams.length} total` : '';
  const host = $('sessions');

  if (!state.streams.length) {
    host.innerHTML = '<p class="empty">No streams yet. Issue one below.</p>';
    return;
  }
  const ordered = [...state.streams].sort((a, b) => {
    const rank = (x) => (x.status === 'live' ? 0 : x.status === 'ended' ? 2 : 1);
    return rank(a) - rank(b) || b.created_at.localeCompare(a.created_at);
  });
  host.replaceChildren(...ordered.map((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session';
    btn.setAttribute('aria-current', String(s.id === state.selectedId));
    const dot = document.createElement('span');
    dot.className = `dot ${s.status === 'live' ? 'live' : s.status === 'ended' ? '' : s.status === 'offline' ? 'warn' : 'ok'}`;
    const body = document.createElement('span');
    body.style.minWidth = '0';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.label || s.job_id;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${s.status} · ${s.job_id} · ${new Date(s.created_at).toLocaleTimeString()}`;
    body.append(name, meta);
    btn.append(dot, body);
    btn.addEventListener('click', () => {
      state.userPinned = true;
      select(s.id);
    });
    return btn;
  }));
}

/**
 * The console remembers the last selection, which is right until a session ends
 * and a new one goes live somewhere down a long list — then the operator is
 * watching a finished game and the console looks broken.
 *
 * Anything that is not itself live loses to a stream that is: an `offline` session
 * is either finished or mid-reconnect, and neither is worth watching over one
 * actually on air. A session the operator picked by hand is never taken away.
 */
function followLiveStream() {
  if (state.userPinned) return;
  const selected = state.streams.find((s) => s.id === state.selectedId);
  if (selected?.status === 'live') return;
  const live = state.streams.find((s) => s.status === 'live');
  if (live && live.id !== state.selectedId) select(live.id);
}

function select(id) {
  if (state.selectedId !== id) stopPlayback();
  state.selectedId = id;
  localStorage.setItem('fl.selected', id);
  loadStreams();
  refreshDetail();
}

$('new-stream').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('new-stream-error').innerHTML = '';
  const form = new FormData(e.target);
  try {
    const created = await api('/streams', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form)),
    });
    await loadStreams();
    state.userPinned = false;
    select(created.id);
  } catch (err) {
    $('new-stream-error').innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
  }
});

// ── stream detail ───────────────────────────────────────────────────────────

async function refreshDetail() {
  if (!state.selectedId) return;
  try {
    state.detail = await api(`/streams/${state.selectedId}`);
  } catch {
    state.detail = null;
    state.selectedId = null;
    localStorage.removeItem('fl.selected');
    return;
  }
  renderDetail();
  renderTimeline();
  renderAcceptance();
  maybeStartPlayback();
  await refreshEvent();
}

function renderDetail() {
  const s = state.detail;
  $('stream-card').hidden = false;
  $('watch-card').hidden = false;
  $('timeline-card').hidden = false;

  $('stream-label').textContent = s.label || s.job_id;
  $('stream-sub').textContent = `${s.id} · ${s.path} · job ${s.job_id} · ${s.consent} · ${s.status}`;
  $('btn-end').disabled = s.status === 'ended';
  setDot('live-dot', s.status === 'live', s.status === 'live');

  $('urls').replaceChildren(...[
    ['SRT', s.urls.srt],
    ['RTMP', s.urls.rtmp],
  ].map(([k, v]) => urlRow(k, v)));

  // The link to hand to anyone who just wants to watch.
  $('share').replaceChildren(urlRow('WATCH', viewerLink(s.id)));

  $('cli').textContent = [
    `# from the repo root, with the relay up (npm run relay)`,
    `tools/publish.sh ${s.id} srt 120`,
    ``,
    `# or straight from ffmpeg, live rendition profile`,
    `ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \\`,
    `  -c:v libx264 -preset veryfast -tune zerolatency -b:v 3500k -g 60 \\`,
    `  -f mpegts "${s.urls.srt}"`,
  ].join('\n');
}

/**
 * Built from the address the control plane hands out rather than this page's own,
 * because the console is often open on localhost while the link has to work for
 * someone else on the network.
 */
function viewerLink(streamId) {
  const configured = state.health?.config?.host;
  const host = configured && configured !== 'localhost' ? configured : location.hostname;
  return `${location.protocol}//${host}:${location.port}/live/${streamId}`;
}

function urlRow(key, value) {
  const row = document.createElement('div');
  row.className = 'url';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = value;
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Blocked';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
  row.append(k, v, btn);
  return row;
}

$('btn-refresh').addEventListener('click', refreshDetail);
$('btn-end').addEventListener('click', async () => {
  if (!state.selectedId) return;
  await api(`/streams/${state.selectedId}/end`, { method: 'POST' });
  stopPlayback();
  await loadStreams();
  refreshDetail();
});

// ── the event: both recordings ──────────────────────────────────────────────

async function refreshEvent() {
  if (!state.selectedId) return;
  try {
    state.event = await api(`/streams/${state.selectedId}/event`);
  } catch {
    state.event = null;
  }
  renderEvent();
}

function renderEvent() {
  const event = state.event;
  const host = $('compare');
  const hasAnything = event && (event.live_copy.length || event.masters.length);
  $('event-card').hidden = !hasAnything;
  if (!hasAnything) return;

  // Re-rendering every poll would restart any video the user is watching, so only
  // rebuild when the shape of the event actually changed.
  const signature = JSON.stringify([
    state.liveCopyIndex,
    event.live_copy.map((s) => [s.name, s.bytes, s.preparing]),
    event.masters.map((m) => [m.id, m.status, m.bytes_received]),
  ]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.replaceChildren(liveCopyPanel(event), masterPanel(event));
}

function liveCopyPanel(event) {
  const segments = event.live_copy;
  const panel = document.createElement('div');
  panel.className = 'copy';

  const title = document.createElement('h3');
  title.append(text('Live copy'), pill('relay', ''));
  panel.append(title);

  if (!segments.length) {
    panel.append(event.live_copy_unavailable
      ? placeholder('Not listed here', event.live_copy_unavailable)
      : placeholder('Nothing recorded yet',
          'The relay records what it receives, so this appears once a stream publishes.'));
    return panel;
  }

  // A long game is many segments; keep them selectable rather than merged.
  if (segments.length > 1) {
    const select = document.createElement('select');
    segments.forEach((segment, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${i + 1}/${segments.length} · ${segment.name}`;
      option.selected = i === state.liveCopyIndex;
      select.append(option);
    });
    select.addEventListener('change', () => {
      state.liveCopyIndex = Number(select.value);
      renderEvent();
    });
    panel.append(select);
  }

  const index = Math.min(state.liveCopyIndex, segments.length - 1);
  const segment = segments[index];
  if (segment.preparing) {
    panel.append(placeholder('Preparing playback',
      'The relay writes fragmented MP4; it is being remuxed so a browser can play and seek it.'));
  } else {
    panel.append(videoFor(segment.url, `live-copy-${index}`));
  }
  panel.append(specs(segment.probe, segment.bytes, event));
  return panel;
}

function masterPanel(event) {
  const panel = document.createElement('div');
  panel.className = 'copy';

  const master = event.masters.find((m) => m.status === 'complete') ?? event.masters[0];
  const title = document.createElement('h3');
  title.append(text('HD master'), pill('from the phone', ''));
  panel.append(title);

  if (!master) {
    panel.append(placeholder('Not uploaded yet',
      'The phone keeps the 1080p60 master and uploads it after the session.'));
    return panel;
  }

  if (master.status !== 'complete') {
    const pct = master.bytes ? Math.round((master.bytes_received / master.bytes) * 100) : 0;
    panel.append(placeholder(`Uploading — ${pct}%`,
      `${master.uploaded_parts.length} of ${master.parts_total} parts · ${formatBytes(master.bytes_received)} of ${formatBytes(master.bytes)}`));
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('span');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    panel.append(bar);
    return panel;
  }

  panel.append(videoFor(master.url, 'master'), specs(master.probe, master.bytes, event));
  return panel;
}

function videoFor(url, key) {
  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.dataset.key = key;
  return video;
}

/** Marks the higher-fidelity value, since that is the comparison people want. */
function specs(probe, bytes, event) {
  const wrap = document.createElement('div');
  wrap.className = 'specs';
  if (!probe || probe.error) {
    wrap.append(specRow('probe', probe?.error ?? 'unavailable'));
    return wrap;
  }
  const best = bestOf(event);
  const rows = [
    ['resolution', probe.width && probe.height ? `${probe.width}×${probe.height}` : '–',
      probe.height === best.height],
    ['frame rate', probe.average_fps ? `${probe.average_fps} fps` : '–', probe.average_fps === best.fps],
    ['codec', [probe.video_codec, probe.audio_codec].filter(Boolean).join(' · ') || '–', false],
    ['constant rate', probe.looks_constant_rate === null ? '–' : probe.looks_constant_rate ? 'yes' : 'no',
      probe.looks_constant_rate === true],
    ['duration', probe.duration_seconds ? formatDuration(probe.duration_seconds) : '–', false],
    ['bitrate', probe.bit_rate ? `${(probe.bit_rate / 1e6).toFixed(1)} Mbps` : '–',
      probe.bit_rate === best.bitRate],
    ['size', formatBytes(bytes), false],
  ];
  if (probe.frames_counted != null && probe.frames_expected != null) {
    const pct = (probe.frame_loss * 100).toFixed(2);
    rows.push(['frames',
      `${probe.frames_counted} of ${probe.frames_expected}  (−${pct}%)`,
      probe.frames_missing === 0]);
  }
  rows.forEach(([l, v, better]) => wrap.append(specRow(l, v, better)));
  return wrap;
}

/** The best value present across both copies, so "better" is relative, not assumed. */
function bestOf(event) {
  const probes = [...event.live_copy.map((s) => s.probe),
                  ...event.masters.map((m) => m.probe)].filter((p) => p && !p.error);
  return {
    height: Math.max(0, ...probes.map((p) => p.height ?? 0)),
    fps: Math.max(0, ...probes.map((p) => p.average_fps ?? 0)),
    bitRate: Math.max(0, ...probes.map((p) => p.bit_rate ?? 0)),
  };
}

function specRow(label, value, better = false) {
  const row = document.createElement('div');
  const l = document.createElement('span');
  l.className = 'l';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `v${better ? ' better' : ''}`;
  v.textContent = value;
  row.append(l, v);
  return row;
}

function placeholder(title, detail) {
  const box = document.createElement('div');
  box.className = 'none';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = detail;
  box.append(strong, span);
  return box;
}

function pill(label) {
  const el = document.createElement('span');
  el.className = 'pill';
  el.textContent = label;
  return el;
}

function text(value) {
  return document.createTextNode(value);
}

function formatBytes(bytes) {
  if (!bytes) return '–';
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

// ── timeline ────────────────────────────────────────────────────────────────

function renderTimeline() {
  const events = state.detail?.events ?? [];
  const host = $('timeline');
  if (!events.length) {
    host.innerHTML = '<p class="empty">No events yet.</p>';
    return;
  }
  host.replaceChildren(...[...events].reverse().map((e) => {
    const row = document.createElement('div');
    row.className = `ev ${e.kind}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(e.at).toLocaleTimeString();
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = e.kind;
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = summarise(e.detail);
    row.append(t, k, d);
    return row;
  }));
}

function summarise(detail) {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

// ── playback ────────────────────────────────────────────────────────────────

async function maybeStartPlayback() {
  const s = state.detail;
  const shouldPlay = s && s.status === 'live';
  if (!shouldPlay) {
    if (state.hls) stopPlayback();
    describeIdlePlayer(s);
    $('player-placeholder').hidden = false;
    renderOverlay();
    return;
  }
  if (state.hls) return;                       // already attached
  await startPlayback();
}

/** A finished session and one that has not started look nothing alike to an operator. */
function describeIdlePlayer(stream) {
  const host = $('player-placeholder');
  const live = state.streams.find((s) => s.status === 'live');
  const [title, detail] = !stream ? ['No stream selected', 'Pick one from the list.']
    : stream.status === 'ended' ? ['This session has ended',
        live ? `“${live.label || live.job_id}” is live now.` : 'Its recordings are below.']
    : stream.status === 'offline' ? ['Off air',
        'The publisher disconnected. Playback resumes on its own when it returns.']
    : ['Not publishing yet', 'The player starts on its own when the relay reports the stream available.'];

  host.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: title }),
    Object.assign(document.createElement('span'), { textContent: detail }),
  );
}

async function startPlayback() {
  const video = $('video');
  $('player-error').innerHTML = '';
  try {
    const { url } = await api(`/streams/${state.selectedId}/playback`);
    if (window.Hls?.isSupported()) {
      // Live, not VOD: hold near the edge and do not accumulate a back buffer, or a
      // console left open drifts minutes behind the game it is supposed to be showing.
      const hls = new window.Hls({
        lowLatencyMode: true,   // no-op unless the playlist advertises LL-HLS
        backBufferLength: 10,
        // Seconds behind the live edge. Buffer is what absorbs jitter, so this is
        // the single knob that decides whether a stream looks smooth or glitchy.
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 15,
      });
      state.hls = hls;
      hls.on(window.Hls.Events.ERROR, async (_evt, data) => {
        if (!data.fatal) return;
        // A 401 here is a viewer token that aged out mid-session: re-sign and resume.
        if (data.response?.code === 401) return void resign();
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else stopPlayback();
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      attemptPlay();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;                          // Safari plays HLS natively
      attemptPlay();
    } else {
      throw new Error('this browser cannot play HLS');
    }
    $('player-placeholder').hidden = true;
    // Tokens live 5 minutes; re-sign before that so a long watch does not drop.
    clearInterval(state.resignTimer);
    state.resignTimer = setInterval(resign, 4 * 60 * 1000);
  } catch (err) {
    $('player-error').innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Autoplay is refused often enough (background tab, browser policy) that a silently
 * paused player is the likely case, not the edge case. Ask for the one gesture.
 */
function attemptPlay() {
  const video = $('video');
  video.play().then(clearGesture).catch(showGesture);
}

function showGesture() {
  if ($('player').querySelector('.gesture')) return;
  const btn = document.createElement('button');
  btn.className = 'gesture';
  btn.type = 'button';
  btn.innerHTML = '<strong>Tap to watch</strong><span>The browser blocked autoplay.</span>';
  btn.addEventListener('click', () => {
    seekToLive();
    $('video').play().then(clearGesture).catch(() => {});
  });
  $('player').append(btn);
}

function clearGesture() {
  $('player').querySelector('.gesture')?.remove();
}

/** Seconds between the newest media the player holds and where it is playing. */
function behindLive() {
  const video = $('video');
  const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1)
    : video.buffered.length ? video.buffered.end(video.buffered.length - 1) : null;
  if (end === null) return null;
  return Math.max(0, end - video.currentTime);
}

function seekToLive() {
  const video = $('video');
  const target = state.hls?.liveSyncPosition;
  if (Number.isFinite(target)) video.currentTime = target;
  else if (video.seekable.length) video.currentTime = video.seekable.end(video.seekable.length - 1);
}

/** A tab that was backgrounded comes back minutes behind; snap it forward. */
function correctDrift() {
  if (!state.hls || $('video').paused) return;
  const behind = behindLive();
  if (behind !== null && behind > 30) seekToLive();
}

async function resign() {
  if (!state.selectedId || !state.hls) return;
  try {
    const { url } = await api(`/streams/${state.selectedId}/playback`);
    state.hls.loadSource(url);
  } catch { /* the next poll will retry */ }
}

function stopPlayback() {
  clearInterval(state.resignTimer);
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  const video = $('video');
  video.removeAttribute('src');
  video.load();
  clearGesture();
  $('player-placeholder').hidden = false;
}

function renderOverlay() {
  const s = state.detail;
  const badges = [];
  if (s?.status === 'live') badges.push(['live', 'LIVE']);
  const level = state.hls?.levels?.[state.hls.currentLevel];
  if (level) badges.push(['', `${level.height}p · ${Math.round(level.bitrate / 1000)} kbps`]);
  const behind = state.hls ? behindLive() : null;
  if (behind !== null && behind > 30) badges.push(['behind', `${Math.round(behind)}s behind`]);
  $('player-overlay').replaceChildren(...badges.map(([cls, text]) => {
    const el = document.createElement('span');
    el.className = `badge ${cls}`;
    el.textContent = text;
    return el;
  }));
}

function renderTelemetry() {
  const video = $('video');
  const q = video.getVideoPlaybackQuality?.();
  const behind = behindLive();
  const level = state.hls?.levels?.[state.hls.currentLevel];
  const report = state.detail?.report;

  const cells = [
    ['Rendition', level ? `${level.height}p` : video.videoHeight ? `${video.videoHeight}p` : '–'],
    ['Bitrate', level ? `${Math.round(level.bitrate / 1000)}k` : '–'],
    ['Behind live', behind === null ? '–' : `${behind.toFixed(1)}s`],
    ['Dropped', q ? String(q.droppedVideoFrames) : '–'],
    ['Live for', report?.live_seconds ? formatDuration(report.live_seconds) : '–'],
    ['Availability', report?.availability === null || report?.availability === undefined
      ? '–' : `${(report.availability * 100).toFixed(1)}%`],
    ['Outages', report ? String(report.reconnect_count) : '–'],
    ['Worst back-on-air', report?.worst_reconnect_seconds === null || report?.worst_reconnect_seconds === undefined
      ? '–' : `${report.worst_reconnect_seconds.toFixed(1)}s`],
  ];
  $('telemetry').replaceChildren(...cells.map(([l, n]) => {
    const box = document.createElement('div');
    const nn = document.createElement('div');
    nn.className = 'n';
    nn.textContent = n;
    const ll = document.createElement('div');
    ll.className = 'l';
    ll.textContent = l;
    box.append(nn, ll);
    return box;
  }));
  renderOverlay();
}

// ── publish from this browser (WHIP) ────────────────────────────────────────

$('btn-whip').addEventListener('click', startWhip);
$('btn-stop-whip').addEventListener('click', stopWhip);

async function startWhip() {
  const s = state.detail;
  if (!s) return;
  if (!s.urls?.whip) {
    $('whip-state').textContent = 'not available — publish from the app over SRT';
    return;
  }
  // getUserMedia needs a secure context. Over http on a LAN IP — exactly how a
  // phone reaches this console — it is unavailable, so say why instead of
  // failing with a bare permissions error.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('whip-state').textContent = 'needs https — publish with an SRT app instead';
    return;
  }
  $('btn-whip').disabled = true;
  $('whip-state').textContent = 'asking for the camera…';
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    const pc = new RTCPeerConnection({ iceServers: [] });
    media.getTracks().forEach((track) => pc.addTrack(track, media));
    preferH264(pc);

    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);

    const res = await fetch(s.urls.whip, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`relay refused the publish (${res.status})`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    state.whip = { pc, media, resource: res.headers.get('location') };
    $('whip-state').textContent = 'publishing from this browser';
    $('btn-stop-whip').hidden = false;
  } catch (err) {
    $('whip-state').textContent = '';
    $('btn-whip').disabled = false;
    $('new-stream-error').innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
  }
}

async function stopWhip() {
  const w = state.whip;
  if (!w) return;
  w.media.getTracks().forEach((t) => t.stop());
  w.pc.close();
  if (w.resource) {
    // WHIP resources are torn down with DELETE; ignore failures, the relay times out anyway.
    fetch(new URL(w.resource, state.detail.urls.whip), { method: 'DELETE' }).catch(() => {});
  }
  state.whip = null;
  $('whip-state').textContent = '';
  $('btn-whip').disabled = false;
  $('btn-stop-whip').hidden = true;
}

function preferH264(pc) {
  // The relay packages standard HLS (mpegts), which carries H.264 and not VP8.
  const caps = RTCRtpSender.getCapabilities?.('video');
  const tx = pc.getTransceivers().find((t) => t.sender.track?.kind === 'video');
  if (!caps || !tx?.setCodecPreferences) return;
  const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (h264.length) tx.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !h264.includes(c))]);
}

function iceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 3000);   // non-trickle offer is good enough on a LAN
  });
}

// ── stopwatch and latency readings ──────────────────────────────────────────

const swStart = performance.now();
function tickStopwatch() {
  const ms = performance.now() - swStart;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  $('stopwatch').textContent =
    `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
  requestAnimationFrame(tickStopwatch);
}
requestAnimationFrame(tickStopwatch);

$('mark-latency').addEventListener('click', () => {
  const shown = prompt('Read the clock inside the player, then type it as mm:ss.mmm');
  if (!shown) return;
  const seen = parseClock(shown);
  if (seen === null) return void alert('Could not read that. Use mm:ss.mmm, e.g. 01:23.400');
  const now = performance.now() - swStart;
  const latency = (now - seen) / 1000;
  state.latencyReadings.push(latency);
  renderLatency();
  renderAcceptance();
});

function parseClock(text) {
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number((m[3] || '0').padEnd(3, '0'));
}

function renderLatency() {
  const r = state.latencyReadings;
  $('latency-readings').textContent = r.length
    ? `${r.length} reading${r.length > 1 ? 's' : ''} · median ${median(r).toFixed(1)} s · worst ${Math.max(...r).toFixed(1)} s`
    : '';
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ── acceptance table ────────────────────────────────────────────────────────

const OFF_CONSOLE = 'off-console';

function acceptanceRows() {
  const rep = state.detail?.report;
  const relay = state.health?.relay;
  const lat = state.latencyReadings;

  return [
    { k: 'Master recording quality', target: '1080p60 CFR, HEVC, no dropped frames',
      measured: 'ffprobe on the phone’s file — tools/probe-master.sh', state: OFF_CONSOLE },
    { k: 'Crash loss', target: '≤ 2 s lost on a force-kill',
      measured: 'force-kill drill, phase 3', state: OFF_CONSOLE },
    { k: 'Live availability', target: '≥ 95% at 480p or better',
      ...score(rep?.availability != null, () => `${(rep.availability * 100).toFixed(1)}% over ${formatDuration(rep.session_seconds)}`,
        () => rep.availability >= 0.95) },
    { k: 'Reconnect', target: 'back on air within 10 s',
      ...score(rep?.reconnect_count > 0, () => `worst ${rep.worst_reconnect_seconds.toFixed(1)} s over ${rep.reconnect_count} outage${rep.reconnect_count > 1 ? 's' : ''}`,
        () => rep.worst_reconnect_seconds <= 10, 'no outages yet') },
    { k: 'Glass-to-glass latency', target: '≤ 10 s standard HLS, 5 s stretch',
      ...score(lat.length > 0, () => `median ${median(lat).toFixed(1)} s of ${lat.length}`,
        () => median(lat) <= 10, 'record a reading') },
    { k: 'Master reaches Command', target: 'background upload resumes, QA passes',
      measured: 'needs the iOS uploader against the presign flow', state: OFF_CONSOLE },
    { k: 'Relay capacity', target: '40 publishers, 3 h, < 60% CPU',
      ...score(relay?.reachable, () => `${relay.publishing} publishing now · run tools/load-test.sh for the real number`,
        () => null, 'relay unreachable') },
    { k: 'Failover', target: 'standby serving within 60 s',
      measured: 'DNS-flip drill, relay/RUNBOOK.md', state: OFF_CONSOLE },
    { k: 'Heat and power', target: 'no drop below 1080p30 at 30–35 °C',
      measured: 'thermalState logged on the phone every 10 s', state: OFF_CONSOLE },
  ];
}

/** Only claim pass/fail when there is a real measurement behind it. */
function score(haveData, describe, verdict, pendingNote = 'not measured yet') {
  if (!haveData) return { measured: pendingNote, state: 'pending' };
  const ok = verdict();
  return { measured: describe(), state: ok === null ? 'observed' : ok ? 'pass' : 'fail' };
}

function renderAcceptance() {
  $('acceptance').replaceChildren(...acceptanceRows().map((row) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.k, 'k'),
      cell(row.target),
      cell(row.measured),
      pillCell(row.state),
    );
    return tr;
  }));
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function pillCell(stateName) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  const cls = { pass: 'pass', fail: 'fail', pending: 'pending', observed: '', [OFF_CONSOLE]: 'manual' }[stateName] ?? '';
  span.className = `pill ${cls}`;
  span.textContent = stateName;
  td.append(span);
  return td;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── loop ────────────────────────────────────────────────────────────────────

async function boot() {
  renderAcceptance();
  await pollHealth();
  await loadStreams();
  followLiveStream();
  if (state.selectedId && state.streams.some((s) => s.id === state.selectedId)) await refreshDetail();
  else if (state.streams.length) select(state.streams[0].id);

  setInterval(pollHealth, 3000);
  setInterval(async () => {
    await loadStreams();
    followLiveStream();
    await refreshDetail();
  }, 2500);
  setInterval(() => { correctDrift(); renderTelemetry(); }, 1000);
}

boot();
