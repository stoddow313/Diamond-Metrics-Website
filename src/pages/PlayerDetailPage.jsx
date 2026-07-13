import { useParams, Link } from 'react-router-dom';
import { players, games, gameBatting, gamePitching, gameDefense } from '../data/dummyData';
import { getPlayerAvatarUrl } from '../data/avatars';
import { ArrowLeft, TrendingUp, Target, Zap, Shield } from 'lucide-react';

const cardStyle = { backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' };
const innerCardStyle = { backgroundColor: 'rgba(30, 41, 59, 0.85)', borderColor: '#334155' };

const positionColors = {
  C: '#f59e0b', '1B': '#10b981', '2B': '#3b82f6', SS: '#8b5cf6', '3B': '#ef4444',
  LF: '#06b6d4', CF: '#06b6d4', RF: '#06b6d4', OF: '#06b6d4',
  RHP: '#f97316', LHP: '#f97316', UTIL: '#6366f1', IF: '#a855f7',
};

function PositionBadge({ pos }) {
  const color = positionColors[pos] || '#94a3b8';
  return (
    <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: `${color}20`, color }}>
      {pos}
    </span>
  );
}

function StatBox({ label, value, highlight }) {
  return (
    <div className="rounded-xl border p-4 text-center" style={innerCardStyle}>
      <p className="text-xl font-extrabold" style={{ color: highlight ? '#38bdf8' : 'white' }}>{value}</p>
      <p className="text-[10px] mt-1 uppercase tracking-wide" style={{ color: '#94a3b8' }}>{label}</p>
    </div>
  );
}

