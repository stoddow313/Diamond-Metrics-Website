import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import { games, teamGameSummary, gameBatting, gamePitching, gameDefense, getPlayerName, getPlayerById } from '../data/dummyData';
import { getPlayerAvatarUrl } from '../data/avatars';
import { ArrowLeft, ChevronDown, Play, Film } from 'lucide-react';

const cardStyle = { backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' };
const innerCardStyle = { backgroundColor: 'rgba(30, 41, 59, 0.85)', borderColor: '#334155' };

function InningLine({ label, innings, total, isTeam }) {
  return (
    <div className="flex items-center gap-1 text-sm">
      <span className="w-14 font-bold text-right mr-2" style={{ color: isTeam ? 'white' : '#94a3b8' }}>{label}</span>
      {innings.map((r, i) => (
        <span key={i} className="w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold" style={innerCardStyle}>
          {r}
        </span>
      ))}
      <span className="w-10 h-8 flex items-center justify-center rounded-lg text-sm font-bold ml-2" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
        {total}
      </span>
    </div>
  );
}

export default function GameDetailPage() {
  const { gameId } = useParams();
  const [activeTab, setActiveTab] = useState('batting');

  const game = games.find(g => g.id === Number(gameId));
  const summary = teamGameSummary.find(s => s.gameId === Number(gameId));
  const batting = gameBatting.filter(b => b.gameId === Number(gameId));
  const pitching = gamePitching.filter(p => p.gameId === Number(gameId));
  const defense = gameDefense.filter(d => d.gameId === Number(gameId));

  if (!game) {
    return (
      <div className="max-w-6xl mx-auto py-12 text-center" style={{ color: '#94a3b8' }}>
        Game not found. <Link to="/app/film-room" style={{ color: '#38bdf8' }}>Back to Film Room</Link>
      </div>
    );
  }

  const tabs = [
    { id: 'batting', label: 'Batting' },
    { id: 'pitching', label: 'Pitching' },
    { id: 'defense', label: 'Defense' },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link to="/app/film-room" className="inline-flex items-center gap-2 text-sm mb-4 transition-colors hover:text-white" style={{ color: '#94a3b8' }}>
          <ArrowLeft size={16} /> Back to Film Room
        </Link>
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-2xl font-bold text-white">
            {game.location === 'Away' ? '@ ' : 'vs '}{game.opponent}
          </h1>
          <span
            className="inline-flex items-center justify-center px-3 py-1 rounded-full text-sm font-bold"
            style={{
              backgroundColor: game.result === 'W' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: game.result === 'W' ? '#4ade80' : '#f87171',
            }}
          >
            {game.result} {game.teamRuns}-{game.oppRuns}
          </span>
        </div>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
          {new Date(game.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} — {game.location}
        </p>
      </div>

      {/* Line Score + Video Thumbnail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <div className="rounded-2xl border p-5" style={cardStyle}>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: '#7dd3fc' }}>Line Score</h3>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1 text-xs mb-1" style={{ color: '#64748b' }}>
              <span className="w-14 mr-2" />
              {game.teamInnings.map((_, i) => (
                <span key={i} className="w-8 text-center">{i + 1}</span>
              ))}
              <span className="w-10 ml-2 text-center font-bold">R</span>
            </div>
            <InningLine label="Team" innings={game.teamInnings} total={game.teamRuns} isTeam />
            <InningLine label={game.opponent.slice(0, 8)} innings={game.oppInnings} total={game.oppRuns} />
          </div>
        </div>

        {/* Video Thumbnail */}
        <div
          className="rounded-2xl border p-5 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all group"
          style={cardStyle}
          onMouseEnter={e => e.currentTarget.style.borderColor = '#38bdf8'}
          onMouseLeave={e => e.currentTarget.style.borderColor = '#1e3a5f'}
        >
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
            style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)' }}
          >
            <Play size={28} fill="#38bdf8" style={{ color: '#38bdf8', marginLeft: 3 }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-bold text-white">Watch Game Film</p>
            <p className="text-xs mt-1 flex items-center justify-center gap-1.5" style={{ color: '#94a3b8' }}>
              <Film size={12} />
              Full game available
            </p>
          </div>
        </div>
      </div>

      {/* Team Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Team AVG', value: summary.teamAVG.toFixed(3) },
            { label: 'Team OPS', value: summary.teamOPS.toFixed(3) },
            { label: 'Hard Hit %', value: `${summary.hardHitPct.toFixed(1)}%` },
            { label: 'Contact %', value: `${summary.contactPct.toFixed(1)}%` },
            { label: 'Strike %', value: `${summary.strikePct.toFixed(1)}%` },
            { label: 'Errors', value: summary.errors },
          ].map(stat => (
            <div key={stat.label} className="rounded-xl border p-4 text-center" style={cardStyle}>
              <p className="text-xl font-extrabold text-white">{stat.value}</p>
              <p className="text-xs mt-1 uppercase tracking-wide" style={{ color: '#94a3b8' }}>{stat.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)', border: '1px solid #334155' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer"
            style={{
              backgroundColor: activeTab === tab.id ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
              color: activeTab === tab.id ? '#38bdf8' : '#94a3b8',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Batting Tab */}
      {activeTab === 'batting' && (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                  {['Player', 'PA', 'AB', 'H', '2B', '3B', 'HR', 'R', 'RBI', 'BB', 'K', 'AVG', 'OBP', 'SLG', 'OPS', 'Hard Hit%', 'Contact%', 'Avg EV', 'Max EV'].map(col => (
                    <th key={col} className="py-3 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batting.map(b => {
                  const avg = b.ab > 0 ? (b.h / b.ab).toFixed(3) : '—';
                  const obp = (b.ab + b.bb + b.hbp + b.sf) > 0 ? ((b.h + b.bb + b.hbp) / (b.ab + b.bb + b.hbp + b.sf)).toFixed(3) : '—';
                  const slg = b.ab > 0 ? ((b.singles + 2 * b.doubles + 3 * b.triples + 4 * b.hr) / b.ab).toFixed(3) : '—';
                  const ops = (avg !== '—' && obp !== '—' && slg !== '—') ? (parseFloat(obp) + parseFloat(slg)).toFixed(3) : '—';

                  return (
                    <tr
                      key={b.playerId}
                      className="border-t transition-colors"
                      style={{ borderColor: '#1e3a5f' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td className="py-3 px-3 text-white font-medium">{getPlayerName(b.playerId)}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.pa}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.ab}</td>
                      <td className="py-3 px-3 text-white font-semibold">{b.h}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.doubles}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.triples}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: b.hr > 0 ? '#38bdf8' : '#cbd5e1' }}>{b.hr}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.r}</td>
                      <td className="py-3 px-3 text-white font-semibold">{b.rbi}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.bb}</td>
                      <td className="py-3 px-3" style={{ color: b.k > 2 ? '#f87171' : '#cbd5e1' }}>{b.k}</td>
                      <td className="py-3 px-3 text-white font-semibold">{avg}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{obp}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{slg}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: '#38bdf8' }}>{ops}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.hardHitPct}%</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.contactPct}%</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.avgEV}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: b.maxEV >= 95 ? '#4ade80' : '#cbd5e1' }}>{b.maxEV}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pitching Tab */}
      {activeTab === 'pitching' && (
        <div className="space-y-4">
          {pitching.map(p => {
            const player = getPlayerById(p.playerId);
            const era = p.ip > 0 ? (p.er * 9 / p.ip).toFixed(2) : '0.00';
            const whip = p.ip > 0 ? ((p.bb + p.hAllowed) / p.ip).toFixed(2) : '0.00';
            const kbb = p.bb > 0 ? (p.k / p.bb).toFixed(1) : `${p.k}.0`;

            return (
              <div key={p.playerId} className="rounded-2xl border p-6" style={cardStyle}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {player && <img src={getPlayerAvatarUrl(player)} alt={getPlayerName(p.playerId)} className="w-10 h-10 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />}
                    <div>
                      <h3 className="text-white font-bold">{getPlayerName(p.playerId)}</h3>
                      <p className="text-xs" style={{ color: '#94a3b8' }}>{p.started ? 'Starter' : 'Relief'} — {p.ip} IP, {p.pitchCount} pitches</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                  {[
                    { label: 'ERA', value: era },
                    { label: 'WHIP', value: whip },
                    { label: 'K', value: p.k },
                    { label: 'BB', value: p.bb },
                    { label: 'K/BB', value: kbb },
                    { label: 'Strike %', value: `${p.strikePct}%` },
                    { label: 'Avg Velo', value: p.avgVelo },
                    { label: 'Max Velo', value: p.maxVelo },
                  ].map(stat => (
                    <div key={stat.label} className="rounded-xl border p-3 text-center" style={innerCardStyle}>
                      <p className="text-lg font-extrabold text-white">{stat.value}</p>
                      <p className="text-[10px] mt-0.5 uppercase tracking-wide" style={{ color: '#94a3b8' }}>{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Pitch Mix */}
                <div className="mt-4">
                  <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Pitch Mix</p>
                  <div className="flex gap-2">
                    {[
                      { label: 'Fastball', pct: p.fastballPct, color: '#38bdf8' },
                      { label: 'Changeup', pct: p.changeupPct, color: '#a78bfa' },
                      { label: 'Curveball', pct: p.curvePct, color: '#f59e0b' },
                      { label: 'Slider', pct: p.sliderPct, color: '#10b981' },
                    ].map(pitch => (
                      <div key={pitch.label} className="flex-1">
                        <div className="h-2 rounded-full overflow-hidden mb-1.5" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                          <div className="h-full rounded-full" style={{ width: `${pitch.pct}%`, backgroundColor: pitch.color }} />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px]" style={{ color: '#94a3b8' }}>{pitch.label}</span>
                          <span className="text-xs font-bold" style={{ color: pitch.color }}>{pitch.pct}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Defense Tab */}
      {activeTab === 'defense' && (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                  {['Player', 'Pos', 'Started', 'Inn', 'TC', 'PO', 'A', 'E', 'DP', 'FLD%'].map(col => (
                    <th key={col} className="py-3 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {defense.map(d => {
                  const fldPct = (d.putouts + d.assists + d.errors) > 0
                    ? ((d.putouts + d.assists) / (d.putouts + d.assists + d.errors)).toFixed(3)
                    : '1.000';
                  return (
                    <tr
                      key={`${d.playerId}-${d.position}`}
                      className="border-t transition-colors"
                      style={{ borderColor: '#1e3a5f' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td className="py-3 px-3 text-white font-medium">{getPlayerName(d.playerId)}</td>
                      <td className="py-3 px-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
                          {d.position}
                        </span>
                      </td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{d.started ? 'Yes' : 'No'}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{d.inningsPlayed}</td>
                      <td className="py-3 px-3 text-white font-semibold">{d.totalChances}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{d.putouts}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{d.assists}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: d.errors > 0 ? '#f87171' : '#cbd5e1' }}>{d.errors}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{d.doublePlays}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: fldPct === '1.000' ? '#4ade80' : '#cbd5e1' }}>{fldPct}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
