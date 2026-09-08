import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
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
  fielders_choice: 'FC', reach_on_error: 'E', double_play: 'DP', triple_play: 'TP',
};
const RESULT_KEYS = { 1: 'single', 2: 'double', 3: 'triple', 4: 'home_run', g: 'groundout', y: 'flyout', l: 'lineout', p: 'popout', e: 'reach_on_error', x: 'fielders_choice', v: 'sacrifice_fly', n: 'sacrifice_bunt', d: 'double_play' };
const OUT_RESULTS = new Set(['strikeout', 'strikeout_looking', 'groundout', 'flyout', 'lineout', 'popout', 'sacrifice_fly', 'sacrifice_bunt', 'double_play', 'triple_play']);
const BATTER_TO = { single: 1, double: 2, triple: 3, home_run: 4, walk: 1, intentional_walk: 1, hit_by_pitch: 1, catcher_interference: 1, fielders_choice: 1, reach_on_error: 1 };
const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'EH'];

const refName = r => (r ? (r.name || r.label || (r.player_id ? `#${r.player_id}` : '—')) : '—');

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
    else if (result === 'single' || result === 'fielders_choice' || result === 'reach_on_error') to = b + 1;
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

  const load = useCallback(() => api.commandScorebook(jobId).then(d => { setData(d); return d; }).catch(err => setError(err.message)), [jobId]);
  useEffect(() => { load(); }, [load]);

  const state = data?.state;
  const balls = pitches.filter(p => p.result === 'ball' || p.result === 'intentional_ball').length;
  const strikeCount = useMemo(() => {
    let s = 0;
    for (const p of pitches) {
      if (p.result === 'called_strike' || p.result === 'swinging_strike') s += 1;
      else if (p.result === 'foul' && s < 2) s += 1;
    }
    return Math.min(3, s);
  }, [pitches]);

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
    const next = [...pitches, { result }];
    setPitches(next);
    const b = next.filter(p => p.result === 'ball' || p.result === 'intentional_ball').length;
    let s = 0;
    for (const p of next) { if (p.result === 'called_strike' || p.result === 'swinging_strike') s += 1; else if (p.result === 'foul' && s < 2) s += 1; }
    if (result === 'hit_by_pitch') return openResult('hit_by_pitch', next);
    if (result === 'in_play') return openResult(null, next);
    if (b >= 4) return submitPA({ result: 'walk' }, next, {});
    if (s >= 3) return submitPA({ result: result === 'called_strike' ? 'strikeout_looking' : 'strikeout' }, next, {});
  }

  function openResult(result, pitchList = pitches) {
    setResultPanel({ result, rbi: null, batted_ball: '', direction: '', error_label: '', error_player_id: '', advances: result ? defaultAdvances(result, state.bases) : {}, pitchList });
  }
  function chooseResult(result) {
    setResultPanel(rp => ({ ...rp, result, advances: defaultAdvances(result, state.bases) }));
  }

  async function submitPA(pa, pitchList, advances) {
    const runners = Object.entries(advances || {}).filter(([, a]) => a && (a.out || a.to !== Number(a.from ?? 0))).map(([from, a]) => ({
      from: Number(from), to: a.out ? Number(from) : a.to, how: a.out ? 'out' : a.how, out: !!a.out,
      runner_player_id: state.bases[from]?.ref?.player_id || undefined, runner_label: state.bases[from]?.ref?.label || undefined,
      error_label: a.error_label || undefined,
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
      pitches: pitchList.map(p => ({ result: p.result })),
      runners,
    };
    const d = await run(() => api.commandScorebookPlateAppearance(jobId, body), `${LABELS[pa.result] || pa.result} recorded`);
    if (d) { setPitches([]); setResultPanel(null); setBatterOverride(''); }
  }

  function finishResult() {
    const rp = resultPanel;
    if (!rp?.result) return;
    const adv = {};
    for (const [from, a] of Object.entries(rp.advances)) adv[from] = { ...a, from: Number(from) };
    submitPA({ result: rp.result, rbi: rp.rbi == null || rp.rbi === '' ? undefined : Number(rp.rbi), batted_ball: rp.batted_ball || undefined, direction: rp.direction || undefined, error_label: rp.error_label || undefined, error_player_id: rp.error_player_id || undefined }, rp.pitchList, adv);
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
      const map = { b: 'ball', c: 'called_strike', s: 'swinging_strike', f: 'foul', h: 'hit_by_pitch', i: 'in_play' };
      if (map[k]) { e.preventDefault(); addPitch(map[k]); }
      if (e.key === 'Escape' && pitches.length) setPitches([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── lineup setup ──────────────────────────────────────────────────────
  function startSetup() {
    const ours = (data.roster || []).slice(0, 9).map((p, i) => ({ slot: i + 1, player_id: p.id, label: `${p.first_name} ${p.last_name}`, position: p.primary_position || '' }));
    setSetup({ us_is_home: false, dh: false, ours, theirs: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ slot: n, label: `#${n}`, position: n === 1 ? 'P' : '' })), theirPitcher: '#1' });
  }
  async function saveLineups() {
    const ours = setup.ours.filter(s => s.player_id);
    if (ours.length < 1) return setError('Pick at least one of our players');
    const d1 = await run(() => api.commandScorebookEvent(jobId, { event_type: 'lineup', payload: { side: 'us', us_is_home: setup.us_is_home, dh: setup.dh, slots: ours.map((s, i) => ({ slot: i + 1, player_id: s.player_id, label: s.label, position: s.position })) } }));
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
    const d = await run(() => api.commandScorebookEvent(jobId, { event_type: 'substitution', payload }), `${s.kind.replace(/_/g, ' ')} recorded`);
    if (d) setSub(null);
  }

  // ── between-batter runner play ────────────────────────────────────────
  async function runnerPlay(base, how, to, out = false) {
    const r = state.bases[base];
    if (!r) return;
    await run(() => api.commandScorebookEvent(jobId, { event_type: 'runner', payload: { runner_player_id: r.ref.player_id || undefined, runner_label: r.ref.label || undefined, from: base, to: out ? base : to, how, out } }), `${refName(r.ref)}: ${how.replace(/_/g, ' ')}`);
  }

  if (!data) return <p style={{ color: '#94a3b8' }}>{error || 'Loading scorebook…'}</p>;
  const lineupsReady = !!(state.lineups.us && state.lineups.them);
  const disputedCount = data.events.filter(e => e.status === 'needs_review').length;
  const homeLabel = state.us_is_home ? 'us' : 'them';
  const awayLabel = state.us_is_home ? 'them' : 'us';

  return (
    <div>
      <Link to={`/command/jobs/${jobId}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-center justify-between gap-3 mt-1 mb-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Scorebook</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Keyboard first: <b style={{ color: '#cfe8ff' }}>B</b> ball · <b style={{ color: '#cfe8ff' }}>C</b> called strike · <b style={{ color: '#cfe8ff' }}>S</b> swinging · <b style={{ color: '#cfe8ff' }}>F</b> foul · <b style={{ color: '#cfe8ff' }}>H</b> HBP · <b style={{ color: '#cfe8ff' }}>I</b> in play. Four balls or three strikes resolve the at-bat on their own. Everything here is replayed from the event log.
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
      <section className="rounded-2xl border p-4 mb-4" style={cardStyle} data-testid="scoreboard">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-6">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>Away · {awayLabel === 'us' ? 'us' : (data.job.opponent_label || 'them')}</p>
              <p className="text-3xl font-black tabular-nums text-white">{state.score[awayLabel]}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>Home · {homeLabel === 'us' ? 'us' : (data.job.opponent_label || 'them')}</p>
              <p className="text-3xl font-black tabular-nums text-white">{state.score[homeLabel]}</p>
            </div>
            <div className="text-sm" style={{ color: '#cfe8ff' }}>
              {state.final ? <span className="font-bold" style={{ color: '#4ade80' }}>FINAL · {state.final.reason.replace(/_/g, ' ')}</span>
                : state.upcoming ? <><span style={{ color: '#94a3b8' }}>{state.half ? `${state.half === 'top' ? 'Top' : 'Bot'} ${state.inning} complete · ` : ''}next up</span> <span className="font-bold">{state.upcoming.half === 'top' ? 'Top' : 'Bot'} {state.upcoming.inning}</span></>
                : state.half ? <><span className="font-bold">{state.half === 'top' ? 'Top' : 'Bot'} {state.inning}</span> · {state.outs} out{state.outs === 1 ? '' : 's'}{pitches.length ? ` · ${balls}-${strikeCount}` : ''}</>
                : <span style={{ color: '#94a3b8' }}>Not started</span>}
              {state.game_over_suggested && !state.final && (
                <span className="ml-3 text-xs font-bold" style={{ color: '#fbbf24' }}>Game over by {state.game_over_suggested.reason.replace(/_/g, ' ')} ({state.game_over_suggested.detail}) — mark final</span>
              )}
            </div>
          </div>
          {/* bases */}
          <div className="flex items-center gap-3">
            <Diamond bases={state.bases} />
            <div className="text-xs" style={{ color: '#94a3b8' }}>
              {[3, 2, 1].map(b => <p key={b}>{b}B: <span style={{ color: state.bases[b] ? '#f8fafc' : '#475569' }}>{state.bases[b] ? refName(state.bases[b].ref) : 'empty'}</span></p>)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!state.final && lineupsReady && (
              <GhostButton onClick={() => setFinalForm({ reason: state.game_over_suggested?.reason || 'regulation', note: '' })}>Mark final</GhostButton>
            )}
            {state.final && (
              <GhostButton onClick={() => run(() => api.commandScorebookVoid(state.final.event_id, 'reopened for corrections'), 'Game reopened')}>Reopen</GhostButton>
            )}
          </div>
        </div>
        {finalForm && (
          <div className="flex items-end gap-2 mt-3 pt-3 border-t flex-wrap" style={{ borderColor: '#1e3a5f' }}>
            <Field label="Why did the game end?">
              <Select value={finalForm.reason} onChange={e => setFinalForm(f => ({ ...f, reason: e.target.value }))}>
                {data.vocab.final_reasons.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </Select>
            </Field>
            <Field label="Note"><TextInput value={finalForm.note} onChange={e => setFinalForm(f => ({ ...f, note: e.target.value }))} placeholder="1:45 time limit" /></Field>
            <PrimaryButton disabled={busy} onClick={async () => { const d = await run(() => api.commandScorebookEvent(jobId, { event_type: 'game_final', payload: finalForm }), 'Game marked final — validate the game record from the job page'); if (d) setFinalForm(null); }}>Mark final</PrimaryButton>
            <GhostButton onClick={() => setFinalForm(null)}>Cancel</GhostButton>
          </div>
        )}
        {data.issues.length > 0 && (
          <div className="mt-3 pt-3 border-t text-xs" style={{ borderColor: '#1e3a5f' }} data-testid="scorebook-issues">
            {data.issues.slice(0, 6).map((i, n) => (
              <p key={n} style={{ color: i.level === 'blocking' ? '#f87171' : '#fbbf24' }}>{i.level === 'blocking' ? '⛔' : '⚠'} {i.message}{i.sequence ? <span style={{ color: '#475569' }}> · #{i.sequence}</span> : null}</p>
            ))}
            {data.issues.length > 6 && <p style={{ color: '#64748b' }}>… {data.issues.length - 6} more in the play-by-play</p>}
          </div>
        )}
      </section>

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
                <GhostButton onClick={() => setSetup(st => ({ ...st, ours: [...st.ours, { slot: st.ours.length + 1, player_id: null, label: '', position: '' }] }))}>+ slot</GhostButton>
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
        <div className="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
          {/* at bat */}
          <section className="rounded-2xl border p-5" style={cardStyle} data-testid="at-bat">
            {state.final ? (
              <p className="text-sm" style={{ color: '#94a3b8' }}>The game is final. Corrections still work from the play-by-play; reopen to keep scoring.</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>At bat · {battingSide === 'us' ? 'us' : (data.job.opponent_label || 'them')}</p>
                    <p className="text-lg font-bold text-white">
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
                <div className="flex items-center gap-4 mb-3">
                  <p className="text-4xl font-black tabular-nums" style={{ color: '#38bdf8' }}>{balls}-{strikeCount}</p>
                  <div className="flex flex-wrap gap-1.5 text-xs" style={{ color: '#94a3b8' }}>
                    {pitches.map((p, i) => <span key={i} className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)' }}>{p.result.replace(/_/g, ' ')}</span>)}
                    {pitches.length > 0 && <button onClick={() => setPitches([])} className="text-xs cursor-pointer hover:underline" style={{ color: '#64748b' }}>clear (Esc)</button>}
                  </div>
                </div>
                {!resultPanel && (
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {[['ball', 'Ball', 'B'], ['called_strike', 'Called K', 'C'], ['swinging_strike', 'Swinging', 'S'], ['foul', 'Foul', 'F'], ['hit_by_pitch', 'HBP', 'H'], ['in_play', 'In play', 'I']].map(([r, label, key]) => (
                      <button key={r} onClick={() => addPitch(r)} disabled={busy} className="px-3 py-3 rounded-xl border text-sm font-bold cursor-pointer hover:bg-slate-800"
                        style={{ borderColor: r === 'in_play' ? '#38bdf8' : '#334155', color: r === 'in_play' ? '#38bdf8' : '#cfe8ff' }} data-testid={`pitch-${r}`}>
                        {label} <span className="text-[10px] ml-1" style={{ color: '#64748b' }}>{key}</span>
                      </button>
                    ))}
                  </div>
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
                        {resultPanel.result === 'reach_on_error' && (
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
                  <div className="mt-4 pt-3 border-t" style={{ borderColor: '#1e3a5f' }}>
                    <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>Runner plays before the next pitch</p>
                    {[3, 2, 1].filter(b => state.bases[b]).map(b => (
                      <div key={b} className="flex items-center gap-1.5 py-1 flex-wrap text-xs">
                        <span className="w-40 truncate" style={{ color: '#cfe8ff' }}>{b}B · {refName(state.bases[b].ref)}</span>
                        {b < 3 && <GhostButton onClick={() => runnerPlay(b, 'stolen_base', b + 1)}>SB → {b + 1}B</GhostButton>}
                        {b === 3 && <GhostButton onClick={() => runnerPlay(b, 'stolen_base', 4)}>steals home</GhostButton>}
                        <GhostButton onClick={() => runnerPlay(b, 'caught_stealing', b + 1, true)}>CS</GhostButton>
                        <GhostButton onClick={() => runnerPlay(b, 'pickoff', b, true)}>picked off</GhostButton>
                        <GhostButton onClick={() => runnerPlay(b, 'wild_pitch', Math.min(4, b + 1))}>WP → {b + 1 === 4 ? 'home' : `${b + 1}B`}</GhostButton>
                        <GhostButton onClick={() => runnerPlay(b, 'passed_ball', Math.min(4, b + 1))}>PB</GhostButton>
                        <GhostButton onClick={() => setSub({ kind: 'courtesy_runner', side: battingSide, base: b, player_in: '', player_in_label: '' })}>courtesy runner</GhostButton>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* lineups + substitutions */}
          <section className="rounded-2xl border p-4" style={cardStyle} data-testid="lineups">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Lineups</p>
              {!state.final && <GhostButton onClick={() => setSub({ kind: 'pinch_hitter', side: 'us', slot: '', base: '', player_in: '', player_in_label: '', position: '' })}>Substitution</GhostButton>}
            </div>
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
                      {l.text}{disputed ? <span className="ml-2 text-xs font-bold" style={{ color: '#fbbf24' }}>under review</span> : null}
                      {editing?.event?.id === l.id && (
                        <CorrectionEditor editing={editing} setEditing={setEditing} vocab={data.vocab} busy={busy}
                          onSave={async () => { const d = await run(() => api.commandScorebookCorrect(editing.event.id, editing.payload, editing.note), 'Corrected — every dependent total recalculated'); if (d) setEditing(null); }} />
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {ev && ['plate_appearance', 'runner', 'substitution', 'game_final'].includes(ev.event_type) && !editing && (
                        <>
                          {['plate_appearance', 'runner'].includes(ev.event_type) && <GhostButton onClick={() => setEditing({ event: ev, payload: { ...ev.payload }, note: '' })}>Correct</GhostButton>}
                          <span className="inline-block w-1" />
                          <GhostButton onClick={() => { const note = ''; run(() => api.commandScorebookVoid(ev.id, note), 'Voided — history kept'); }}>Void</GhostButton>
                          <span className="inline-block w-1" />
                          {disputed
                            ? <GhostButton onClick={() => run(() => api.commandScorebookResolve(ev.id, ''), 'Resolved — back in the totals')}>Resolve</GhostButton>
                            : <GhostButton onClick={() => run(() => api.commandScorebookDispute(ev.id, 'flagged by scorer'), 'Under review — excluded from totals until resolved')}>Dispute</GhostButton>}
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
  const bat = ['bs_pa', 'bs_ab', 'bs_r', 'bs_h', 'bs_2b', 'bs_3b', 'bs_hr', 'bs_rbi', 'bs_bb', 'bs_k', 'bs_hbp', 'bs_sb'];
  const pit = ['bs_ip', 'bs_bf', 'bs_pitches', 'bs_ha', 'bs_ra', 'bs_er', 'bs_bba', 'bs_kp', 'bs_hra'];
  return (
    <section className="rounded-2xl border p-5" style={cardStyle} data-testid="box-score">
      <p className="text-xs mb-3" style={{ color: '#64748b' }}>Derived live from the event log ({data.version}). Only our players publish; opponent lines are context. Disputed plays are excluded.</p>
      <StatTable rows={ours.filter(t => t.stats.bs_pa > 0)} keys={bat} title="Our batting" />
      <StatTable rows={ours.filter(t => t.stats.bs_bf > 0 || t.outs_pitched > 0)} keys={pit} title="Our pitching" />
      <StatTable rows={theirs.filter(t => t.stats.bs_pa > 0)} keys={bat} title="Their batting" />
      <StatTable rows={theirs.filter(t => t.stats.bs_bf > 0 || t.outs_pitched > 0)} keys={pit} title="Their pitching" />
      {data.tallies.length === 0 && <p className="text-sm" style={{ color: '#64748b' }}>No plays yet.</p>}
    </section>
  );
}

function StatTable({ rows, keys, title }) {
  if (!rows.length) return null;
  const head = k => k.replace('bs_', '').toUpperCase();
  return (
    <div className="overflow-x-auto mb-4">
      <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>{title}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}><th className="px-3 py-1.5">Player</th>{keys.map(k => <th key={k} className="px-2 py-1.5 text-right">{head(k)}</th>)}</tr></thead>
        <tbody>{rows.map(t => (
          <tr key={t.key} className="border-t" style={{ borderColor: '#1e3a5f' }}>
            <td className="px-3 py-1.5 font-bold text-white">{t.name || t.label}{!t.player_id ? <span className="text-[10px] ml-1" style={{ color: '#475569' }}>label</span> : null}</td>
            {keys.map(k => <td key={k} className="px-2 py-1.5 text-right tabular-nums" style={{ color: '#cfe8ff' }}>{t.stats[k]}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