export default function PlayerDetailPage() {
  const { playerId } = useParams();
  const player = players.find(p => p.id === Number(playerId));

  if (!player) {
    return (
      <div className="max-w-6xl mx-auto py-12 text-center" style={{ color: '#94a3b8' }}>
        Player not found. <Link to="/app/roster" style={{ color: '#38bdf8' }}>Back to Roster</Link>
      </div>
    );
  }

  const batting = gameBatting.filter(b => b.playerId === player.id);
  const pitching = gamePitching.filter(p => p.playerId === player.id);
  const defense = gameDefense.filter(d => d.playerId === player.id);

  // Aggregate batting
  const totalPA = batting.reduce((s, b) => s + b.pa, 0);
  const totalAB = batting.reduce((s, b) => s + b.ab, 0);
  const totalH = batting.reduce((s, b) => s + b.h, 0);
  const totalDoubles = batting.reduce((s, b) => s + b.doubles, 0);
  const totalTriples = batting.reduce((s, b) => s + b.triples, 0);
  const totalHR = batting.reduce((s, b) => s + b.hr, 0);
  const totalR = batting.reduce((s, b) => s + b.r, 0);
  const totalRBI = batting.reduce((s, b) => s + b.rbi, 0);
  const totalBB = batting.reduce((s, b) => s + b.bb, 0);
  const totalK = batting.reduce((s, b) => s + b.k, 0);
  const totalHBP = batting.reduce((s, b) => s + b.hbp, 0);
  const totalSF = batting.reduce((s, b) => s + b.sf, 0);
  const totalSB = batting.reduce((s, b) => s + b.sb, 0);
  const totalSingles = batting.reduce((s, b) => s + b.singles, 0);

  const avg = totalAB > 0 ? (totalH / totalAB).toFixed(3) : '—';
  const obp = (totalAB + totalBB + totalHBP + totalSF) > 0
    ? ((totalH + totalBB + totalHBP) / (totalAB + totalBB + totalHBP + totalSF)).toFixed(3) : '—';
  const slg = totalAB > 0
    ? ((totalSingles + 2 * totalDoubles + 3 * totalTriples + 4 * totalHR) / totalAB).toFixed(3) : '—';
  const ops = (obp !== '—' && slg !== '—') ? (parseFloat(obp) + parseFloat(slg)).toFixed(3) : '—';

  const avgHardHit = batting.length > 0 ? (batting.reduce((s, b) => s + b.hardHitPct, 0) / batting.length).toFixed(1) : '—';
  const avgContact = batting.length > 0 ? (batting.reduce((s, b) => s + b.contactPct, 0) / batting.length).toFixed(1) : '—';
  const avgEV = batting.length > 0 ? (batting.reduce((s, b) => s + b.avgEV, 0) / batting.length).toFixed(1) : '—';
  const maxEV = batting.length > 0 ? Math.max(...batting.map(b => b.maxEV)).toFixed(1) : '—';

  // Aggregate pitching
  const totalIP = pitching.reduce((s, p) => s + p.ip, 0);
  const totalER = pitching.reduce((s, p) => s + p.er, 0);
  const totalPK = pitching.reduce((s, p) => s + p.k, 0);
  const totalPBB = pitching.reduce((s, p) => s + p.bb, 0);
  const totalHAllowed = pitching.reduce((s, p) => s + p.hAllowed, 0);
  const totalPitchCount = pitching.reduce((s, p) => s + p.pitchCount, 0);
  const pERA = totalIP > 0 ? (totalER * 9 / totalIP).toFixed(2) : '—';
  const pWHIP = totalIP > 0 ? ((totalPBB + totalHAllowed) / totalIP).toFixed(2) : '—';
  const pKBB = totalPBB > 0 ? (totalPK / totalPBB).toFixed(1) : totalPK > 0 ? `${totalPK}.0` : '—';
  const avgStrikePct = pitching.length > 0 ? (pitching.reduce((s, p) => s + p.strikePct, 0) / pitching.length).toFixed(1) : '—';
  const pMaxVelo = pitching.length > 0 ? Math.max(...pitching.map(p => p.maxVelo)).toFixed(1) : '—';
  const pAvgVelo = pitching.length > 0 ? (pitching.reduce((s, p) => s + p.avgVelo, 0) / pitching.length).toFixed(1) : '—';

  // Aggregate defense
  const totalTC = defense.reduce((s, d) => s + d.totalChances, 0);
  const totalPO = defense.reduce((s, d) => s + d.putouts, 0);
  const totalA = defense.reduce((s, d) => s + d.assists, 0);
  const totalE = defense.reduce((s, d) => s + d.errors, 0);
  const fldPct = (totalPO + totalA + totalE) > 0 ? ((totalPO + totalA) / (totalPO + totalA + totalE)).toFixed(3) : '—';
  const totalInn = defense.reduce((s, d) => s + d.inningsPlayed, 0);

  const hasBatting = batting.length > 0;
  const hasPitching = pitching.length > 0;
  const hasDefense = defense.length > 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Back link */}
      <Link to="/app/roster" className="inline-flex items-center gap-2 text-sm transition-colors hover:text-white" style={{ color: '#94a3b8' }}>
        <ArrowLeft size={16} /> Back to Roster
      </Link>

      {/* Player header */}
      <div className="rounded-2xl border p-6" style={cardStyle}>
        <div className="flex items-center gap-5 flex-wrap">
          <img
            src={getPlayerAvatarUrl(player)}
            alt={`${player.firstName} ${player.lastName}`}
            className="w-16 h-16 rounded-full shrink-0"
            style={{ backgroundColor: '#1e3a5f' }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-white">{player.firstName} {player.lastName}</h1>
              <span className="text-2xl font-bold" style={{ color: '#38bdf8' }}>#{player.jersey}</span>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <PositionBadge pos={player.primaryPos} />
              <PositionBadge pos={player.secondaryPos} />
              <span className="text-xs px-2 py-0.5 rounded-md" style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', color: '#cbd5e1' }}>Class of {player.gradYear}</span>
              <span className="text-xs" style={{ color: '#94a3b8' }}>Bats: {player.bats} / Throws: {player.throws}</span>
            </div>
          </div>
          {/* Quick highlight stats */}
          <div className="flex gap-4">
            {hasBatting && (
              <div className="text-center">
                <p className="text-2xl font-extrabold" style={{ color: '#38bdf8' }}>{ops}</p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: '#94a3b8' }}>OPS</p>
              </div>
            )}
            {hasPitching && (
              <div className="text-center">
                <p className="text-2xl font-extrabold" style={{ color: '#38bdf8' }}>{pERA}</p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: '#94a3b8' }}>ERA</p>
              </div>
            )}
            {hasDefense && (
              <div className="text-center">
                <p className="text-2xl font-extrabold" style={{ color: '#38bdf8' }}>{fldPct}</p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: '#94a3b8' }}>FLD%</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Season Batting Summary */}
      {hasBatting && (
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={16} style={{ color: '#38bdf8' }} />
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Season Batting</h2>
            <span className="text-xs ml-auto" style={{ color: '#64748b' }}>{batting.length} game{batting.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
            <StatBox label="AVG" value={avg} highlight />
            <StatBox label="OBP" value={obp} />
            <StatBox label="SLG" value={slg} />
            <StatBox label="OPS" value={ops} highlight />
            <StatBox label="H" value={totalH} />
            <StatBox label="HR" value={totalHR} />
            <StatBox label="RBI" value={totalRBI} />
            <StatBox label="R" value={totalR} />
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <StatBox label="PA" value={totalPA} />
            <StatBox label="AB" value={totalAB} />
            <StatBox label="2B" value={totalDoubles} />
            <StatBox label="3B" value={totalTriples} />
            <StatBox label="BB" value={totalBB} />
            <StatBox label="K" value={totalK} />
            <StatBox label="SB" value={totalSB} />
            <StatBox label="HBP" value={totalHBP} />
          </div>

          {/* Advanced metrics */}
          <div className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Advanced Metrics</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Avg EV" value={avgEV} />
              <StatBox label="Max EV" value={maxEV} highlight />
              <StatBox label="Hard Hit %" value={`${avgHardHit}%`} />
              <StatBox label="Contact %" value={`${avgContact}%`} />
            </div>
          </div>
        </div>
      )}

      {/* Game-by-Game Batting Log */}
      {hasBatting && (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="px-6 pt-5 pb-3 flex items-center gap-2">
            <Zap size={16} style={{ color: '#38bdf8' }} />
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Game-by-Game Batting</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                  {['Date', 'Opponent', 'Result', 'PA', 'AB', 'H', '2B', '3B', 'HR', 'RBI', 'BB', 'K', 'AVG', 'OPS', 'EV', 'Max EV'].map(col => (
                    <th key={col} className="py-3 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batting.map(b => {
                  const game = games.find(g => g.id === b.gameId);
                  const bAvg = b.ab > 0 ? (b.h / b.ab).toFixed(3) : '—';
                  const bObp = (b.ab + b.bb + b.hbp + b.sf) > 0 ? ((b.h + b.bb + b.hbp) / (b.ab + b.bb + b.hbp + b.sf)).toFixed(3) : '—';
                  const bSlg = b.ab > 0 ? ((b.singles + 2 * b.doubles + 3 * b.triples + 4 * b.hr) / b.ab).toFixed(3) : '—';
                  const bOps = (bObp !== '—' && bSlg !== '—') ? (parseFloat(bObp) + parseFloat(bSlg)).toFixed(3) : '—';
                  return (
                    <tr
                      key={b.gameId}
                      className="border-t transition-colors"
                      style={{ borderColor: '#1e3a5f' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>
                        {game ? new Date(game.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td className="py-3 px-3 text-white font-medium">
                        {game ? `${game.location === 'Away' ? '@ ' : 'vs '}${game.opponent}` : '—'}
                      </td>
                      <td className="py-3 px-3">
                        {game && (
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold" style={{
                            backgroundColor: game.result === 'W' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                            color: game.result === 'W' ? '#4ade80' : '#f87171',
                          }}>
                            {game.result}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.pa}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.ab}</td>
                      <td className="py-3 px-3 text-white font-semibold">{b.h}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.doubles}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.triples}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: b.hr > 0 ? '#38bdf8' : '#cbd5e1' }}>{b.hr}</td>
                      <td className="py-3 px-3 text-white font-semibold">{b.rbi}</td>
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{b.bb}</td>
                      <td className="py-3 px-3" style={{ color: b.k > 2 ? '#f87171' : '#cbd5e1' }}>{b.k}</td>
                      <td className="py-3 px-3 text-white font-semibold">{bAvg}</td>
                      <td className="py-3 px-3 font-semibold" style={{ color: '#38bdf8' }}>{bOps}</td>
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

      {/* Season Pitching Summary */}
      {hasPitching && (
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-4">
            <Target size={16} style={{ color: '#38bdf8' }} />
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Season Pitching</h2>
            <span className="text-xs ml-auto" style={{ color: '#64748b' }}>{pitching.length} appearance{pitching.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
            <StatBox label="ERA" value={pERA} highlight />
            <StatBox label="WHIP" value={pWHIP} />
            <StatBox label="IP" value={totalIP} />
            <StatBox label="K" value={totalPK} highlight />
            <StatBox label="BB" value={totalPBB} />
            <StatBox label="K/BB" value={pKBB} />
            <StatBox label="Strike %" value={`${avgStrikePct}%`} />
            <StatBox label="Pitches" value={totalPitchCount} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox label="Avg Velo" value={pAvgVelo} />
            <StatBox label="Max Velo" value={pMaxVelo} highlight />
            <StatBox label="H Allowed" value={totalHAllowed} />
            <StatBox label="ER" value={totalER} />
          </div>

          {/* Game-by-game pitching log */}
          <div className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Appearance Log</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                    {['Date', 'Opponent', 'Role', 'IP', 'H', 'ER', 'K', 'BB', 'Pitches', 'Strike %', 'Avg Velo', 'Max Velo'].map(col => (
                      <th key={col} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pitching.map(p => {
                    const game = games.find(g => g.id === p.gameId);
                    return (
                      <tr
                        key={p.gameId}
                        className="border-t transition-colors"
                        style={{ borderColor: '#1e3a5f' }}
                        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>
                          {game ? new Date(game.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td className="py-3 px-3 text-white font-medium">
                          {game ? `${game.location === 'Away' ? '@ ' : 'vs '}${game.opponent}` : '—'}
                        </td>
                        <td className="py-3 px-3">
                          <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{
                            backgroundColor: p.started ? 'rgba(56, 189, 248, 0.12)' : 'rgba(139, 92, 246, 0.12)',
                            color: p.started ? '#38bdf8' : '#a78bfa',
                          }}>
                            {p.started ? 'Start' : 'Relief'}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-white font-semibold">{p.ip}</td>
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{p.hAllowed}</td>
                        <td className="py-3 px-3" style={{ color: p.er > 0 ? '#f87171' : '#cbd5e1' }}>{p.er}</td>
                        <td className="py-3 px-3 text-white font-semibold">{p.k}</td>
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{p.bb}</td>
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{p.pitchCount}</td>
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{p.strikePct}%</td>
                        <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>{p.avgVelo}</td>
                        <td className="py-3 px-3 font-semibold" style={{ color: '#4ade80' }}>{p.maxVelo}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Avg pitch mix across appearances */}
          <div className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#7dd3fc' }}>Avg Pitch Mix</h3>
            <div className="flex gap-2">
              {[
                { label: 'Fastball', key: 'fastballPct', color: '#38bdf8' },
                { label: 'Changeup', key: 'changeupPct', color: '#a78bfa' },
                { label: 'Curveball', key: 'curvePct', color: '#f59e0b' },
                { label: 'Slider', key: 'sliderPct', color: '#10b981' },
              ].map(pitch => {
                const avgPct = (pitching.reduce((s, p) => s + p[pitch.key], 0) / pitching.length).toFixed(0);
                return (
                  <div key={pitch.label} className="flex-1">
                    <div className="h-2 rounded-full overflow-hidden mb-1.5" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                      <div className="h-full rounded-full" style={{ width: `${avgPct}%`, backgroundColor: pitch.color }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: '#94a3b8' }}>{pitch.label}</span>
                      <span className="text-xs font-bold" style={{ color: pitch.color }}>{avgPct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Season Defense Summary */}
      {hasDefense && (
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <div className="flex items-center gap-2 mb-4">
            <Shield size={16} style={{ color: '#38bdf8' }} />
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Season Defense</h2>
            <span className="text-xs ml-auto" style={{ color: '#64748b' }}>{defense.length} game{defense.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
            <StatBox label="FLD %" value={fldPct} highlight />
            <StatBox label="Innings" value={totalInn} />
            <StatBox label="TC" value={totalTC} />
            <StatBox label="PO" value={totalPO} />
            <StatBox label="A" value={totalA} />
            <StatBox label="E" value={totalE} />
            <StatBox label="DP" value={defense.reduce((s, d) => s + d.doublePlays, 0)} />
          </div>

          {/* Game-by-game defense log */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                  {['Date', 'Opponent', 'Pos', 'Started', 'Inn', 'TC', 'PO', 'A', 'E', 'FLD%'].map(col => (
                    <th key={col} className="py-2 px-3 font-semibold text-xs uppercase tracking-wider text-left" style={{ color: '#7dd3fc' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {defense.map(d => {
                  const game = games.find(g => g.id === d.gameId);
                  const dFld = (d.putouts + d.assists + d.errors) > 0
                    ? ((d.putouts + d.assists) / (d.putouts + d.assists + d.errors)).toFixed(3) : '1.000';
                  return (
                    <tr
                      key={`${d.gameId}-${d.position}`}
                      className="border-t transition-colors"
                      style={{ borderColor: '#1e3a5f' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>
                        {game ? new Date(game.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td className="py-3 px-3 text-white font-medium">
                        {game ? `${game.location === 'Away' ? '@ ' : 'vs '}${game.opponent}` : '—'}
                      </td>
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
                      <td className="py-3 px-3 font-semibold" style={{ color: dFld === '1.000' ? '#4ade80' : '#cbd5e1' }}>{dFld}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No stats message */}
      {!hasBatting && !hasPitching && !hasDefense && (
        <div className="rounded-2xl border p-12 text-center" style={cardStyle}>
          <p className="text-lg font-medium" style={{ color: '#64748b' }}>No game stats recorded for this player yet.</p>
        </div>
      )}
    </div>
  );
}
