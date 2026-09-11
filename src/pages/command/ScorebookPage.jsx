import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import FeedPlayer from './FeedPlayer';
import { formatTimecode } from '../../lib/timecode';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Scorebook (Phase 2). Keyboard-first contextual scorekeeping: the count
// builds from pitch keys, four balls / three strikes resolve the plate
// appearance on their own, "in play" opens the result panel with the usual
// runner advances pre-selected, and runner controls only appear for runners
// who exist. Everything shown comes back from the server's replay — this
// page never keeps its own copy of the score.

const LABELS = {
  single: '1B', double: '2B', triple: '3B', home_run: 'HR', walk: 'BB', intentional_walk: 'IBB', hit_by_pitch: 'HBP', catcher_interference: 'CI',
  strikeout: 'K', strikeout_looking: 'Kc', groundout: 'GO', flyout: 'FO', lineout: 'LO', popout: 'PO', sacrifice_fly: 'SF', sacrifice_bunt: 'SAC',
  fielders_choice: 'FC', reach_on_error: 'E', double_play: 'DP', triple_play: 'TP', strikeout_reached: 'K·1B',
};
const RESULT_KEYS = { 1: 'single', 2: 'double', 3: 'triple', 4: 'home_run', g: 'groundout', y: 'flyout', l: 'lineout', p: 'popout', e: 'reach_on_error', x: 'fielders_choice', v: 'sacrifice_fly', n: 'sacrifice_bunt', d: 'double_play' };
const OUT_RESULTS = new Set(['strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout', 'sacrifice_fly', 'sacrifice_bunt', 'double_play', 'triple_play']);
const BATTER_TO = { single: 1, double: 2, triple: 3, home_run: 4, walk: 1, intentional_walk: 1, hit_by_pitch: 1, catcher_interference: 1, fielders_choice: 1, reach_on_error: 1, strikeout_reached: 1 };
const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'EH'];
const FIELDED_RESULTS = new Set([...OUT_RESULTS, 'fielders_choice', 'reach_on_error']);
const STRIKE_PITCHES = new Set(['called_strike', 'swinging_strike', 'check_swing_strike', 'foul_tip', 'foul_bunt']);
// The count the way the engine builds it: fouls stop adding at two strikes,
// a foul bunt or foul tip is strike three, balls in play and HBP change nothing.
function countOf(list) {
  let b = 0, s = 0;
  for (const p of list) {
    if (p.result === 'ball' || p.result === 'intentional_ball') b += 1;
    else if (p.result === 'foul') { if (s < 2) s += 1; }
    else if (STRIKE_PITCHES.has(p.result)) s += 1;
  }
  return { b: Math.min(b, 4), s: Math.min(s, 3) };
}
const fmtRate = (v, digits = 3) => (v == null ? '—' : digits === 3 ? v.toFixed(3).replace(/^0\./, '.') : v.toFixed(digits));

const refName = r => (r ? (r.name || r.label || (r.player_id ? `#${r.player_id}` : '—')) : '—');
const refKeyOf = r => (r?.player_id ? `p:${r.player_id}` : `l:${r?.label || ''}`);

// Conventional advancement for a result: what a scorer usually confirms.
function defaultAdvances(result, bases) {
  const plan = {};
  const occupied = [3, 2, 1].filter(b => bases[b]);
  const forced = res => ['walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference'].includes(res);
  for (const b of occupied) {
    let to = b;
    if (result === 'home_run') to = 4;
    else if (result === 'triple') to = 4;
    else if (result === 'double') to = Math.min(4, b + 2);
    else if (result === 'single' || result === 'fielders_choice' || result === 'reach_on_error' || result === 'strikeout_reached') to = b + 1;
    else if (forced(result)) {
      // only forced runners move
      const chain = b === 1 || (b === 2 && bases[1]) || (b === 3 && bases[2] && bases[1]);
      to = chain ? b + 1 : b;
    }
    plan[b] = { to, how: to === 4 ? 'scored_on_play' : 'advance', out: false };
  }
  return plan;
}

