import { useParams, Link } from 'react-router-dom';
import { useState, useRef, useCallback } from 'react';
import { filmQueue, battingOutcomes, pitchTypes, pitchResults, extraEvents } from '../../data/adminData';
import { getPlayerAvatarUrl } from '../../data/avatars';
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, Volume2, Maximize, Clock, Users, ChevronDown } from 'lucide-react';

const cardStyle = { backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' };
const innerCardStyle = { backgroundColor: 'rgba(30, 41, 59, 0.85)', borderColor: '#334155' };

const outcomeColors = {
  hit: '#4ade80',
  'on-base': '#38bdf8',
  out: '#94a3b8',
  other: '#f59e0b',
};

export default function AdminReviewPage() {
  const { filmId } = useParams();
  const film = filmQueue.find(f => f.id === filmId);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedBatter, setSelectedBatter] = useState('');
  const [selectedPitcher, setSelectedPitcher] = useState('');
  const [inning, setInning] = useState(1);
  const [halfInning, setHalfInning] = useState('top');
  const [outs, setOuts] = useState(0);
  const [events, setEvents] = useState([]);
  const [showBatterDropdown, setShowBatterDropdown] = useState(false);
  const [showPitcherDropdown, setShowPitcherDropdown] = useState(false);
  const [pitchVelo, setPitchVelo] = useState('');
  const [selectedPitchType, setSelectedPitchType] = useState('');
  const [selectedPitchResult, setSelectedPitchResult] = useState('');

  const playIntervalRef = useRef(null);

  if (!film) {
    return (
      <div className="max-w-6xl mx-auto py-12 text-center" style={{ color: '#94a3b8' }}>
        Film not found. <Link to="/admin" style={{ color: '#38bdf8' }}>Back to Queue</Link>
      </div>
    );
  }

  const roster = film.roster || [];
  const positionPlayers = roster.filter(p => !p.primaryPos.includes('HP'));
  const pitchers = roster.filter(p => p.primaryPos.includes('HP') || p.secondaryPos.includes('HP'));

  const batter = roster.find(p => p.id === Number(selectedBatter));
  const pitcher = roster.find(p => p.id === Number(selectedPitcher));

  // Derive box score from events
  const boxScore = {};
  events.forEach(ev => {
    if (!ev.playerId) return;
    if (!boxScore[ev.playerId]) {
      boxScore[ev.playerId] = { pa: 0, ab: 0, h: 0, singles: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0, r: 0 };
    }
    const bs = boxScore[ev.playerId];
    if (ev.type === 'at_bat') {
      bs.pa++;
      const o = ev.outcome;
      if (['1B','2B','3B','HR','K','GO','FO','LO','PO','FC','DP','E'].includes(o)) bs.ab++;
      if (o === '1B') { bs.h++; bs.singles++; }
      if (o === '2B') { bs.h++; bs.doubles++; }
      if (o === '3B') { bs.h++; bs.triples++; }
      if (o === 'HR') { bs.h++; bs.hr++; }
      if (o === 'BB') bs.bb++;
      if (o === 'K') bs.k++;
      if (o === 'HBP') bs.hbp++;
      if (o === 'SF') { bs.pa++; bs.sf++; }
    }
  });

  const pitchLog = {};
  events.filter(e => e.type === 'pitch').forEach(ev => {
    if (!ev.pitcherId) return;
    if (!pitchLog[ev.pitcherId]) {
      pitchLog[ev.pitcherId] = { pitches: 0, strikes: 0, balls: 0, k: 0, bb: 0 };
    }
    const pl = pitchLog[ev.pitcherId];
    pl.pitches++;
    if (['strike_called','strike_swinging','foul'].includes(ev.result)) pl.strikes++;
    if (ev.result === 'ball') pl.balls++;
  });

  function togglePlay() {
    if (isPlaying) {
      clearInterval(playIntervalRef.current);
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      playIntervalRef.current = setInterval(() => {
        setCurrentTime(t => t + 1);
      }, 1000);
    }
  }

  function formatTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function logAtBat(outcomeId) {
    if (!selectedBatter) return;
    const outcome = battingOutcomes.find(o => o.id === outcomeId);
    const newEvent = {
      id: Date.now(),
      type: 'at_bat',
      playerId: Number(selectedBatter),
      playerName: batter ? `${batter.firstName} ${batter.lastName}` : '',
      outcome: outcomeId,
      outcomeLabel: outcome?.label,
      category: outcome?.category,
      inning,
      halfInning,
      timestamp: currentTime,
      pitcherId: Number(selectedPitcher) || null,
    };

    setEvents(prev => [newEvent, ...prev]);

    // Auto-advance outs
    if (outcome?.category === 'out') {
      const newOuts = outs + (outcomeId === 'DP' ? 2 : 1);
      if (newOuts >= 3) {
        setOuts(0);
        if (halfInning === 'top') {
          setHalfInning('bottom');
        } else {
          setHalfInning('top');
          setInning(i => i + 1);
        }
      } else {
        setOuts(newOuts);
      }
    }
  }

  function logPitch() {
    if (!selectedPitchType || !selectedPitchResult || !selectedPitcher) return;
    const pt = pitchTypes.find(p => p.id === selectedPitchType);
    const pr = pitchResults.find(p => p.id === selectedPitchResult);
    const newEvent = {
      id: Date.now(),
      type: 'pitch',
      pitcherId: Number(selectedPitcher),
      pitcherName: pitcher ? `${pitcher.firstName} ${pitcher.lastName}` : '',
      pitchType: selectedPitchType,
      pitchTypeLabel: pt?.label,
      result: selectedPitchResult,
      resultLabel: pr?.label,
      velo: pitchVelo ? Number(pitchVelo) : null,
      inning,
      halfInning,
      timestamp: currentTime,
    };
    setEvents(prev => [newEvent, ...prev]);
    setSelectedPitchType('');
    setSelectedPitchResult('');
    setPitchVelo('');
  }

  function logExtra(eventId) {
    if (!selectedBatter) return;
    const ex = extraEvents.find(e => e.id === eventId);
    const newEvent = {
      id: Date.now(),
      type: 'extra',
      playerId: Number(selectedBatter),
      playerName: batter ? `${batter.firstName} ${batter.lastName}` : '',
      eventType: eventId,
      eventLabel: ex?.label,
      inning,
      halfInning,
      timestamp: currentTime,
    };
    setEvents(prev => [newEvent, ...prev]);
  }

  const totalTeamH = Object.values(boxScore).reduce((s, b) => s + b.h, 0);
  const totalTeamAB = Object.values(boxScore).reduce((s, b) => s + b.ab, 0);
  const teamAVG = totalTeamAB > 0 ? (totalTeamH / totalTeamAB).toFixed(3) : '.000';

  return (
    <div className="max-w-[1600px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/admin" className="inline-flex items-center gap-2 text-sm transition-colors hover:text-white" style={{ color: '#94a3b8' }}>
            <ArrowLeft size={16} />
          </Link>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold" style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', border: '1px solid #334155', color: '#7dd3fc' }}>
            {film.teamLogo}
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">
              {film.teamName} {film.location === 'Away' ? '@ ' : 'vs '}{film.opponent}
            </h1>
            <p className="text-xs" style={{ color: '#94a3b8' }}>
              {new Date(film.gameDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b' }}>
            {halfInning === 'top' ? 'Top' : 'Bot'} {inning} — {outs} Out{outs !== 1 ? 's' : ''}
          </span>
          <span className="text-xs" style={{ color: '#64748b' }}>{events.length} events logged</span>
        </div>
      </div>

      {/* Main layout: Video + Control Panel */}
      <div className="grid grid-cols-12 gap-4">
        {/* Video Player */}
        <div className="col-span-8">
          <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
            {/* Video area */}
            <div className="relative bg-black aspect-video flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-3" style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)', border: '2px solid #38bdf8' }}>
                  <Play size={32} style={{ color: '#38bdf8', marginLeft: 4 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: '#94a3b8' }}>Game Film</p>
                <p className="text-xs mt-1" style={{ color: '#475569' }}>{film.duration} — {film.notes || 'Full game footage'}</p>
              </div>
              {/* Inning overlay */}
              <div className="absolute top-4 left-4 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: 'white' }}>
                {halfInning === 'top' ? '\u25B2' : '\u25BC'} {inning} | {outs} Out
              </div>
              {/* Timer overlay */}
              <div className="absolute top-4 right-4 px-3 py-1.5 rounded-lg text-xs font-mono font-bold" style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: '#38bdf8' }}>
                {formatTime(currentTime)}
              </div>
            </div>

            {/* Transport controls */}
            <div className="px-5 py-3 flex items-center gap-4" style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
              <button onClick={() => setCurrentTime(t => Math.max(0, t - 10))} className="cursor-pointer" style={{ color: '#94a3b8' }}><SkipBack size={18} /></button>
              <button onClick={togglePlay} className="w-10 h-10 rounded-full flex items-center justify-center cursor-pointer" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: 2 }} />}
              </button>
              <button onClick={() => setCurrentTime(t => t + 10)} className="cursor-pointer" style={{ color: '#94a3b8' }}><SkipForward size={18} /></button>

              {/* Scrub bar */}
              <div className="flex-1 h-1.5 rounded-full cursor-pointer" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                <div className="h-full rounded-full" style={{ width: '12%', background: 'linear-gradient(90deg, #38bdf8, #0ea5e9)' }} />
              </div>

              <span className="text-xs font-mono" style={{ color: '#94a3b8' }}>{formatTime(currentTime)} / {film.duration}</span>
              <Volume2 size={16} style={{ color: '#64748b' }} />
              <Maximize size={16} style={{ color: '#64748b' }} />
            </div>
          </div>
        </div>

        {/* Stat Control Panel */}
        <div className="col-span-4 space-y-3">
          {/* Player Selection */}
          <div className="rounded-2xl border p-4" style={cardStyle}>
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Active Players</h3>

            {/* Batter selector */}
            <div className="mb-3">
              <label className="text-[10px] uppercase tracking-wider font-bold block mb-1.5" style={{ color: '#94a3b8' }}>At Bat</label>
              <div className="relative">
                <button
                  onClick={() => { setShowBatterDropdown(!showBatterDropdown); setShowPitcherDropdown(false); }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm text-left cursor-pointer"
                  style={{ ...innerCardStyle, color: batter ? 'white' : '#64748b' }}
                >
                  {batter ? (
                    <span className="flex items-center gap-2">
                      <img src={getPlayerAvatarUrl(batter)} className="w-6 h-6 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                      #{batter.jersey} {batter.firstName} {batter.lastName}
                    </span>
                  ) : 'Select batter...'}
                  <ChevronDown size={14} />
                </button>
                {showBatterDropdown && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl border py-1" style={{ backgroundColor: 'rgba(15, 23, 42, 0.98)', borderColor: '#1e3a5f' }}>
                    {positionPlayers.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedBatter(String(p.id)); setShowBatterDropdown(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left cursor-pointer transition-colors"
                        style={{ color: '#cbd5e1' }}
                        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.08)'}
                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <img src={getPlayerAvatarUrl(p)} className="w-5 h-5 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                        <span className="font-bold" style={{ color: '#38bdf8' }}>#{p.jersey}</span>
                        {p.firstName} {p.lastName}
                        <span className="ml-auto text-[10px]" style={{ color: '#64748b' }}>{p.primaryPos}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Pitcher selector */}
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold block mb-1.5" style={{ color: '#94a3b8' }}>Pitching</label>
              <div className="relative">
                <button
                  onClick={() => { setShowPitcherDropdown(!showPitcherDropdown); setShowBatterDropdown(false); }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm text-left cursor-pointer"
                  style={{ ...innerCardStyle, color: pitcher ? 'white' : '#64748b' }}
                >
                  {pitcher ? (
                    <span className="flex items-center gap-2">
                      <img src={getPlayerAvatarUrl(pitcher)} className="w-6 h-6 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                      #{pitcher.jersey} {pitcher.firstName} {pitcher.lastName}
                    </span>
                  ) : 'Select pitcher...'}
                  <ChevronDown size={14} />
                </button>
                {showPitcherDropdown && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl border py-1" style={{ backgroundColor: 'rgba(15, 23, 42, 0.98)', borderColor: '#1e3a5f' }}>
                    {pitchers.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedPitcher(String(p.id)); setShowPitcherDropdown(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left cursor-pointer transition-colors"
                        style={{ color: '#cbd5e1' }}
                        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.08)'}
                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <img src={getPlayerAvatarUrl(p)} className="w-5 h-5 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                        <span className="font-bold" style={{ color: '#38bdf8' }}>#{p.jersey}</span>
                        {p.firstName} {p.lastName}
                        <span className="ml-auto text-[10px]" style={{ color: '#64748b' }}>{p.primaryPos}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* At-Bat Outcomes */}
          <div className="rounded-2xl border p-4" style={cardStyle}>
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>At-Bat Result</h3>
            <div className="grid grid-cols-4 gap-1.5">
              {battingOutcomes.map(o => (
                <button
                  key={o.id}
                  onClick={() => logAtBat(o.id)}
                  disabled={!selectedBatter}
                  className="py-2 px-1 rounded-lg text-xs font-bold transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ backgroundColor: `${outcomeColors[o.category]}15`, color: outcomeColors[o.category], border: `1px solid ${outcomeColors[o.category]}30` }}
                  onMouseEnter={e => { if (selectedBatter) e.currentTarget.style.backgroundColor = `${outcomeColors[o.category]}30`; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = `${outcomeColors[o.category]}15`; }}
                >
                  {o.shortLabel}
                </button>
              ))}
            </div>
          </div>

          {/* Pitch Tracking */}
          <div className="rounded-2xl border p-4" style={cardStyle}>
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Pitch Tracking</h3>

            {/* Pitch type */}
            <div className="flex gap-1.5 mb-2">
              {pitchTypes.map(pt => (
                <button
                  key={pt.id}
                  onClick={() => setSelectedPitchType(pt.id)}
                  className="flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer"
                  style={{
                    backgroundColor: selectedPitchType === pt.id ? `${pt.color}25` : 'transparent',
                    color: selectedPitchType === pt.id ? pt.color : '#64748b',
                    border: `1px solid ${selectedPitchType === pt.id ? pt.color : '#334155'}`,
                  }}
                >
                  {pt.id}
                </button>
              ))}
            </div>

            {/* Pitch result */}
            <div className="flex gap-1.5 mb-2">
              {pitchResults.map(pr => (
                <button
                  key={pr.id}
                  onClick={() => setSelectedPitchResult(pr.id)}
                  className="flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer"
                  style={{
                    backgroundColor: selectedPitchResult === pr.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                    color: selectedPitchResult === pr.id ? '#38bdf8' : '#64748b',
                    border: `1px solid ${selectedPitchResult === pr.id ? '#38bdf8' : '#334155'}`,
                  }}
                >
                  {pr.short}
                </button>
              ))}
            </div>

            {/* Velo + log button */}
            <div className="flex gap-2">
              <input
                type="number"
                value={pitchVelo}
                onChange={e => setPitchVelo(e.target.value)}
                placeholder="MPH"
                className="w-20 px-2 py-1.5 rounded-lg border text-xs text-white outline-none text-center"
                style={{ ...innerCardStyle }}
              />
              <button
                onClick={logPitch}
                disabled={!selectedPitchType || !selectedPitchResult || !selectedPitcher}
                className="flex-1 py-1.5 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}
              >
                Log Pitch
              </button>
            </div>
          </div>

          {/* Extra Events */}
          <div className="rounded-2xl border p-4" style={cardStyle}>
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Base Running / Other</h3>
            <div className="flex gap-1.5 flex-wrap">
              {extraEvents.map(ev => (
                <button
                  key={ev.id}
                  onClick={() => logExtra(ev.id)}
                  disabled={!selectedBatter}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'rgba(139, 92, 246, 0.12)', color: '#a78bfa', border: '1px solid rgba(139, 92, 246, 0.25)' }}
                >
                  {ev.label}
                </button>
              ))}
            </div>
          </div>

          {/* Inning Controls */}
          <div className="rounded-2xl border p-4" style={cardStyle}>
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Game State</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setHalfInning(halfInning === 'top' ? 'bottom' : 'top'); setOuts(0); if (halfInning === 'bottom') setInning(i => i + 1); }}
                className="flex-1 py-2 rounded-lg text-xs font-bold cursor-pointer"
                style={{ ...innerCardStyle, color: '#cbd5e1' }}
              >
                Next Half
              </button>
              <div className="flex items-center gap-1">
                <span className="text-xs" style={{ color: '#64748b' }}>Outs:</span>
                {[0,1,2].map(o => (
                  <button
                    key={o}
                    onClick={() => setOuts(o)}
                    className="w-7 h-7 rounded-full text-xs font-bold cursor-pointer"
                    style={{
                      backgroundColor: outs > o ? '#f59e0b' : 'rgba(30,41,59,0.85)',
                      color: outs > o ? '#0f172a' : '#64748b',
                      border: '1px solid #334155',
                    }}
                  >
                    {o + 1}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live Box Score */}
      <div className="rounded-2xl border p-6" style={cardStyle}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold" style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', border: '1px solid #334155', color: '#7dd3fc' }}>
              {film.teamLogo}
            </div>
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>
              Live Box Score — {film.teamName}
            </h2>
          </div>
          <div className="flex items-center gap-4 text-xs" style={{ color: '#94a3b8' }}>
            <span>Team AVG: <strong className="text-white">{teamAVG}</strong></span>
            <span>Hits: <strong className="text-white">{totalTeamH}</strong></span>
            <span>Events: <strong className="text-white">{events.length}</strong></span>
          </div>
        </div>

        {Object.keys(boxScore).length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                  {['Player', 'PA', 'AB', 'H', '1B', '2B', '3B', 'HR', 'BB', 'K', 'AVG', 'OBP', 'SLG'].map(col => (
                    <th key={col} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(boxScore).map(([pid, bs]) => {
                  const p = roster.find(r => r.id === Number(pid));
                  if (!p) return null;
                  const avg = bs.ab > 0 ? (bs.h / bs.ab).toFixed(3) : '.000';
                  const obpDenom = bs.ab + bs.bb + bs.hbp + bs.sf;
                  const obp = obpDenom > 0 ? ((bs.h + bs.bb + bs.hbp) / obpDenom).toFixed(3) : '.000';
                  const slg = bs.ab > 0 ? ((bs.singles + 2*bs.doubles + 3*bs.triples + 4*bs.hr) / bs.ab).toFixed(3) : '.000';
                  return (
                    <tr key={pid} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                      <td className="py-2 px-3">
                        <span className="flex items-center gap-2">
                          <img src={getPlayerAvatarUrl(p)} className="w-5 h-5 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                          <span className="text-white font-medium">{p.firstName} {p.lastName}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.pa}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.ab}</td>
                      <td className="py-2 px-3 text-white font-semibold">{bs.h}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.singles}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.doubles}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.triples}</td>
                      <td className="py-2 px-3 font-semibold" style={{ color: bs.hr > 0 ? '#38bdf8' : '#cbd5e1' }}>{bs.hr}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{bs.bb}</td>
                      <td className="py-2 px-3" style={{ color: bs.k > 2 ? '#f87171' : '#cbd5e1' }}>{bs.k}</td>
                      <td className="py-2 px-3 text-white font-semibold">{avg}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{obp}</td>
                      <td className="py-2 px-3" style={{ color: '#cbd5e1' }}>{slg}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center" style={{ color: '#475569' }}>
            <Users size={24} className="mx-auto mb-2" style={{ color: '#334155' }} />
            <p className="text-sm">Box score will populate as you tag at-bat results above.</p>
          </div>
        )}
      </div>

      {/* Event Log */}
      {events.length > 0 && (
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-sm font-bold uppercase tracking-wider mb-4" style={{ color: '#7dd3fc' }}>
            <Clock size={14} className="inline mr-2 -mt-0.5" />
            Event Log ({events.length})
          </h2>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {events.map(ev => (
              <div key={ev.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
                <span className="font-mono shrink-0" style={{ color: '#64748b' }}>{formatTime(ev.timestamp)}</span>
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
                  {ev.halfInning === 'top' ? '\u25B2' : '\u25BC'}{ev.inning}
                </span>
                {ev.type === 'at_bat' && (
                  <span style={{ color: '#cbd5e1' }}>
                    <strong className="text-white">{ev.playerName}</strong>
                    {' — '}
                    <span style={{ color: outcomeColors[ev.category] }}>{ev.outcomeLabel}</span>
                  </span>
                )}
                {ev.type === 'pitch' && (
                  <span style={{ color: '#cbd5e1' }}>
                    <strong className="text-white">{ev.pitcherName}</strong>
                    {' — '}{ev.pitchTypeLabel} → {ev.resultLabel}
                    {ev.velo && <span style={{ color: '#38bdf8' }}> ({ev.velo} mph)</span>}
                  </span>
                )}
                {ev.type === 'extra' && (
                  <span style={{ color: '#cbd5e1' }}>
                    <strong className="text-white">{ev.playerName}</strong>
                    {' — '}<span style={{ color: '#a78bfa' }}>{ev.eventLabel}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
