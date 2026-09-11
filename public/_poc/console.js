// Field Live console: issue a stream, watch it live, compare its two recordings.
// Same origin as the control plane, so no CORS and no API base to configure.

const $ = (id) => document.getElementById(id);

/** Builds an element; falsy children are skipped so optional parts read inline. */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const state = {
  streams: [],
  selectedId: localStorage.getItem('fl.selected') || null,
  detail: null,
  health: null,
  event: null,
  hls: null,
  playing: false,
  /** Bumped on every stop, so a player still being signed for can tell it is stale. */
  playTicket: 0,
  resignTimer: null,
  liveCopyIndex: 0,
  /** Set once the operator picks a stream themselves; stops auto-following. */
  userPinned: false,
};

const STATUS = {
  created: { word: 'Waiting', dot: 'wait' },
  live: { word: 'Live', dot: 'live' },
  offline: { word: 'Off air', dot: 'warn' },
  ended: { word: 'Ended', dot: 'idle' },
};
const statusOf = (s) => STATUS[s.status] ?? { word: s.status, dot: '' };

// ── api ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const token = localStorage.getItem('dm_token');
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/live${path}`, { ...options, headers });
  if (res.status === 401) throw new Error('Sign in to Command first — this page uses the same session.');
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { /* not JSON: fall back to the status line */ }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

// ── health ──────────────────────────────────────────────────────────────────

async function pollHealth() {
  try {
    state.health = await api('/health');
    const { relay } = state.health;
    setHealth(relay.reachable ? 'ok' : 'bad', relay.reachable ? 'Relay online' : `Relay unreachable · ${relay.error}`);
    $('open-warning').hidden = !state.health.api?.console_open;
  } catch {
    state.health = null;
    setHealth('bad', 'Control plane unreachable');
  }
}

function setHealth(tone, text) {
  $('health-dot').className = `dot ${tone}`;
  $('health-text').textContent = text;
}

// ── streams ─────────────────────────────────────────────────────────────────

async function loadStreams() {
  state.streams = await api('/streams');
  renderStreams();
}

/** Live first, then waiting and off air, then ended; newest first within each. */
function sortedStreams() {
  const rank = (s) => (s.status === 'live' ? 0 : s.status === 'ended' ? 2 : 1);
  return [...state.streams].sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
}

function renderStreams() {
  const host = $('streams');
  const ordered = sortedStreams();
  // Rebuilt only when something visible changed, so hover and focus survive the poll.
  const signature = JSON.stringify([state.selectedId, ordered.map((s) => [s.id, s.status, s.label])]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;

  if (!ordered.length) {
    host.replaceChildren(el('p', { className: 'none', textContent: 'No streams yet.' }));
    return;
  }
  const focused = document.activeElement?.closest?.('.stream')?.dataset.id;
  host.replaceChildren(...ordered.map((s) => {
    const { word, dot } = statusOf(s);
    const row = el('button', { type: 'button', className: 'stream' },
      el('span', { className: `dot ${dot}` }),
      el('span', { className: 'body' },
        el('span', { className: 'name', textContent: s.label || s.job_id }),
        el('span', { className: `meta ${s.status}`, textContent: `${word} · ${formatWhen(s.created_at)}` })));
    row.dataset.id = s.id;
    row.setAttribute('aria-current', String(s.id === state.selectedId));
    row.addEventListener('click', () => {
      state.userPinned = true;
      select(s.id);
    });
    return row;
  }));
  if (focused) host.querySelector(`[data-id="${focused}"]`)?.focus();
}

/**
 * The console remembers the last selection, which is right until that session
 * ends and a new one goes live — then the operator is watching a finished game.
 * Anything not itself live loses to a stream that is, unless the operator picked
 * it by hand. Returns whether it switched.
 */
function followLiveStream() {
  if (state.userPinned) return false;
  const selected = state.streams.find((s) => s.id === state.selectedId);
  if (selected?.status === 'live') return false;
  const live = state.streams.find((s) => s.status === 'live');
  if (!live || live.id === state.selectedId) return false;
  select(live.id);
  return true;
}

function select(id) {
  if (state.selectedId !== id) {
    stopPlayback();
    state.detail = null;
    state.event = null;
    state.liveCopyIndex = 0;
    $('recordings').hidden = true;
  }
  state.selectedId = id;
  localStorage.setItem('fl.selected', id);
  renderStreams();
  refreshDetail();
  refreshEvent();
}

$('issue').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button');
  const body = Object.fromEntries(new FormData(form));
  // One field keeps issuing to a single click; a blank label gets the time instead.
  body.label = body.label.trim() || `Stream · ${formatWhen(new Date().toISOString())}`;
  $('issue-error').replaceChildren();
  button.disabled = true;
  try {
    const created = await api('/streams', { method: 'POST', body: JSON.stringify(body) });
    form.reset();
    await loadStreams();
    state.userPinned = true;   // the operator just chose this one
    select(created.id);
  } catch (err) {
    $('issue-error').replaceChildren(errorBox(err.message));
  } finally {
    button.disabled = false;
  }
});

// ── the selected stream ─────────────────────────────────────────────────────

async function refreshDetail() {
  const id = state.selectedId;
  if (!id) return renderEmpty();
  let detail;
  try {
    detail = await api(`/streams/${id}`);
  } catch (err) {
    // A vanished stream is forgotten; anything else is transient and the next poll retries.
    if (/not found/i.test(err.message)) forget();
    return;
  }
  if (id !== state.selectedId) return;   // the operator moved on while this was in flight
  state.detail = detail;
  renderStream();
  await maybeStartPlayback();
}

function forget() {
  stopPlayback();
  state.selectedId = null;
  state.detail = null;
  state.event = null;
  localStorage.removeItem('fl.selected');
  renderStreams();
  renderEmpty();
}

function renderEmpty() {
  $('empty').hidden = false;
  $('stream').hidden = true;
}

function renderStream() {
  const s = state.detail;
  $('empty').hidden = true;
  $('stream').hidden = false;
  $('stream-label').textContent = s.label || s.job_id;
  $('stream-status').replaceChildren(el('span', { className: `dot ${statusOf(s).dot}` }), statusLine(s));
  $('btn-end').hidden = s.status === 'ended';
  $('live').hidden = s.status === 'ended';

  // Rebuilt only for a new stream: the URLs never change, and a rebuild resets Copy.
  const urls = $('urls');
  if (urls.dataset.stream !== s.id) {
    urls.dataset.stream = s.id;
    urls.replaceChildren(urlRow('SRT', s.urls.srt), urlRow('RTMP', s.urls.rtmp));
  }
}

/** One line carries the session report, so it needs no panel of its own. */
function statusLine(s) {
  const r = s.report ?? {};
  const streamed = r.live_seconds ? formatDuration(r.live_seconds) : null;
  const lead = {
    created: ['Waiting for the phone'],
    live: [streamed ? `Live for ${streamed}` : 'Live'],
    offline: ['Off air', streamed && `streamed ${streamed}`],
    ended: [s.ended_at ? `Ended ${formatWhen(s.ended_at)}` : 'Ended', streamed && `streamed ${streamed}`],
  }[s.status] ?? [s.status];
  const outages = r.reconnect_count
    ? `${r.reconnect_count} outage${r.reconnect_count > 1 ? 's' : ''} (worst ${formatDuration(r.worst_reconnect_seconds)})`
    : null;
  return [...lead, outages].filter(Boolean).join(' · ');
}

/**
 * This page's own origin is the public one. On localhost the link has to work
 * for someone else on the network, so there it takes the host the phone is given.
 */
function viewerLink(id) {
  const host = state.health?.config?.host;
  const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (onLocalhost && host && host !== 'localhost') {
    return `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}/live/${id}`;
  }
  return `${location.origin}/live/${id}`;
}

/** Where the clipboard is refused (plain http on a LAN), shows the text to copy by hand. */
async function copyText(button, value) {
  button.dataset.label ??= button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => { button.textContent = button.dataset.label; }, 1400);
  } catch {
    window.prompt('Copy this:', value);
  }
}

function urlRow(key, value) {
  const button = el('button', { type: 'button', className: 'ghost', textContent: 'Copy', ariaLabel: `Copy ${key} URL` });
  button.addEventListener('click', () => copyText(button, value));
  return el('div', { className: 'url' },
    el('span', { className: 'k', textContent: key }),
    el('code', { textContent: value }),
    button);
}

$('btn-copy').addEventListener('click', (e) => copyText(e.currentTarget, viewerLink(state.selectedId)));

$('btn-end').addEventListener('click', async () => {
  const s = state.detail;
  if (!s || !window.confirm(`End “${s.label || s.job_id}”? This can’t be undone.`)) return;
  $('stream-error').replaceChildren();
  try {
    await api(`/streams/${s.id}/end`, { method: 'POST' });
    stopPlayback();
    await loadStreams();
    await refreshDetail();
    await refreshEvent();
  } catch (err) {
    $('stream-error').replaceChildren(errorBox(err.message));
  }
});

// ── playback ────────────────────────────────────────────────────────────────

async function maybeStartPlayback() {
  const s = state.detail;
  if (s.status !== 'live') {
    if (state.playing) stopPlayback();
    if (s.status !== 'ended') describeIdlePlayer(s);
    return;
  }
  if (!state.playing) await startPlayback();
}

function describeIdlePlayer(stream) {
  if (stream.status === 'offline') {
    showPlaceholder('Off air', 'The phone disconnected. The picture comes back on its own when it reconnects.');
  } else {
    showPlaceholder('Waiting for the phone',
      `In the Field Live app, pick “${stream.label || stream.job_id}” and tap Start recording and go live.`);
  }
}

function showPlaceholder(title, detail) {
  const host = $('player-placeholder');
  host.replaceChildren(el('strong', { textContent: title }), detail && el('span', { textContent: detail }));
  host.hidden = false;
}

async function startPlayback() {
  // Claimed before the await, so an overlapping poll cannot start a second player.
  state.playing = true;
  const ticket = state.playTicket;
  const video = $('video');
  showPlaceholder('Joining the stream…');
  try {
    const { url } = await api(`/streams/${state.selectedId}/playback`);
    if (ticket !== state.playTicket) return;   // stopped or switched while signing
    if (window.Hls?.isSupported()) {
      // Live, not VOD: hold near the edge and keep no long back buffer, or a
      // console left open drifts minutes behind the game it is meant to show.
      const hls = new window.Hls({
        lowLatencyMode: true,   // no-op unless the playlist advertises LL-HLS
        backBufferLength: 10,
        // Seconds behind the live edge. Buffer is what absorbs jitter, so this is
        // the one knob that decides whether a stream looks smooth or glitchy.
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 15,
      });
      state.hls = hls;
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        // A 401 here is a viewer token that aged out mid-session: re-sign and resume.
        if (data.response?.code === 401) return void resign();
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else stopPlayback();
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;                          // Safari plays HLS natively
    } else {
      throw new Error('This browser can’t play HLS.');
    }
    video.controls = true;
    attemptPlay();
    $('player-placeholder').hidden = true;
    $('stream-error').replaceChildren();
    // Tokens live 5 minutes; re-sign before that so a long watch does not drop.
    clearInterval(state.resignTimer);
    state.resignTimer = setInterval(resign, 4 * 60 * 1000);
  } catch (err) {
    state.playing = false;   // the next poll tries again
    showPlaceholder('Playback didn’t start', 'Trying again in a moment.');
    $('stream-error').replaceChildren(errorBox(err.message));
  }
}

/**
 * Sound first. Browsers refuse unmuted autoplay without a prior gesture, so fall
 * back to muted — a live picture beats a blank player — and offer sound as one
 * tap. Starting muted unconditionally is what silently lost the audio.
 */
function attemptPlay() {
  const video = $('video');
  video.muted = false;
  video.play().then(() => { clearGesture(); clearSoundPrompt(); }).catch(() => {
    video.muted = true;
    video.play().then(() => { clearGesture(); showSoundPrompt(); }).catch(showGesture);
  });
}

/** Autoplay refused outright (background tab, strict policy): ask for the one gesture. */
function showGesture() {
  if ($('player').querySelector('.gesture')) return;
  const button = el('button', { type: 'button', className: 'gesture' },
    el('strong', { textContent: 'Tap to watch' }),
    el('span', { textContent: 'The browser blocked autoplay.' }));
  button.addEventListener('click', () => {
    seekToLive();
    const video = $('video');
    video.muted = false;   // this tap is the gesture browsers want, so sound is allowed now
    video.play().then(() => { clearGesture(); clearSoundPrompt(); }).catch(() => {});
  });
  $('player').append(button);
}

function clearGesture() {
  $('player').querySelector('.gesture')?.remove();
}

function showSoundPrompt() {
  if ($('player').querySelector('.sound')) return;
  const button = el('button', { type: 'button', className: 'sound', textContent: 'Tap for sound' });
  button.addEventListener('click', () => {
    $('video').muted = false;
    clearSoundPrompt();
  });
  $('player').append(button);
}

function clearSoundPrompt() {
  $('player').querySelector('.sound')?.remove();
}

// Unmuting from the player's own controls counts too.
$('video').addEventListener('volumechange', () => {
  if (!$('video').muted) clearSoundPrompt();
});

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
    state.hls?.loadSource(url);
  } catch { /* the next poll will retry */ }
}

function stopPlayback() {
  state.playTicket += 1;
  state.playing = false;
  clearInterval(state.resignTimer);
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  const video = $('video');
  video.removeAttribute('src');
  video.load();
  video.controls = false;   // an idle player's scrubber at 0:00 only looks broken
  clearGesture();
  clearSoundPrompt();
  $('player-placeholder').hidden = false;
}

function renderOverlay() {
  const badges = [];
  if (state.playing && state.detail?.status === 'live') {
    badges.push(el('span', { className: 'badge live', textContent: 'Live' }));
  }
  const behind = state.hls ? behindLive() : null;
  if (behind !== null && behind > 30) {
    badges.push(el('span', { className: 'badge behind', textContent: `${Math.round(behind)}s behind` }));
  }
  $('player-overlay').replaceChildren(...badges);
}

/** What the viewer is getting, on one line under the picture. */
function renderStats() {
  renderOverlay();
  const host = $('stats');
  if (!state.playing) return void host.replaceChildren();
  const video = $('video');
  const level = state.hls?.levels?.[state.hls.currentLevel];
  const height = level?.height || video.videoHeight;
  const behind = behindLive();
  const dropped = video.getVideoPlaybackQuality?.().droppedVideoFrames;
  const items = [
    ['Rendition', height ? `${height}p` : null],
    ['Bitrate', level?.bitrate ? `${(level.bitrate / 1e6).toFixed(1)} Mbps` : null],
    ['Behind live', behind === null ? null : `${behind.toFixed(1)} s`, behind > 10],
    ['Dropped frames', dropped === undefined ? null : String(dropped)],
  ];
  host.replaceChildren(...items.filter(([, value]) => value !== null).map(([label, value, warn]) =>
    el('div', {},
      el('dt', { textContent: label }),
      el('dd', { textContent: value, className: warn ? 'warn' : '' }))));
}

// ── recordings: the same game, two ways ─────────────────────────────────────

async function refreshEvent() {
  const id = state.selectedId;
  if (!id) return;
  let event;
  try {
    event = await api(`/streams/${id}/event`);
  } catch {
    return;   // keep what is shown; the next poll retries
  }
  if (id !== state.selectedId) return;
  state.event = event;
  renderEvent();
}

function renderEvent() {
  const event = state.event;
  const host = $('compare');
  const recorded = event && (event.live_copy.length || event.masters.length || event.live_copy_unavailable);
  // While a stream runs the section waits for something to show. Once it has
  // ended it always shows, so a missing copy reads as missing, not as nothing.
  const show = Boolean(recorded || event?.stream?.status === 'ended');
  $('recordings').hidden = !show;
  if (!show) return;

  // Rebuilding restarts any video being watched, so only when the event changed shape.
  const signature = JSON.stringify([
    event.stream?.id,
    state.liveCopyIndex,
    event.live_copy.map((s) => [s.name, s.bytes, s.preparing]),
    event.masters.map((m) => [m.id, m.status, m.bytes_received]),
    event.live_copy_unavailable,
  ]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.replaceChildren(liveCopyPanel(event), masterPanel(event));
}

function liveCopyPanel(event) {
  const segments = event.live_copy;
  const panel = el('div', { className: 'copy' }, panelHead('Live copy', 'What viewers saw'));

  if (!segments.length) {
    panel.append(event.live_copy_unavailable
      ? placeholder('Couldn’t list the live copy', event.live_copy_unavailable)
      : placeholder('Nothing recorded yet', 'The relay files it in 10-minute pieces, the last when the stream stops.'));
    return panel;
  }

  const index = Math.min(state.liveCopyIndex, segments.length - 1);
  // A long game is several pieces; keep them selectable rather than merged.
  if (segments.length > 1) {
    const picker = el('select', { ariaLabel: 'Live copy part' }, ...segments.map((s, i) => el('option', {
      value: String(i),
      selected: i === index,
      textContent: `Part ${i + 1} of ${segments.length}${s.probe?.duration_seconds ? ` · ${formatDuration(s.probe.duration_seconds)}` : ''}`,
    })));
    picker.addEventListener('change', () => {
      state.liveCopyIndex = Number(picker.value);
      renderEvent();
    });
    panel.append(picker);
  }

  const segment = segments[index];
  panel.append(
    segment.preparing
      ? placeholder('Preparing playback', 'Making the relay’s file seekable. Takes a minute or so.')
      : videoFor(segment.url),
    specs(segment.probe, segment.bytes, event));
  return panel;
}

function masterPanel(event) {
  const panel = el('div', { className: 'copy' }, panelHead('HD master', 'Kept on the phone'));
  const master = event.masters.find((m) => m.status === 'complete') ?? event.masters[0];

  if (!master) {
    panel.append(placeholder('Not uploaded yet', 'After the stream, tap Upload master in the Field Live app.'));
    return panel;
  }
  if (master.status !== 'complete') {
    const pct = master.bytes ? Math.round((master.bytes_received / master.bytes) * 100) : 0;
    panel.append(
      placeholder(`Uploading · ${pct}%`, `${formatBytes(master.bytes_received)} of ${formatBytes(master.bytes)}`),
      el('div', { className: 'progress' }, el('span', { style: `--done: ${pct / 100}` })));
    return panel;
  }
  panel.append(videoFor(master.url), specs(master.probe, master.bytes, event));
  return panel;
}

function panelHead(title, note) {
  return el('div', { className: 'copy-head' }, el('h4', { textContent: title }), el('span', { textContent: note }));
}

function videoFor(url) {
  return el('video', { src: url, controls: true, playsInline: true, preload: 'metadata' });
}

function specs(probe, bytes, event) {
  const rows = [];
  if (probe && !probe.error) {
    const best = bestOf(event);
    const frames = probe.frames_counted != null && probe.frames_expected != null
      ? `${probe.frames_counted.toLocaleString()} of ${probe.frames_expected.toLocaleString()} · ${
        probe.frames_missing <= 0 ? 'none missing' : `−${(probe.frame_loss * 100).toFixed(2)}%`}`
      : null;
    rows.push(
      ['Resolution', probe.width && probe.height ? `${probe.width}×${probe.height}` : null, best && probe.height === best.height],
      ['Frame rate', probe.average_fps ? `${probe.average_fps} fps` : null, best && probe.average_fps === best.fps],
      ['Bitrate', probe.bit_rate ? `${(probe.bit_rate / 1e6).toFixed(1)} Mbps` : null, best && probe.bit_rate === best.bitRate],
      ['Codec', [probe.video_codec, probe.audio_codec].filter(Boolean).join(' · ') || null],
      ['Duration', probe.duration_seconds ? formatDuration(probe.duration_seconds) : null],
      ['Frames', frames, probe.frames_missing <= 0],
    );
  }
  rows.push(['Size', bytes ? formatBytes(bytes) : null]);
  return el('dl', { className: 'specs' }, ...rows.filter(([, value]) => value).flatMap(([label, value, better]) => [
    el('dt', { textContent: label }),
    el('dd', { textContent: value, className: better ? 'better' : '' }),
  ]));
}

/** The best value across both copies — null until each side has been measured, since one alone proves nothing. */
function bestOf(event) {
  const measured = (p) => p && !p.error;
  const live = event.live_copy.map((s) => s.probe).filter(measured);
  const master = event.masters.map((m) => m.probe).filter(measured);
  if (!live.length || !master.length) return null;
  const probes = [...live, ...master];
  return {
    height: Math.max(...probes.map((p) => p.height ?? 0)),
    fps: Math.max(...probes.map((p) => p.average_fps ?? 0)),
    bitRate: Math.max(...probes.map((p) => p.bit_rate ?? 0)),
  };
}

function placeholder(title, detail) {
  return el('div', { className: 'none' }, el('strong', { textContent: title }), el('span', { textContent: detail }));
}

function errorBox(message) {
  return el('div', { className: 'err', textContent: message });
}

// ── formatting ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A time today reads as a time; anything older gets its date. */
function formatWhen(iso) {
  const d = new Date(iso);
  const time = { hour: 'numeric', minute: '2-digit' };
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], time)
    : d.toLocaleString([], { month: 'short', day: 'numeric', ...time });
}

// ── loop ────────────────────────────────────────────────────────────────────

/** Polls only while the tab is visible; a console in a background tab need not keep asking. */
function every(ms, task) {
  setInterval(() => { if (!document.hidden) task().catch(() => {}); }, ms);
}

async function boot() {
  renderEmpty();
  await pollHealth();
  try {
    await loadStreams();
  } catch (err) {
    $('issue-error').replaceChildren(errorBox(err.message));
  }
  if (!state.streams.some((s) => s.id === state.selectedId)) state.selectedId = sortedStreams()[0]?.id ?? null;
  if (!followLiveStream() && state.selectedId) select(state.selectedId);

  every(3000, pollHealth);
  every(2500, async () => {
    await loadStreams();
    followLiveStream();
    await refreshDetail();
  });
  // Recordings change slowly and listing them costs a storage call, so they poll less.
  every(5000, refreshEvent);
  setInterval(() => { correctDrift(); renderStats(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pollHealth(); refreshDetail(); refreshEvent(); }
  });
}

boot();