export default function ScorebookPage() {
  const { jobId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('score');   // score | box | log
  // at-bat working state
  const [pitches, setPitches] = useState([]);           // [{ result }]
  const [resultPanel, setResultPanel] = useState(null); // { result, rbi, batted_ball, direction, error_label, error_player_id, advances }
  const [batterOverride, setBatterOverride] = useState('');
  // lineup setup
  const [setup, setSetup] = useState(null);
  // substitution form
  const [sub, setSub] = useState(null);
  // log actions
  const [editing, setEditing] = useState(null);         // { event, payload, note }
  const [finalForm, setFinalForm] = useState(null);
  // video tagging: the selected feed plays beside the scorer and every event is
  // stamped with the feed and the moment on it (PRD §5 — automatic timecode capture)
  const [videoFeedId, setVideoFeedId] = useState(null);
  const [feedDetail, setFeedDetail] = useState(null);
  const [showVideo, setShowVideo] = useState(true);
  const [currentFrame, setCurrentFrame] = useState(0);
  const playerRef = useRef(null);
  const [fixState, setFixState] = useState(null);        // { outs, us, them, bases: {1,2,3}, next_slot, note }
  const [disputing, setDisputing] = useState(null);      // event id awaiting a reason
  const [clipEdit, setClipEdit] = useState(null);        // { id, start, end, t }
  const [pitchType, setPitchType] = useState('');        // carries forward pitch to pitch until changed
  const [showDetails, setShowDetails] = useState(false); // line score + non-blocking issues, behind a toggle in the workspace
  const [showLineups, setShowLineups] = useState(false); // lineups & substitutions live below the workspace
  const [pitcherPanel, setPitcherPanel] = useState(null); // { player_id, reason } — set our starting pitcher after the fact
  const [guestForm, setGuestForm] = useState(null);      // { first_name, last_name, jersey } — a one-off player for this job's lineup
  const [timeSteals, setTimeSteals] = useState(true);    // queue a steal timing attempt with each SB/CS when the video is on
  const [pendingSeek, setPendingSeek] = useState(null);   // { seconds, nonce } from a play-by-play row
  const appliedSeekRef = useRef(null);

  const load = useCallback(() => api.commandScorebook(jobId).then(d => { setData(d); return d; }).catch(err => setError(err.message)), [jobId]);
  useEffect(() => { load(); }, [load]);
  // The first ready feed plays by default; the scorer can switch feeds.
  const activeFeedId = videoFeedId ?? data?.feeds?.find(f => f.status === 'ready')?.id ?? null;
  useEffect(() => {
    if (!activeFeedId) return;
    api.commandFeed(activeFeedId).then(setFeedDetail).catch(err => setError(err.message));
  }, [activeFeedId]);
  const proxy = feedDetail?.feed?.id === activeFeedId ? feedDetail?.renditions?.find(r => r.kind === 'proxy') : null;
  const fps = proxy?.fps || feedDetail?.feed?.effective_fps || 30;
  const videoOn = showVideo && !!proxy;
  const tc = () => Number((currentFrame / fps).toFixed(3));
  const tag = () => (videoOn ? { selected_feed_id: activeFeedId, timecode_s: tc() } : {});
  // A jump requested while the player was hidden or loading lands once it is up.
  useEffect(() => {
    if (!pendingSeek || pendingSeek.nonce === appliedSeekRef.current || !proxy || !playerRef.current) return;
    appliedSeekRef.current = pendingSeek.nonce;
    playerRef.current.seek(pendingSeek.seconds);
  }, [pendingSeek, proxy]);

  const state = data?.state;
  const { b: balls, s: strikeCount } = useMemo(() => countOf(pitches), [pitches]);

  const battingSide = state?.upcoming?.batting || state?.batting;   // the half in progress, or the one about to start
  const battingRoster = useMemo(() => {
    if (!data || !battingSide) return [];
    const lu = state.lineups[battingSide];
    return lu ? lu.slots.map(s => ({ slot: s.slot, ...s.current })) : [];
  }, [data, state, battingSide]);

  async function run(fn, okMessage) {
    setError(''); setNotice(''); setBusy(true);
    try {
      const d = await fn();
      if (d) setData(d);
      if (okMessage) setNotice(okMessage);
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ── pitch handling ────────────────────────────────────────────────────
  function addPitch(result) {
    if (!state || state.final) return;
    const next = [...pitches, { result, timecode_s: videoOn ? tc() : undefined, pitch_type: pitchType || undefined }];
    setPitches(next);
    const { b, s } = countOf(next);
    if (result === 'hit_by_pitch') return openResult('hit_by_pitch', next);
    if (result === 'in_play') return openResult(null, next);
    if (b >= 4) return submitPA({ result: 'walk' }, next, {});
    if (s >= 3) return submitPA({ result: result === 'called_strike' ? 'strikeout_looking' : 'strikeout' }, next, {});
  }

  function openResult(result, pitchList = pitches) {
    setResultPanel({ result, rbi: null, batted_ball: '', direction: '', fielders: '', error_position: '', error_label: '', error_player_id: '', time_home_to_first: false, advances: result ? defaultAdvances(result, state.bases) : {}, pitchList });
  }
  function chooseResult(result) {
    setResultPanel(rp => ({ ...rp, result, advances: defaultAdvances(result, state.bases) }));
  }

  async function submitPA(pa, pitchList, advances) {
    const runners = Object.entries(advances || {}).filter(([, a]) => a && (a.out || a.to !== Number(a.from ?? 0))).map(([from, a]) => ({
      from: Number(from), to: a.out ? Number(from) : a.to, how: a.out ? 'out' : a.how, out: !!a.out,
      runner_player_id: state.bases[from]?.ref?.player_id || undefined, runner_label: state.bases[from]?.ref?.label || undefined,
      error_label: a.error_label || undefined,
      unearned: typeof a.unearned === 'boolean' ? a.unearned : undefined,   // the scorer's earned-run ruling, when given
    })).filter(r => r.out || r.to > r.from);
    const batter = batterOverride ? battingRoster.find(p => String(p.player_id || p.label) === batterOverride) : null;
    const body = {
      pa: {
        ...pa,
        batter_player_id: batter?.player_id || undefined,
        batter_label: batter?.label || undefined,
        out_of_order_ok: !!batter || undefined,
        error_player_id: pa.error_player_id ? Number(pa.error_player_id) : undefined,
      },
      pitches: pitchList.map(p => ({ result: p.result, timecode_s: p.timecode_s, pitch_type: p.pitch_type || undefined, radar_reading_id: p.radar_reading_id || undefined })),
      runners,
      ...tag(),
      ...(videoOn && pitchList.some(p => p.timecode_s != null) ? { timecode_s: [...pitchList].reverse().find(p => p.timecode_s != null).timecode_s } : {}),
    };
    const d = await run(() => api.commandScorebookPlateAppearance(jobId, body), `${LABELS[pa.result] || pa.result} recorded`);
    if (d) { setPitches([]); setResultPanel(null); setBatterOverride(''); }
  }

  function finishResult() {
    const rp = resultPanel;
    if (!rp?.result) return;
    const adv = {};
    for (const [from, a] of Object.entries(rp.advances)) adv[from] = { ...a, from: Number(from) };
    submitPA({
      result: rp.result, rbi: rp.rbi == null || rp.rbi === '' ? undefined : Number(rp.rbi), batted_ball: rp.batted_ball || undefined, direction: rp.direction || undefined,
      fielders: FIELDED_RESULTS.has(rp.result) && rp.fielders ? rp.fielders : undefined,
      error_position: rp.result === 'reach_on_error' && rp.error_position ? Number(rp.error_position) : undefined,
      error_label: rp.error_label || undefined, error_player_id: rp.error_player_id || undefined,
      time_home_to_first: rp.time_home_to_first && videoOn && data.modules?.home_to_first ? true : undefined,
    }, rp.pitchList, adv);
  }

  // ── keyboard ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      const tag = e.target.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!state || state.final || !state.lineups?.us || !state.lineups?.them || tab !== 'score') return;
      const k = e.key.toLowerCase();
      if (resultPanel) {
        if (e.key === 'Escape') { setResultPanel(null); return; }
        if (e.key === 'Enter') { e.preventDefault(); finishResult(); return; }
        if (RESULT_KEYS[k]) { e.preventDefault(); chooseResult(RESULT_KEYS[k]); }
        return;
      }
      const map = { b: 'ball', c: 'called_strike', s: 'swinging_strike', f: 'foul', h: 'hit_by_pitch', i: 'in_play', t: 'foul_tip', u: 'foul_bunt', w: 'check_swing_strike' };
      if (map[k]) { e.preventDefault(); addPitch(map[k]); }
      if (e.key === 'Escape' && pitches.length) setPitches([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── lineup setup ──────────────────────────────────────────────────────
  function startSetup() {
    const ours = (data.roster || []).slice(0, 9).map((p, i) => ({ slot: i + 1, player_id: p.id, label: `${p.first_name} ${p.last_name}`, position: p.primary_position || '' }));
    const pitcherSlot = ours.find(s => (s.position || '').toUpperCase() === 'P');
    setSetup({ us_is_home: false, dh: false, ours, theirs: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ slot: n, label: `#${n}`, position: n === 1 ? 'P' : '' })), theirPitcher: '#1',
      regulation: data.job.regulation_innings || 7, pitcher: pitcherSlot ? String(pitcherSlot.player_id) : '', pitcherReason: '' });
  }
  // The roster is dated: only memberships covering the game date appear. A
  // player who is playing anyway (fill-in, wrong dates on the roster) joins as a
  // job-scoped guest — a real player row, reassignable later, no public profile.
  async function addGuest() {
    const g = guestForm;
    if (!g || (!g.first_name.trim() && !g.last_name.trim() && !g.jersey.trim())) return setError('Give the guest a name or a jersey number');
    setError(''); setBusy(true);
    try {
      await api.commandAddGuest(jobId, { first_name: g.first_name.trim(), last_name: g.last_name.trim(), jersey: g.jersey.trim() });
      const fresh = await load();
      const added = fresh?.roster?.find(p => p.is_guest && `${p.first_name} ${p.last_name}`.trim() === `${g.first_name.trim()} ${g.last_name.trim()}`.trim()) || fresh?.roster?.filter(p => p.is_guest).at(-1);
      if (added && setup) setSetup(st => ({ ...st, ours: [...st.ours, { slot: st.ours.length + 1, player_id: added.id, label: `${added.first_name} ${added.last_name}`, position: '' }] }));
      setGuestForm(null);
      setNotice(`${g.first_name || g.jersey} added as a guest for this job — reassign to the identified player later; no public profile is created`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function saveLineups() {
    const ours = setup.ours.filter(s => s.player_id);
    if (ours.length < 1) return setError('Pick at least one of our players');
    if (!setup.pitcher) return setError('Name our starting pitcher, or record an unknown-pitcher exception — pitching statistics cannot publish without one');
    if (setup.pitcher === 'unknown' && setup.pitcherReason.trim().length < 3) return setError('An unknown-pitcher exception needs a reason');
    if (Number(setup.regulation) !== (data.job.regulation_innings || 7)) {
      setError('');
      try { await api.commandUpdateJob(jobId, { regulation_innings: Number(setup.regulation) }); } catch (err) { return setError(err.message); }
    }
    const d1 = await run(() => api.commandScorebookEvent(jobId, { event_type: 'lineup', payload: {
      side: 'us', us_is_home: setup.us_is_home, dh: setup.dh, slots: ours.map((s, i) => ({ slot: i + 1, player_id: s.player_id, label: s.label, position: s.position })),
      pitcher_player_id: setup.pitcher !== 'unknown' ? Number(setup.pitcher) : undefined,
      pitcher_unknown_reason: setup.pitcher === 'unknown' ? setup.pitcherReason.trim() : undefined,
    } }));
    if (!d1) return;
    const theirs = setup.theirs.filter(s => s.label.trim());
    await run(() => api.commandScorebookEvent(jobId, { event_type: 'lineup', payload: { side: 'them', slots: theirs.map((s, i) => ({ slot: i + 1, label: s.label.trim(), position: s.position })), pitcher_label: setup.theirPitcher || undefined } }), 'Lineups saved — score the first pitch');
    setSetup(null);
  }

  // ── substitutions ────────────────────────────────────────────────────
  async function saveSub() {
    const s = sub;
    const payload = { kind: s.kind, side: s.side };
    if (['pinch_hitter', 'defensive', 're_entry'].includes(s.kind)) payload.slot = Number(s.slot);
    if (['pinch_runner', 'courtesy_runner'].includes(s.kind)) payload.base = Number(s.base);
    if (s.side === 'us') { const p = data.roster.find(x => String(x.id) === String(s.player_in)); if (!p) return setError('Pick the incoming player'); payload.player_in_id = p.id; payload.player_in_label = `${p.first_name} ${p.last_name}`; }
    else { if (!s.player_in_label?.trim()) return setError('Give the incoming player a label'); payload.player_in_label = s.player_in_label.trim(); }
    if (s.position) payload.position = s.position;
    if (s.player_out_label) payload.player_out_label = s.player_out_label;
    if (s.kind === 'pitching_change' && s.slot) {
      // A bench pitcher takes the outgoing pitcher's lineup slot; a player already in the lineup is just a position switch.
      const already = state.lineups[s.side]?.slots.some(x => (payload.player_in_id && x.current?.player_id === payload.player_in_id) || (!payload.player_in_id && x.current?.label === payload.player_in_label));
      if (!already) payload.slot = Number(s.slot);
    }
    const d = await run(() => api.commandScorebookEvent(jobId, { event_type: 'substitution', ...tag(), payload }), `${s.kind.replace(/_/g, ' ')} recorded`);
    if (d) setSub(null);
  }

  // ── between-batter runner play ────────────────────────────────────────
  async function runnerPlay(base, how, to, out = false) {
    const r = state.bases[base];
    if (!r) return;
    const timed = timeSteals && videoOn && data.modules?.steal && r.ref.player_id && (how === 'stolen_base' || how === 'caught_stealing');
    await run(() => api.commandScorebookEvent(jobId, { event_type: 'runner', ...tag(), payload: { runner_player_id: r.ref.player_id || undefined, runner_label: r.ref.label || undefined, from: base, to: out ? base : to, how, out, time_steal: timed ? true : undefined } }), `${refName(r.ref)}: ${how.replace(/_/g, ' ')}${timed ? ' — steal timing queued' : ''}`);
  }
  // One wild pitch, passed ball or balk moves every runner up a base. The
  // events share a group id so the engine charges the pitcher (or catcher) once.
  async function everybodyMoves(how) {
    const group = `${how}-${Date.now().toString(36)}`;
    const occupied = [3, 2, 1].filter(b => state.bases[b]);
    if (!occupied.length) return;
    await run(async () => {
      let d = null;
      for (const b of occupied) {
        const r = state.bases[b];
        d = await api.commandScorebookEvent(jobId, { event_type: 'runner', ...tag(), payload: { runner_player_id: r.ref.player_id || undefined, runner_label: r.ref.label || undefined, from: b, to: b + 1, how, group } });
      }
      return d;
    }, `${how.replace(/_/g, ' ')}: ${occupied.length} runner${occupied.length === 1 ? '' : 's'} moved up`);
  }

  if (!data) return <p style={{ color: '#94a3b8' }}>{error || 'Loading scorebook…'}</p>;
  const lineupsReady = !!(state.lineups.us && state.lineups.them);
  const disputedCount = data.events.filter(e => e.status === 'needs_review').length;
  const homeLabel = state.us_is_home ? 'us' : 'them';
  const awayLabel = state.us_is_home ? 'them' : 'us';

  // The footage panel: compact inside the scoring workspace (player, timeline and
  // tagging controls share one laptop viewport), full width on the other tabs.
  const videoPanel = data.feeds?.some(f => f.status === 'ready') ? (
        <section className={`rounded-2xl border ${tab === 'score' ? 'p-3' : 'p-4 mb-4'}`} style={cardStyle} data-testid="video-panel">
          <div className={`flex items-center justify-between gap-3 ${tab === 'score' ? 'flex-nowrap mb-1.5' : 'flex-wrap mb-2'}`}>
            <div className="flex items-center gap-3 min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Footage</p>
              <Select value={activeFeedId || ''} onChange={e => setVideoFeedId(Number(e.target.value))}>
                {data.feeds.filter(f => f.status === 'ready').map(f => <option key={f.id} value={f.id}>{f.label}{f.effective_fps ? ` · ${Number(f.effective_fps.toFixed?.(0) ?? f.effective_fps)} fps` : ''}</option>)}
              </Select>
              {videoOn && <span className="text-xs whitespace-nowrap" style={{ color: '#64748b' }}>stamping at <b style={{ color: '#cfe8ff' }}>{formatTimecode(currentFrame / fps)}</b></span>}
            </div>
            <GhostButton onClick={() => setShowVideo(v => !v)}>{showVideo ? 'Hide video' : 'Show video'}</GhostButton>
          </div>
          {showVideo && proxy && (
            <FeedPlayer ref={playerRef} src={proxy.url} fps={fps} onFrame={setCurrentFrame} captureKeys={!resultPanel && !sub && !finalForm && !editing && !fixState && !pitcherPanel} compact={tab === 'score'}
              markers={data.log.filter(l => l.timecode_s != null && !l.child && l.feed_id === activeFeedId).map(l => ({ id: l.id, t: l.timecode_s, label: l.text, kind: l.type }))} />
          )}
          {showVideo && !proxy && <p className="text-xs" style={{ color: '#94a3b8' }}>Loading the review proxy…</p>}
        </section>
  ) : null;

  return (
    <div>
      <Link to={`/command/jobs/${jobId}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-center justify-between gap-3 mt-1 mb-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-white">Scorebook</h1>
          <p className="text-xs" style={{ color: '#64748b' }} title="Four balls or three strikes resolve the at-bat on their own. Everything here is replayed from the event log.">
            <b style={{ color: '#94a3b8' }}>B</b> ball · <b style={{ color: '#94a3b8' }}>C</b> called · <b style={{ color: '#94a3b8' }}>S</b> swinging · <b style={{ color: '#94a3b8' }}>F</b> foul · <b style={{ color: '#94a3b8' }}>H</b> HBP · <b style={{ color: '#94a3b8' }}>I</b> in play
          </p>
        </div>
        <div className="flex items-center gap-2">
          {['score', 'box', 'log'].map(t => (
            <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
              style={tab === t ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
              {t === 'score' ? 'Score' : t === 'box' ? 'Box score' : `Play by play${disputedCount ? ` · ${disputedCount} disputed` : ''}`}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="text-sm mb-3 px-4 py-2 rounded-xl border" style={{ borderColor: 'rgba(74, 222, 128, 0.35)', backgroundColor: 'rgba(74, 222, 128, 0.08)', color: '#4ade80' }}>{notice}</p>}

      {/* scoreboard */}
      <section className="rounded-2xl border px-4 py-2 mb-3" style={cardStyle} data-testid="scoreboard">
        <div className="flex items-center justify-between gap-3 flex-wrap lg:flex-nowrap">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className="text-[10px] font-bold uppercase tracking-widest max-w-[110px] truncate" style={{ color: '#64748b' }} title={`Away · ${awayLabel === 'us' ? 'us' : (data.job.opponent_label || 'them')}`}>{awayLabel === 'us' ? 'Us' : (data.job.opponent_label || 'Them')}</p>
              <p className="text-2xl font-black tabular-nums text-white">{state.score[awayLabel]}</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <p className="text-[10px] font-bold uppercase tracking-widest max-w-[110px] truncate" style={{ color: '#64748b' }} title={`Home · ${homeLabel === 'us' ? 'us' : (data.job.opponent_label || 'them')}`}>{homeLabel === 'us' ? 'Us' : (data.job.opponent_label || 'Them')}</p>
              <p className="text-2xl font-black tabular-nums text-white">{state.score[homeLabel]}</p>
            </div>
            <div className="text-sm whitespace-nowrap" style={{ color: '#cfe8ff' }}>
              {state.final ? <span className="font-bold" style={{ color: '#4ade80' }}>FINAL · {state.final.reason.replace(/_/g, ' ')}</span>
                : state.upcoming ? <><span style={{ color: '#94a3b8' }}>{state.half ? `${state.half === 'top' ? 'Top' : 'Bot'} ${state.inning} complete · ` : ''}next up</span> <span className="font-bold">{state.upcoming.half === 'top' ? 'Top' : 'Bot'} {state.upcoming.inning}</span></>
                : state.half ? <><span className="font-bold">{state.half === 'top' ? 'Top' : 'Bot'} {state.inning}</span> · {state.outs} out{state.outs === 1 ? '' : 's'}{pitches.length ? ` · ${balls}-${strikeCount}` : ''}</>
                : <span style={{ color: '#94a3b8' }}>Not started</span>}
              {state.game_over_suggested && !state.final && (
                <span className="ml-2 text-xs font-bold" style={{ color: '#fbbf24' }} title={state.game_over_suggested.detail}>game over by {state.game_over_suggested.reason.replace(/_/g, ' ')} — mark final</span>
              )}
            </div>
            {state.regulation && (
              <span className="text-[11px] tabular-nums" style={{ color: state.regulation.reached ? '#4ade80' : '#94a3b8' }} title={state.regulation.why} data-testid="regulation-status">
                Reg {state.regulation.innings} · {state.final ? state.final.reason.replace(/_/g, ' ') : state.regulation.reached ? 'reached' : 'not reached'}
              </span>
            )}
            {lineupsReady && !state.pitcher.us && (
              <button onClick={() => setPitcherPanel(p => (p ? null : { player_id: '', reason: '' }))} className="text-[11px] font-bold px-2 py-1 rounded cursor-pointer"
                style={state.pitcher_unknown_reason ? { backgroundColor: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' } : { backgroundColor: 'rgba(248, 113, 113, 0.15)', color: '#f87171' }} data-testid="pitcher-status"
                title={state.pitcher_unknown_reason ? `Unknown pitcher — audited exception: ${state.pitcher_unknown_reason}` : 'Our starting pitcher is not identified: the record cannot finalize and no pitching statistics publish until it is set or excepted'}>
                {state.pitcher_unknown_reason ? '⚠ pitcher unknown (exception)' : '⛔ starting pitcher not identified'}
              </button>
            )}
          </div>
          {/* bases */}
          <div className="flex items-center gap-2">
            <Diamond bases={state.bases} />
            <p className="text-[11px] leading-4" style={{ color: '#94a3b8' }}>
              {[1, 2, 3].map(b => <span key={b} className="mr-2">{b}B <span style={{ color: state.bases[b] ? '#f8fafc' : '#475569' }}>{state.bases[b] ? refName(state.bases[b].ref) : '—'}</span></span>)}
            </p>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            {(data.issues.length > 0 || state.line_score?.innings > 0) && (
              <GhostButton onClick={() => setShowDetails(v => !v)}>{showDetails ? 'Hide details' : `Details${data.issues.length ? ` · ${data.issues.length}` : ''}`}</GhostButton>
            )}
            {!state.final && lineupsReady && state.half && !state.half_complete && (
              <GhostButton title="Edit outs, score, bases or who is due up when the derived state is wrong — with a reason" onClick={() => setFixState({ outs: state.outs, us: state.score.us, them: state.score.them, bases: { 1: state.bases[1]?.ref ? refKeyOf(state.bases[1].ref) : '', 2: state.bases[2]?.ref ? refKeyOf(state.bases[2].ref) : '', 3: state.bases[3]?.ref ? refKeyOf(state.bases[3].ref) : '' }, next_slot: state.expected_batter?.slot || 1, note: '' })}>Fix state</GhostButton>
            )}
            {!state.final && lineupsReady && (
              <GhostButton onClick={() => setFinalForm({ reason: state.regulation?.reached ? 'regulation' : (state.game_over_suggested?.reason || ''), note: '' })}>Mark final</GhostButton>
            )}
            {state.final && (
              <GhostButton onClick={() => run(() => api.commandScorebookVoid(state.final.event_id, 'reopened for corrections'), 'Game reopened')}>Reopen</GhostButton>
            )}
          </div>
        </div>
        {finalForm && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }} data-testid="final-form">
            <p className="text-xs mb-2" style={{ color: state.regulation?.reached ? '#4ade80' : '#fbbf24' }}>
              {state.regulation?.reached
                ? `Regulation length reached (${state.regulation.why}).`
                : `Regulation length not reached — ${state.regulation?.why}. Ending now needs the reason and an audit note; the run rule is the event's to confirm.`}
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <Field label="Why did the game end?">
                <Select value={finalForm.reason} onChange={e => setFinalForm(f => ({ ...f, reason: e.target.value }))}>
                  <option value="">— choose —</option>
                  {data.vocab.final_reasons.map(r => <option key={r} value={r} disabled={r === 'regulation' && !state.regulation?.reached}>{r.replace(/_/g, ' ')}{r === 'regulation' && !state.regulation?.reached ? ' (not reached)' : ''}</option>)}
                </Select>
              </Field>
              <Field label={finalForm.reason && finalForm.reason !== 'regulation' ? 'Audit note (required)' : 'Note'}>
                <TextInput value={finalForm.note} onChange={e => setFinalForm(f => ({ ...f, note: e.target.value }))} placeholder={finalForm.reason === 'run_rule' ? 'tournament rule: 15 after 3' : finalForm.reason === 'time_limit' ? '1:45 limit at 8:12pm' : 'why the game ended'} />
              </Field>
              <PrimaryButton disabled={busy || !finalForm.reason || (finalForm.reason !== 'regulation' && finalForm.note.trim().length < 3) || (finalForm.reason === 'regulation' && !state.regulation?.reached)}
                onClick={async () => { const d = await run(() => api.commandScorebookEvent(jobId, { event_type: 'game_final', ...tag(), payload: { reason: finalForm.reason, note: finalForm.note.trim() || undefined } }), 'Game marked final — validate the game record from the job page'); if (d) setFinalForm(null); }}>Mark final</PrimaryButton>
              <GhostButton onClick={() => setFinalForm(null)}>Cancel</GhostButton>
            </div>
          </div>
        )}
        {fixState && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }} data-testid="fix-state">
            <p className="text-xs mb-2" style={{ color: '#fbbf24' }}>Only when the derived state is wrong. The adjustment is logged at this point in the game with your reason and shown to reviewers.</p>
            <div className="flex items-end gap-2 flex-wrap">
              <Field label="Outs"><Select value={fixState.outs} onChange={e => setFixState(f => ({ ...f, outs: Number(e.target.value) }))}>{[0, 1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</Select></Field>
              <Field label="Us"><TextInput type="number" min="0" value={fixState.us} onChange={e => setFixState(f => ({ ...f, us: e.target.value }))} /></Field>
              <Field label={data.job.opponent_label || 'Them'}><TextInput type="number" min="0" value={fixState.them} onChange={e => setFixState(f => ({ ...f, them: e.target.value }))} /></Field>
              {[1, 2, 3].map(b => (
                <Field key={b} label={`${b}B`}>
                  <Select value={fixState.bases[b]} onChange={e => setFixState(f => ({ ...f, bases: { ...f.bases, [b]: e.target.value } }))}>
                    <option value="">empty</option>
                    {battingRoster.map(p => <option key={p.slot} value={refKeyOf(p)}>{refName(p)}</option>)}
                  </Select>
                </Field>
              ))}
              <Field label="Due up (slot)"><Select value={fixState.next_slot} onChange={e => setFixState(f => ({ ...f, next_slot: Number(e.target.value) }))}>{battingRoster.map(p => <option key={p.slot} value={p.slot}>{p.slot}. {refName(p)}</option>)}</Select></Field>
              <Field label="Reason (required)"><TextInput value={fixState.note} onChange={e => setFixState(f => ({ ...f, note: e.target.value }))} placeholder="camera was down for the play" /></Field>
              <PrimaryButton disabled={busy || fixState.note.trim().length < 3} onClick={async () => {
                const payload = { note: fixState.note.trim() };
                if (Number(fixState.outs) !== state.outs) payload.outs = Number(fixState.outs);
                const score = {}; if (Number(fixState.us) !== state.score.us) score.us = Number(fixState.us); if (Number(fixState.them) !== state.score.them) score.them = Number(fixState.them); if (Object.keys(score).length) payload.score = score;
                const bases = {};
                for (const b of [1, 2, 3]) { const cur = state.bases[b]?.ref ? refKeyOf(state.bases[b].ref) : ''; if (fixState.bases[b] !== cur) { const p = battingRoster.find(x => refKeyOf(x) === fixState.bases[b]); bases[b] = fixState.bases[b] ? { player_id: p?.player_id || undefined, label: p?.label || undefined } : null; } }
                if (Object.keys(bases).length) payload.bases = bases;
                if (Number(fixState.next_slot) !== (state.expected_batter?.slot || 1)) payload.next_slot = { [battingSide]: Number(fixState.next_slot) };
                if (!['outs', 'score', 'bases', 'next_slot'].some(k => k in payload)) return setError('Nothing changed');
                const d = await run(() => api.commandScorebookEvent(jobId, { event_type: 'state_adjustment', ...tag(), payload }), 'State adjusted — logged with your reason');
                if (d) setFixState(null);
              }}>Apply</PrimaryButton>
              <GhostButton onClick={() => setFixState(null)}>Cancel</GhostButton>
            </div>
          </div>
        )}
        {pitcherPanel && (
          <div className="mt-3 pt-3 border-t flex items-end gap-2 flex-wrap" style={{ borderColor: '#1e3a5f' }} data-testid="pitcher-panel">
            <Field label="Our starting pitcher (applies to every pitch already scored)">
              <Select value={pitcherPanel.player_id} onChange={e => setPitcherPanel(p => ({ ...p, player_id: e.target.value }))}>
                <option value="">—</option>{data.roster.map(p => <option key={p.id} value={p.id}>{p.jersey ? `#${p.jersey} ` : ''}{p.first_name} {p.last_name}{p.is_guest ? ' · guest' : ''}</option>)}
              </Select>
            </Field>
            <PrimaryButton disabled={busy || !pitcherPanel.player_id} onClick={async () => { const d = await run(() => api.commandScorebookStartingPitcher(jobId, { player_id: Number(pitcherPanel.player_id) }), 'Starting pitcher set — every pitch re-attributed'); if (d) setPitcherPanel(null); }}>Set pitcher</PrimaryButton>
            <span className="text-xs pb-2" style={{ color: '#64748b' }}>or</span>
            <Field label="Unknown-pitcher exception (reason, audited)"><TextInput value={pitcherPanel.reason} onChange={e => setPitcherPanel(p => ({ ...p, reason: e.target.value }))} placeholder="not on the roster sheet; coach could not confirm" /></Field>
            <GhostButton disabled={busy || pitcherPanel.reason.trim().length < 3} onClick={async () => { const d = await run(() => api.commandScorebookStartingPitcher(jobId, { unknown_reason: pitcherPanel.reason.trim() }), 'Exception recorded — no pitching statistics will publish for us'); if (d) setPitcherPanel(null); }}>Record exception</GhostButton>
            <GhostButton onClick={() => setPitcherPanel(null)}>Cancel</GhostButton>
          </div>
        )}
        {showDetails && state.line_score?.innings > 0 && (
          <div className="mt-3 pt-3 border-t overflow-x-auto" style={{ borderColor: '#1e3a5f' }} data-testid="line-score">
            <table className="text-xs tabular-nums">
              <thead><tr style={{ color: '#64748b' }}><th className="text-left pr-3 font-normal"></th>{Array.from({ length: state.line_score.innings }, (_, i) => <th key={i} className="px-1.5 font-normal">{i + 1}</th>)}<th className="pl-3 px-1.5">R</th><th className="px-1.5">H</th><th className="px-1.5">E</th><th className="px-1.5">LOB</th></tr></thead>
              <tbody>
                {[state.line_score.away, state.line_score.home].map(row => (
                  <tr key={row.side} style={{ color: '#cfe8ff' }}>
                    <td className="pr-3 font-bold" style={{ color: row.side === 'us' ? '#38bdf8' : '#94a3b8' }}>{row.side === 'us' ? 'Us' : (data.job.opponent_label || 'Them')}</td>
                    {Array.from({ length: state.line_score.innings }, (_, i) => <td key={i} className="px-1.5 text-center">{row.runs[i] ?? (i < (state.inning || 0) ? 0 : '')}</td>)}
                    <td className="pl-3 px-1.5 text-center font-bold text-white">{row.r}</td><td className="px-1.5 text-center">{row.h}</td><td className="px-1.5 text-center">{row.e}</td><td className="px-1.5 text-center">{row.lob}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.issues.some(i => i.level === 'blocking' || showDetails) && (
          <div className="mt-3 pt-3 border-t text-xs" style={{ borderColor: '#1e3a5f' }} data-testid="scorebook-issues">
            {data.issues.filter(i => i.level === 'blocking' || showDetails).slice(0, showDetails ? 12 : 3).map((i, n) => (
              <p key={n} style={{ color: i.level === 'blocking' ? '#f87171' : i.level === 'info' ? '#94a3b8' : '#fbbf24' }}>{i.level === 'blocking' ? '⛔' : i.level === 'info' ? 'ℹ' : '⚠'} {i.message}{i.sequence ? <span style={{ color: '#475569' }}> · #{i.sequence}</span> : null}</p>
            ))}
            {!showDetails && data.issues.some(i => i.level !== 'blocking') && <p style={{ color: '#64748b' }}>… {data.issues.filter(i => i.level !== 'blocking').length} more under Details</p>}
          </div>
        )}
      </section>

      {tab !== 'score' && videoPanel}

      {tab === 'score' && !lineupsReady && (
        <section className="rounded-2xl border p-5" style={cardStyle} data-testid="lineup-setup">
          {!setup ? (
            <div className="text-center py-6">
              <p className="text-white font-bold mb-1">Enter both lineups to start scoring</p>
              <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>Our batting order comes from the job roster; the other side is labels only — nothing is created for them.</p>
              <PrimaryButton onClick={startSetup}>Set up lineups</PrimaryButton>
            </div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Our lineup</p>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: '#cfe8ff' }}>
                    <input type="checkbox" checked={setup.us_is_home} onChange={e => setSetup(s => ({ ...s, us_is_home: e.target.checked }))} /> we are the home team
                  </label>
                </div>
                {setup.ours.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1.5">
                    <span className="w-5 text-xs tabular-nums" style={{ color: '#64748b' }}>{i + 1}</span>
                    <Select value={s.player_id || ''} onChange={e => { const p = data.roster.find(x => String(x.id) === e.target.value); setSetup(st => { const ours = [...st.ours]; ours[i] = { ...ours[i], player_id: p?.id || null, label: p ? `${p.first_name} ${p.last_name}` : '' }; return { ...st, ours }; }); }}>
                      <option value="">—</option>
                      {data.roster.map(p => <option key={p.id} value={p.id}>{p.jersey ? `#${p.jersey} ` : ''}{p.first_name} {p.last_name}{p.is_guest ? ' · guest' : ''}</option>)}
                    </Select>
                    <Select value={s.position} onChange={e => setSetup(st => { const ours = [...st.ours]; ours[i] = { ...ours[i], position: e.target.value }; return { ...st, ours }; })}>
                      <option value="">pos</option>{POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </Select>
                  </div>
                ))}
                <div className="flex items-center gap-2 flex-wrap">
                  <GhostButton onClick={() => setSetup(st => ({ ...st, ours: [...st.ours, { slot: st.ours.length + 1, player_id: null, label: '', position: '' }] }))}>+ slot</GhostButton>
                  <GhostButton onClick={() => setGuestForm(g => (g ? null : { first_name: '', last_name: '', jersey: '' }))} data-testid="add-guest">+ guest player</GhostButton>
                  <span className="text-xs" style={{ color: '#64748b' }} data-testid="roster-hint">
                    Roster as of {data.job.game_date}: {data.roster.length} player{data.roster.length === 1 ? '' : 's'}. Only memberships covering the game date appear — fix the dates in Admin → Teams, or add a guest for a one-off.
                  </span>
                </div>
                {guestForm && (
                  <div className="flex items-end gap-2 flex-wrap mt-2" data-testid="guest-form">
                    <Field label="First name"><TextInput value={guestForm.first_name} onChange={e => setGuestForm(g => ({ ...g, first_name: e.target.value }))} placeholder="Jordan" /></Field>
                    <Field label="Last name"><TextInput value={guestForm.last_name} onChange={e => setGuestForm(g => ({ ...g, last_name: e.target.value }))} placeholder="Fill-in" /></Field>
                    <Field label="Jersey"><TextInput value={guestForm.jersey} onChange={e => setGuestForm(g => ({ ...g, jersey: e.target.value }))} placeholder="14" /></Field>
                    <PrimaryButton onClick={addGuest} disabled={busy}>Add guest</PrimaryButton>
                    <GhostButton onClick={() => setGuestForm(null)}>Cancel</GhostButton>
                  </div>
                )}
                <div className="grid sm:grid-cols-2 gap-3 mt-4">
                  <Field label="Our starting pitcher (required)">
                    <Select value={setup.pitcher} onChange={e => setSetup(st => ({ ...st, pitcher: e.target.value }))} data-testid="setup-pitcher">
                      <option value="">— pick —</option>
                      {data.roster.map(p => <option key={p.id} value={p.id}>{p.jersey ? `#${p.jersey} ` : ''}{p.first_name} {p.last_name}{p.is_guest ? ' · guest' : ''}</option>)}
                      <option value="unknown">Unknown pitcher — audited exception</option>
                    </Select>
                  </Field>
                  {setup.pitcher === 'unknown'
                    ? <Field label="Exception reason (required)"><TextInput value={setup.pitcherReason} onChange={e => setSetup(st => ({ ...st, pitcherReason: e.target.value }))} placeholder="not on the roster sheet" /></Field>
                    : <p className="text-xs self-end pb-2" style={{ color: '#64748b' }}>Pitching statistics publish only for an identified Diamond Metrics pitcher; scoring can start without one, but the record stays blocked until it is set.</p>}
                </div>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Their lineup (labels)</p>
                {setup.theirs.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1.5">
                    <span className="w-5 text-xs tabular-nums" style={{ color: '#64748b' }}>{i + 1}</span>
                    <TextInput value={s.label} onChange={e => setSetup(st => { const theirs = [...st.theirs]; theirs[i] = { ...theirs[i], label: e.target.value }; return { ...st, theirs }; })} placeholder={`#${i + 1}`} />
                    <Select value={s.position} onChange={e => setSetup(st => { const theirs = [...st.theirs]; theirs[i] = { ...theirs[i], position: e.target.value }; return { ...st, theirs }; })}>
                      <option value="">pos</option>{POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </Select>
                  </div>
                ))}
                <Field label="Their starting pitcher (label)"><TextInput value={setup.theirPitcher} onChange={e => setSetup(st => ({ ...st, theirPitcher: e.target.value }))} /></Field>
                <div className="mt-4">
                  <Field label="Regulation length for this game">
                    <Select value={setup.regulation} onChange={e => setSetup(st => ({ ...st, regulation: Number(e.target.value) }))} data-testid="setup-regulation">
                      {[5, 6, 7, 8, 9].map(n => <option key={n} value={n}>{n} innings{n === 7 ? ' (default)' : ''}</option>)}
                    </Select>
                  </Field>
                  <p className="text-xs mt-1" style={{ color: '#64748b' }}>Set from the tournament, league or event rules. A "regulation" final is only accepted once this length is reached; anything earlier needs an explicit reason and an audit note.</p>
                </div>
              </div>
              <div className="lg:col-span-2 flex gap-2">
                <PrimaryButton onClick={saveLineups} disabled={busy}>Save lineups and start</PrimaryButton>
                <GhostButton onClick={() => setSetup(null)}>Cancel</GhostButton>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'score' && lineupsReady && (
        <div className={videoPanel ? 'grid lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] gap-3 items-start' : ''} data-testid="workspace">
          {videoPanel}
          {/* at bat */}
          <section className="rounded-2xl border p-4" style={cardStyle} data-testid="at-bat">
            {state.final ? (
              <p className="text-sm" style={{ color: '#94a3b8' }}>The game is final. Corrections still work from the play-by-play; reopen to keep scoring.</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 flex-nowrap mb-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>At bat · {battingSide === 'us' ? 'us' : (data.job.opponent_label || 'them')}</p>
                    <p className="text-lg font-bold text-white truncate">
                      {batterOverride ? refName(battingRoster.find(p => String(p.player_id || p.label) === batterOverride)) : refName(state.expected_batter)}
                      <span className="text-xs font-normal ml-2" style={{ color: '#64748b' }}>slot {state.expected_batter?.slot ?? '—'}</span>
                    </p>
                    <p className="text-xs" style={{ color: '#94a3b8' }}>pitching: <b style={{ color: '#cfe8ff' }}>{refName(state.pitcher[battingSide === 'us' ? 'them' : 'us'])}</b></p>
                  </div>
                  <div className="flex items-end gap-2">
                    <Field label="Batter (if not the one due)">
                      <Select value={batterOverride} onChange={e => setBatterOverride(e.target.value)}>
                        <option value="">as expected</option>
                        {battingRoster.map(p => <option key={p.slot} value={String(p.player_id || p.label)}>{p.slot}. {refName(p)}</option>)}
                      </Select>
                    </Field>
                  </div>
                </div>
                {/* count */}
                <div className="flex items-center gap-4 mb-2">
                  <p className="text-3xl font-black tabular-nums" style={{ color: '#38bdf8' }}>{balls}-{strikeCount}</p>
                  <div className="flex flex-wrap gap-1.5 text-xs" style={{ color: '#94a3b8' }}>
                    {pitches.map((p, i) => <span key={i} className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)' }}>{p.result.replace(/_/g, ' ')}</span>)}
                    {pitches.length > 0 && <button onClick={() => setPitches([])} className="text-xs cursor-pointer hover:underline" style={{ color: '#64748b' }}>clear (Esc)</button>}
                  </div>
                </div>
                {!resultPanel && (data.modules?.radar || data.pitch_types) && (
                  <div className="flex items-end gap-2 flex-wrap mb-2" data-testid="pitch-detail">
                    <Field label="Pitch type (carries forward)">
                      <Select value={pitchType} onChange={e => { const v = e.target.value; setPitchType(v); setPitches(list => list.length ? list.map((p, i) => (i === list.length - 1 ? { ...p, pitch_type: v || undefined } : p)) : list); }}>
                        <option value="">—</option>{(data.pitch_types || []).map(t => <option key={t} value={t}>{t}</option>)}
                      </Select>
                    </Field>
                    {data.modules?.radar && pitches.length > 0 && battingSide === 'them' && (
                      <Field label={`Radar reading for the last pitch (${pitches[pitches.length - 1].result.replace(/_/g, ' ')})`}>
                        <Select value={pitches[pitches.length - 1].radar_reading_id || ''} onChange={e => { const id = e.target.value ? Number(e.target.value) : undefined; setPitches(list => list.map((p, i) => (i === list.length - 1 ? { ...p, radar_reading_id: id } : p))); }}>
                          <option value="">no reading</option>
                          {(data.radar_readings || []).filter(r => r.status === 'unmatched' || r.player_id === state.pitcher.us?.player_id).map(r => (
                            <option key={r.id} value={r.id}>{r.velocity} {r.unit || 'mph'}{r.source_timestamp ? ` · ${r.source_timestamp}` : r.row_index != null ? ` · row ${r.row_index}` : ''}{r.status === 'matched' ? ' · matched' : ''}</option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {data.modules?.radar && battingSide === 'us' && pitches.length > 0 && <span className="text-xs pb-2" style={{ color: '#64748b' }}>Radar readings attach to our pitchers only</span>}
                  </div>
                )}
                {!resultPanel && (
                  <>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {[['ball', 'Ball', 'B'], ['called_strike', 'Called K', 'C'], ['swinging_strike', 'Swinging', 'S'], ['foul', 'Foul', 'F'], ['hit_by_pitch', 'HBP', 'H'], ['in_play', 'In play', 'I']].map(([r, label, key]) => (
                        <button key={r} onClick={() => addPitch(r)} disabled={busy} className="px-3 py-3 rounded-xl border text-sm font-bold cursor-pointer hover:bg-slate-800"
                          style={{ borderColor: r === 'in_play' ? '#38bdf8' : '#334155', color: r === 'in_play' ? '#38bdf8' : '#cfe8ff' }} data-testid={`pitch-${r}`}>
                          {label} <span className="text-[10px] ml-1" style={{ color: '#64748b' }}>{key}</span>
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2 text-xs">
                      {[['foul_tip', 'Foul tip', 'T'], ['foul_bunt', 'Foul bunt', 'U'], ['check_swing_strike', 'Check-swing strike', 'W']].map(([r, label, key]) => (
                        <button key={r} onClick={() => addPitch(r)} disabled={busy} className="px-2.5 py-1.5 rounded-lg cursor-pointer" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }} data-testid={`pitch-${r}`}
                          title={r === 'foul_tip' ? 'A strike even with two — strike three is a strikeout' : r === 'foul_bunt' ? 'A strike even with two strikes' : 'Counts as a swing and a miss'}>
                          {label} <span className="ml-1" style={{ color: '#64748b' }}>{key}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {resultPanel && (
                  <div className="rounded-xl border p-4" style={{ borderColor: '#38bdf8' }} data-testid="result-panel">
                    <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#38bdf8' }}>Result{resultPanel.result ? ` · ${LABELS[resultPanel.result]}` : ''}</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {data.vocab.pa_results.filter(r => !['walk', 'intentional_walk', 'strikeout', 'strikeout_looking'].includes(r) || resultPanel.result === r).map(r => {
                        const key = Object.entries(RESULT_KEYS).find(([, v]) => v === r)?.[0];
                        return (
                          <button key={r} onClick={() => chooseResult(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                            style={resultPanel.result === r ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#cfe8ff' }} title={r.replace(/_/g, ' ')} data-testid={`result-${r}`}>
                            {LABELS[r]}{key ? <span className="ml-1" style={{ color: resultPanel.result === r ? '#06122b' : '#64748b' }}>{key}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    {resultPanel.result && (
                      <div className="grid sm:grid-cols-3 gap-3 mb-3">
                        {!OUT_RESULTS.has(resultPanel.result) || resultPanel.result === 'sacrifice_fly' ? (
                          <Field label="RBI (auto if blank)"><TextInput type="number" min="0" max="4" value={resultPanel.rbi ?? ''} onChange={e => setResultPanel(rp => ({ ...rp, rbi: e.target.value }))} placeholder="auto" /></Field>
                        ) : null}
                        <Field label="Batted ball">
                          <Select value={resultPanel.batted_ball} onChange={e => setResultPanel(rp => ({ ...rp, batted_ball: e.target.value }))}>
                            <option value="">—</option>{data.vocab.batted_balls.map(b => <option key={b} value={b}>{b.replace(/_/g, ' ')}</option>)}
                          </Select>
                        </Field>
                        <Field label="Direction">
                          <Select value={resultPanel.direction} onChange={e => setResultPanel(rp => ({ ...rp, direction: e.target.value }))}>
                            <option value="">—</option>{data.vocab.directions.map(d => <option key={d} value={d}>{d}</option>)}
                          </Select>
                        </Field>
                        {FIELDED_RESULTS.has(resultPanel.result) && (
                          <Field label={resultPanel.result === 'reach_on_error' ? 'Fielders on the play (optional)' : 'Fielders, e.g. 6-3'}>
                            <TextInput value={resultPanel.fielders} onChange={e => setResultPanel(rp => ({ ...rp, fielders: e.target.value }))} placeholder={resultPanel.result === 'double_play' ? '6-4-3' : resultPanel.result === 'flyout' ? '8' : '6-3'} />
                          </Field>
                        )}
                        {resultPanel.result === 'reach_on_error' && (
                          <Field label="Error by (position)">
                            <Select value={resultPanel.error_position} onChange={e => setResultPanel(rp => ({ ...rp, error_position: e.target.value }))}>
                              <option value="">—</option>{Object.entries(data.vocab.position_numbers || {}).map(([pos, n]) => <option key={n} value={n}>{n} · {pos}</option>)}
                            </Select>
                          </Field>
                        )}
                        {resultPanel.result === 'reach_on_error' && !resultPanel.error_position && (
                          battingSide === 'them'
                            ? <Field label="Error by (our player)">
                                <Select value={resultPanel.error_player_id} onChange={e => setResultPanel(rp => ({ ...rp, error_player_id: e.target.value }))}>
                                  <option value="">—</option>{data.roster.map(p => <option key={p.id} value={p.id}>{p.jersey ? `#${p.jersey} ` : ''}{p.first_name} {p.last_name}</option>)}
                                </Select>
                              </Field>
                            : <Field label="Error by (their label)"><TextInput value={resultPanel.error_label} onChange={e => setResultPanel(rp => ({ ...rp, error_label: e.target.value }))} placeholder="#6" /></Field>
                        )}
                      </div>
                    )}
                    {resultPanel.result && videoOn && data.modules?.home_to_first && battingSide === 'us' && !['walk', 'intentional_walk', 'hit_by_pitch', 'catcher_interference', 'strikeout', 'strikeout_looking'].includes(resultPanel.result) && (
                      <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer" style={{ color: '#cfe8ff' }} data-testid="time-home-to-first">
                        <input type="checkbox" checked={!!resultPanel.time_home_to_first} onChange={e => setResultPanel(rp => ({ ...rp, time_home_to_first: e.target.checked }))} />
                        Queue home-to-first timing for the batter at this moment ({formatTimecode(tc())})
                      </label>
                    )}
                    {resultPanel.result && [3, 2, 1].some(b => state.bases[b]) && (
                      <div className="mb-3">
                        <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>Runners on this play</p>
                        {[3, 2, 1].filter(b => state.bases[b]).map(b => {
                          const a = resultPanel.advances[b] || { to: b, how: 'advance', out: false };
                          const set = patch => setResultPanel(rp => ({ ...rp, advances: { ...rp.advances, [b]: { ...a, ...patch } } }));
                          return (
                            <div key={b} className="flex items-center gap-2 py-1 flex-wrap text-sm" data-testid={`runner-${b}`}>
                              <span className="w-40 truncate" style={{ color: '#cfe8ff' }}>{b}B · {refName(state.bases[b].ref)}</span>
                              {[b, ...[b + 1, b + 2, b + 3].filter(x => x <= 4)].map(to => (
                                <button key={to} onClick={() => set({ to, out: false, how: to === 4 ? 'scored_on_play' : 'advance' })} className="px-2 py-1 rounded text-xs font-bold cursor-pointer"
                                  style={!a.out && a.to === to ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
                                  {to === b ? 'stays' : to === 4 ? 'scores' : `→ ${to}B`}
                                </button>
                              ))}
                              <button onClick={() => set({ out: true })} className="px-2 py-1 rounded text-xs font-bold cursor-pointer" style={a.out ? { backgroundColor: '#f87171', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>out</button>
                              {!a.out && a.to > b && (
                                <Select value={a.how} onChange={e => set({ how: e.target.value })}>
                                  {['advance', 'scored_on_play', 'error', 'wild_pitch', 'passed_ball'].filter(h => h !== 'scored_on_play' || a.to === 4).map(h => <option key={h} value={h}>{h.replace(/_/g, ' ')}</option>)}
                                </Select>
                              )}
                              {!a.out && a.to === 4 && state.half_misplay && !state.bases[b].unearned && (
                                <span className="flex items-center gap-1 text-xs" title={`${state.half_misplay.kind} happened earlier this half — rule the run, or it stays under review and the pitcher's ER is withheld`}>
                                  <span style={{ color: '#fbbf24' }}>ER?</span>
                                  {[['earned', false], ['unearned', true]].map(([label, val]) => (
                                    <button key={label} onClick={() => set({ unearned: a.unearned === val ? undefined : val })} className="px-2 py-1 rounded text-xs font-bold cursor-pointer"
                                      style={a.unearned === val ? { backgroundColor: '#fbbf24', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>{label}</button>
                                  ))}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <PrimaryButton onClick={finishResult} disabled={!resultPanel.result || busy}>Save play (Enter)</PrimaryButton>
                      <GhostButton onClick={() => setResultPanel(null)}>Back (Esc)</GhostButton>
                    </div>
                  </div>
                )}
                {/* between-batter runner plays */}
                {!resultPanel && [3, 2, 1].some(b => state.bases[b]) && (
                  <div className="mt-3 pt-2 border-t" style={{ borderColor: '#1e3a5f' }}>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Runner plays before the next pitch</p>
                      {videoOn && data.modules?.steal && battingSide === 'us' && (
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: '#cfe8ff' }} data-testid="time-steals">
                          <input type="checkbox" checked={timeSteals} onChange={e => setTimeSteals(e.target.checked)} /> queue steal timing with each SB / CS
                        </label>
                      )}
                    </div>
                    {[3, 2, 1].filter(b => state.bases[b]).map(b => (
                      <div key={b} className="flex items-center gap-1.5 py-1 flex-wrap text-xs">
                        <span className="w-40 truncate" style={{ color: '#cfe8ff' }}>{b}B · {refName(state.bases[b].ref)}</span>
                        {b < 3 && <GhostButton onClick={() => runnerPlay(b, 'stolen_base', b + 1)}>SB → {b + 1}B</GhostButton>}
                        {b === 3 && <GhostButton onClick={() => runnerPlay(b, 'stolen_base', 4)}>steals home</GhostButton>}
                        <GhostButton onClick={() => runnerPlay(b, 'caught_stealing', b + 1, true)}>CS</GhostButton>
                        <GhostButton onClick={() => runnerPlay(b, 'pickoff', b, true)}>picked off</GhostButton>
                        <GhostButton onClick={() => runnerPlay(b, 'defensive_indifference', Math.min(4, b + 1))}>indifference</GhostButton>
                        <GhostButton onClick={() => setSub({ kind: 'courtesy_runner', side: battingSide, base: b, player_in: '', player_in_label: '' })}>courtesy runner</GhostButton>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5 py-1 flex-wrap text-xs mt-1">
                      <span className="w-40" style={{ color: '#64748b' }}>everyone moves up</span>
                      <GhostButton onClick={() => everybodyMoves('wild_pitch')}>wild pitch</GhostButton>
                      <GhostButton onClick={() => everybodyMoves('passed_ball')}>passed ball</GhostButton>
                      <GhostButton onClick={() => everybodyMoves('balk')}>balk</GhostButton>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

        </div>
      )}

      {tab === 'score' && lineupsReady && (
        <div className="mt-3">
          {/* lineups + substitutions: secondary — collapsed under the workspace, opened on demand or when a substitution is in progress */}
          <section className="rounded-2xl border p-4" style={cardStyle} data-testid="lineups">
            <div className="flex items-center justify-between mb-2">
              <button onClick={() => setShowLineups(v => !v)} className="text-[11px] font-bold uppercase tracking-widest cursor-pointer hover:underline" style={{ color: '#94a3b8' }} data-testid="toggle-lineups">
                {showLineups || sub ? '▾' : '▸'} Lineups & substitutions
              </button>
              {!state.final && <GhostButton onClick={() => { setShowLineups(true); setSub({ kind: 'pinch_hitter', side: 'us', slot: '', base: '', player_in: '', player_in_label: '', position: '' }); }}>Substitution</GhostButton>}
            </div>
            {(showLineups || sub) && <>
            {['us', 'them'].map(side => (
              <div key={side} className="mb-3">
                <p className="text-xs font-bold mb-1" style={{ color: side === battingSide ? '#38bdf8' : '#94a3b8' }}>{side === 'us' ? 'Us' : (data.job.opponent_label || 'Them')}{side === battingSide ? ' · batting' : ''} · P: {refName(state.pitcher[side])}</p>
                {state.lineups[side]?.slots.map(s => (
                  <p key={s.slot} className="text-xs py-0.5 flex justify-between" style={{ color: side === battingSide && state.expected_batter?.slot === s.slot ? '#f8fafc' : '#94a3b8' }}>
                    <span>{s.slot}. {refName(s.current)}{s.current && s.starter && ((s.current.player_id && s.current.player_id !== s.starter.player_id) || (!s.current.player_id && s.current.label !== s.starter.label)) ? <span style={{ color: '#fbbf24' }}> (for {refName(s.starter)})</span> : null}</span>
                    <span style={{ color: '#475569' }}>{s.position}</span>
                  </p>
                ))}
              </div>
            ))}
            {sub && (
              <div className="mt-2 pt-3 border-t flex flex-col gap-2" style={{ borderColor: '#1e3a5f' }} data-testid="sub-form">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Kind">
                    <Select value={sub.kind} onChange={e => setSub(s => ({ ...s, kind: e.target.value }))}>{data.vocab.sub_kinds.map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}</Select>
                  </Field>
                  <Field label="Side">
                    <Select value={sub.side} onChange={e => setSub(s => ({ ...s, side: e.target.value }))}><option value="us">us</option><option value="them">them</option></Select>
                  </Field>
                  {['pinch_hitter', 'defensive', 're_entry', 'pitching_change'].includes(sub.kind) && (
                    <Field label={sub.kind === 'pitching_change' ? 'Slot of the pitcher leaving (bench arm only)' : 'Lineup slot'}>
                      <Select value={sub.slot} onChange={e => setSub(s => ({ ...s, slot: e.target.value }))}>
                        <option value="">—</option>{state.lineups[sub.side]?.slots.map(s => <option key={s.slot} value={s.slot}>{s.slot}. {refName(s.current)}</option>)}
                      </Select>
                    </Field>
                  )}
                  {['pinch_runner', 'courtesy_runner'].includes(sub.kind) && (
                    <Field label="Base">
                      <Select value={sub.base} onChange={e => setSub(s => ({ ...s, base: e.target.value }))}>
                        <option value="">—</option>{[1, 2, 3].filter(b => state.bases[b]).map(b => <option key={b} value={b}>{b}B · {refName(state.bases[b].ref)}</option>)}
                      </Select>
                    </Field>
                  )}
                  {sub.side === 'us' ? (
                    <Field label="Player in">
                      <Select value={sub.player_in} onChange={e => setSub(s => ({ ...s, player_in: e.target.value }))}>
                        <option value="">—</option>{data.roster.map(p => <option key={p.id} value={p.id}>{p.jersey ? `#${p.jersey} ` : ''}{p.first_name} {p.last_name}{p.is_guest ? ' · guest' : ''}</option>)}
                      </Select>
                    </Field>
                  ) : (
                    <Field label="Player in (label)"><TextInput value={sub.player_in_label} onChange={e => setSub(s => ({ ...s, player_in_label: e.target.value }))} placeholder="#14" /></Field>
                  )}
                  {['defensive', 'pinch_hitter', 're_entry'].includes(sub.kind) && (
                    <Field label="Position"><Select value={sub.position} onChange={e => setSub(s => ({ ...s, position: e.target.value }))}><option value="">—</option>{POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}</Select></Field>
                  )}
                </div>
                <div className="flex gap-2">
                  <PrimaryButton onClick={saveSub} disabled={busy}>Record substitution</PrimaryButton>
                  <GhostButton onClick={() => setSub(null)}>Cancel</GhostButton>
                </div>
              </div>
            )}
            </>}
          </section>
        </div>
      )}

      {tab === 'box' && <BoxScore data={data} />}

      {tab === 'log' && (
        <section className="rounded-2xl border overflow-hidden" style={cardStyle} data-testid="play-by-play">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}><th className="px-4 py-2">#</th><th className="px-4 py-2">Inning</th><th className="px-4 py-2">Play</th><th className="px-4 py-2 text-right">Actions</th></tr></thead>
            <tbody>
              {[...data.log].reverse().filter(l => !l.child).map(l => {
                const ev = data.events.find(e => e.id === l.id);
                const disputed = ev?.status === 'needs_review';
                return (
                  <tr key={l.id} className="border-t" style={{ borderColor: '#1e3a5f', opacity: disputed ? 0.7 : 1 }}>
                    <td className="px-4 py-2 tabular-nums" style={{ color: '#64748b' }}>{l.sequence}</td>
                    <td className="px-4 py-2 text-xs" style={{ color: '#94a3b8' }}>{l.half ? `${l.half === 'top' ? 'T' : 'B'}${l.inning}` : '—'}</td>
                    <td className="px-4 py-2" style={{ color: '#cfe8ff' }}>
                      {l.timecode_s != null && (
                        <button onClick={() => { if (l.feed_id && l.feed_id !== activeFeedId) setVideoFeedId(l.feed_id); setShowVideo(true); setPendingSeek({ seconds: l.timecode_s, nonce: Date.now() }); }}
                          className="mr-2 text-xs tabular-nums cursor-pointer hover:underline" style={{ color: '#38bdf8' }} title="Jump to this moment in the footage" data-testid={`jump-${l.id}`}>▶ {formatTimecode(l.timecode_s)}</button>
                      )}
                      {l.text}{disputed ? <span className="ml-2 text-xs font-bold" style={{ color: '#fbbf24' }}>under review</span> : null}
                      {l.pitches?.some(x => x.velocity != null || x.pitch_type) && (
                        <span className="ml-2 inline-flex gap-1 flex-wrap align-middle">
                          {l.pitches.map((x, i) => <span key={i} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: x.velocity != null ? '#cfe8ff' : '#64748b' }} title={x.result.replace(/_/g, ' ')}>{x.velocity != null ? `${x.velocity} ` : ''}{x.pitch_type ? x.pitch_type.slice(0, 2).toUpperCase() : x.result === 'ball' ? 'B' : 'S'}</span>)}
                        </span>
                      )}
                      {l.attempt_id && <Link to={`/command/jobs/${jobId}/running`} className="ml-2 text-[10px] font-bold uppercase tracking-wider hover:underline" style={{ color: '#4ade80' }}>timing queued →</Link>}
                      {clipEdit?.id === l.id && (
                        <div className="mt-2 p-2 rounded-xl border flex items-center gap-2 flex-wrap text-xs" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }} data-testid="clip-editor">
                          <span style={{ color: '#94a3b8' }}>moment <b style={{ color: '#cfe8ff' }}>{formatTimecode(clipEdit.t)}</b> · clip <b style={{ color: '#cfe8ff' }}>{formatTimecode(clipEdit.start)}</b> → <b style={{ color: '#cfe8ff' }}>{formatTimecode(clipEdit.end)}</b></span>
                          <GhostButton onClick={() => setClipEdit(c => ({ ...c, t: tc() }))}>moment = here</GhostButton>
                          <GhostButton onClick={() => setClipEdit(c => ({ ...c, start: tc() }))}>start = here</GhostButton>
                          <GhostButton onClick={() => setClipEdit(c => ({ ...c, end: tc() }))}>end = here</GhostButton>
                          <PrimaryButton disabled={busy || !(clipEdit.end > clipEdit.start)} onClick={async () => { const d = await run(() => api.commandScorebookClip(clipEdit.id, { timecode_s: clipEdit.t, clip_start_s: clipEdit.start, clip_end_s: clipEdit.end }), 'Clip saved'); if (d) setClipEdit(null); }}>Save clip</PrimaryButton>
                          <GhostButton onClick={() => setClipEdit(null)}>Cancel</GhostButton>
                        </div>
                      )}
                      {editing?.event?.id === l.id && (
                        <CorrectionEditor editing={editing} setEditing={setEditing} vocab={data.vocab} busy={busy}
                          onSave={async () => { const d = await run(() => api.commandScorebookCorrect(editing.event.id, editing.payload, editing.note), 'Corrected — every dependent total recalculated'); if (d) setEditing(null); }} />
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {ev && ['plate_appearance', 'runner', 'substitution', 'game_final', 'state_adjustment'].includes(ev.event_type) && !editing && (
                        <>
                          {['plate_appearance', 'runner'].includes(ev.event_type) && <GhostButton onClick={() => setEditing({ event: ev, payload: { ...ev.payload }, note: '' })}>Correct</GhostButton>}
                          <span className="inline-block w-1" />
                          <GhostButton onClick={() => { const note = ''; run(() => api.commandScorebookVoid(ev.id, note), 'Voided — history kept'); }}>Void</GhostButton>
                          <span className="inline-block w-1" />
                          {disputed
                            ? <GhostButton onClick={() => run(() => api.commandScorebookResolve(ev.id, ''), 'Resolved — back in the totals')}>Resolve</GhostButton>
                            : disputing === ev.id
                              ? <span className="inline-flex items-center gap-1 flex-wrap" data-testid="dispute-reasons">
                                  {['unclear footage', 'scorer judgment', 'possible misidentification', 'needs video review'].map(reason => (
                                    <button key={reason} onClick={async () => { const d = await run(() => api.commandScorebookDispute(ev.id, reason), `Under review (${reason}) — excluded from totals until resolved`); if (d) setDisputing(null); }}
                                      className="px-2 py-1 rounded text-xs font-bold cursor-pointer" style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>{reason}</button>
                                  ))}
                                  <button onClick={() => setDisputing(null)} className="px-2 py-1 rounded text-xs cursor-pointer" style={{ color: '#64748b' }}>cancel</button>
                                </span>
                              : <GhostButton onClick={() => setDisputing(ev.id)}>Dispute</GhostButton>}
                          {videoOn && l.timecode_s != null && (
                            <>
                              <span className="inline-block w-1" />
                              <GhostButton onClick={() => setClipEdit(clipEdit?.id === ev.id ? null : { id: ev.id, start: l.clip?.[0] ?? Math.max(0, l.timecode_s - 4), end: l.clip?.[1] ?? l.timecode_s + 8, t: l.timecode_s })}>Clip</GhostButton>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {data.log.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-sm" style={{ color: '#64748b' }}>Nothing scored yet.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Diamond({ bases }) {
  const on = b => !!bases[b];
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-label="bases">
      <g transform="translate(32 32) rotate(45)">
        <rect x="-4" y="-24" width="12" height="12" rx="2" fill={on(2) ? '#fbbf24' : 'rgba(30,41,59,0.9)'} stroke="#334155" />
        <rect x="12" y="-4" width="12" height="12" rx="2" fill={on(1) ? '#fbbf24' : 'rgba(30,41,59,0.9)'} stroke="#334155" />
        <rect x="-24" y="-4" width="12" height="12" rx="2" fill={on(3) ? '#fbbf24' : 'rgba(30,41,59,0.9)'} stroke="#334155" />
        <rect x="-4" y="12" width="12" height="12" rx="2" fill="rgba(56,189,248,0.25)" stroke="#334155" />
      </g>
    </svg>
  );
}

function CorrectionEditor({ editing, setEditing, vocab, busy, onSave }) {
  const ev = editing.event;
  const set = patch => setEditing(e => ({ ...e, payload: { ...e.payload, ...patch } }));
  return (
    <div className="mt-2 p-3 rounded-xl border flex flex-col gap-2" style={{ borderColor: 'rgba(251, 191, 36, 0.4)' }} data-testid="correction-editor">
      <p className="text-xs font-bold" style={{ color: '#fbbf24' }}>Correct this {ev.event_type.replace(/_/g, ' ')} — the original stays in the history with your reason.</p>
      {ev.event_type === 'plate_appearance' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Result">
            <Select value={editing.payload.result} onChange={e => set({ result: e.target.value })}>{vocab.pa_results.map(r => <option key={r} value={r}>{LABELS[r]} · {r.replace(/_/g, ' ')}</option>)}</Select>
          </Field>
          <Field label="RBI (blank = auto)"><TextInput type="number" min="0" max="4" value={editing.payload.rbi ?? ''} onChange={e => set({ rbi: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          {editing.payload.result === 'reach_on_error' && <Field label="Error by (label)"><TextInput value={editing.payload.error_label || ''} onChange={e => set({ error_label: e.target.value })} /></Field>}
        </div>
      )}
      {ev.event_type === 'runner' && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="To"><Select value={editing.payload.to} onChange={e => set({ to: Number(e.target.value) })}>{[1, 2, 3, 4].map(b => <option key={b} value={b}>{b === 4 ? 'home' : `${b}B`}</option>)}</Select></Field>
          <Field label="How"><Select value={editing.payload.how} onChange={e => set({ how: e.target.value })}>{vocab.runner_hows.map(h => <option key={h} value={h}>{h.replace(/_/g, ' ')}</option>)}</Select></Field>
          <Field label="Out"><Select value={editing.payload.out ? '1' : '0'} onChange={e => set({ out: e.target.value === '1' })}><option value="0">safe</option><option value="1">out</option></Select></Field>
        </div>
      )}
      <Field label="Reason (audit)"><TextInput value={editing.note} onChange={e => setEditing(x => ({ ...x, note: e.target.value }))} placeholder="video review: clean single, no error" /></Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={onSave} disabled={busy || !editing.note.trim()}>Save correction</PrimaryButton>
        <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
      </div>
    </div>
  );
}

function BoxScore({ data }) {
  const ours = data.tallies.filter(t => t.player_id);
  const theirs = data.tallies.filter(t => !t.player_id);
  // Columns follow the appendix's stored fields; rates are derived and read "—" when there is nothing to divide by.
  const bat = ['bs_pa', 'bs_ab', 'bs_r', 'bs_h', 'bs_1b', 'bs_2b', 'bs_3b', 'bs_hr', 'bs_tb', 'bs_rbi', 'bs_bb', 'bs_ibb', 'bs_k', 'bs_hbp', 'bs_sh', 'bs_sf', 'bs_roe', 'bs_fc', 'bs_sb', 'bs_cs', 'bs_lob'];
  const batRates = ['avg', 'obp', 'slg', 'ops'];
  const pit = ['bs_ip', 'bs_bf', 'bs_pitches', 'bs_strikes', 'bs_balls', 'bs_ha', 'bs_ra', 'bs_er', 'bs_bba', 'bs_ibba', 'bs_hbpa', 'bs_kp', 'bs_hra', 'bs_wp', 'bs_bk', 'bs_ir', 'bs_irs'];
  const pitRates = ['era', 'whip', 'k_per_9', 'bb_per_9', 'strike_pct', 'whiff_pct', 'csw_pct'];
  const fld = ['bs_po', 'bs_a', 'bs_e', 'bs_dp', 'bs_pb'];
  const fldRates = ['fpct'];
  const fielded = t => t.stats.bs_po + t.stats.bs_a + t.stats.bs_e + t.stats.bs_dp + t.stats.bs_pb > 0;
  return (
    <section className="rounded-2xl border p-5" style={cardStyle} data-testid="box-score">
      <p className="text-xs mb-3" style={{ color: '#64748b' }}>Derived live from the event log ({data.version}). Only our players publish; opponent lines are context. Disputed plays are excluded. An ER marked ? awaits the scorer's ruling and is withheld from the record until then.</p>
      <StatTable rows={ours.filter(t => t.stats.bs_pa > 0)} keys={bat} rates={batRates} title="Our batting" />
      <StatTable rows={ours.filter(t => t.stats.bs_bf > 0 || t.outs_pitched > 0)} keys={pit} rates={pitRates} title="Our pitching" />
      <StatTable rows={ours.filter(fielded)} keys={fld} rates={fldRates} title="Our fielding" />
      <StatTable rows={theirs.filter(t => t.stats.bs_pa > 0)} keys={bat} rates={batRates} title="Their batting" />
      <StatTable rows={theirs.filter(t => t.stats.bs_bf > 0 || t.outs_pitched > 0)} keys={pit} rates={pitRates} title="Their pitching" />
      <StatTable rows={theirs.filter(fielded)} keys={fld} rates={fldRates} title="Their fielding" />
      {data.tallies.length === 0 && <p className="text-sm" style={{ color: '#64748b' }}>No plays yet.</p>}
    </section>
  );
}

const HEAD = { bs_pitches: 'PIT', bs_strikes: 'STR', bs_balls: 'BAL', bs_ha: 'H', bs_ra: 'R', bs_bba: 'BB', bs_ibba: 'IBB', bs_hbpa: 'HBP', bs_kp: 'K', bs_hra: 'HR', bs_k: 'K', bs_pk: 'PK', k_per_9: 'K/9', bb_per_9: 'BB/9', strike_pct: 'STR%', whiff_pct: 'WHIFF%', csw_pct: 'CSW%', k_pct: 'K%', bb_pct: 'BB%', fpct: 'FPCT', sb_pct: 'SB%' };

function StatTable({ rows, keys, rates = [], title }) {
  if (!rows.length) return null;
  const head = k => HEAD[k] || k.replace('bs_', '').toUpperCase();
  return (
    <div className="overflow-x-auto mb-4">
      <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>{title}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}><th className="px-3 py-1.5">Player</th>{keys.map(k => <th key={k} className="px-2 py-1.5 text-right">{head(k)}</th>)}{rates.map(k => <th key={k} className="px-2 py-1.5 text-right" style={{ color: '#475569' }}>{head(k)}</th>)}</tr></thead>
        <tbody>{rows.map(t => (
          <tr key={t.key} className="border-t" style={{ borderColor: '#1e3a5f' }}>
            <td className="px-3 py-1.5 font-bold text-white whitespace-nowrap">{t.name || t.label}{!t.player_id ? <span className="text-[10px] ml-1" style={{ color: '#475569' }}>label</span> : null}</td>
            {keys.map(k => (
              <td key={k} className="px-2 py-1.5 text-right tabular-nums" style={{ color: k === 'bs_er' && t.er_uncertain ? '#fbbf24' : '#cfe8ff' }} title={k === 'bs_er' && t.er_uncertain ? 'Awaiting the scorer\'s earned-run ruling — withheld from the record' : undefined}>
                {t.stats[k]}{k === 'bs_er' && t.er_uncertain ? '?' : ''}
              </td>
            ))}
            {rates.map(k => <td key={k} className="px-2 py-1.5 text-right tabular-nums" style={{ color: '#94a3b8' }}>{fmtRate(t.rates?.[k], ['era', 'whip', 'k_per_9', 'bb_per_9'].includes(k) ? 2 : 3)}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
