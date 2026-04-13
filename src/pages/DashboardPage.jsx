import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { games, teamGameSummary, gameBatting, gamePitching, players } from '../data/dummyData';
import { getPlayerAvatarUrl } from '../data/avatars';
import { Trophy, TrendingUp, Target, Zap, Activity, ChevronRight } from 'lucide-react';

const cardStyle = {
  backgroundColor: 'rgba(15, 23, 42, 0.78)',
  borderColor: '#1e3a5f',
};

const innerCardStyle = {
  backgroundColor: 'rgba(30, 41, 59, 0.85)',
  borderColor: '#334155',
};

function StatCard({ label, value, subtitle, icon: Icon }) {
  return (
    <div className="rounded-2xl border p-5 flex flex-col gap-3" style={cardStyle}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#7dd3fc' }}>{label}</p>
        {Icon && <Icon size={16} style={{ color: '#38bdf8' }} />}
      </div>
      <p className="text-3xl font-extrabold text-white leading-none">{value}</p>
      {subtitle && <p className="text-xs" style={{ color: '#94a3b8' }}>{subtitle}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const wins = games.filter(g => g.result === 'W').length;
  const losses = games.filter(g => g.result === 'L').length;
  const totalRuns = games.reduce((s, g) => s + g.teamRuns, 0);
  const totalOppRuns = games.reduce((s, g) => s + g.oppRuns, 0);

  const avgTeamOPS = (teamGameSummary.reduce((s, g) => s + g.teamOPS, 0) / teamGameSummary.length).toFixed(3);
  const avgTeamAVG = (teamGameSummary.reduce((s, g) => s + g.teamAVG, 0) / teamGameSummary.length).toFixed(3);
  const totalK = teamGameSummary.reduce((s, g) => s + g.pitchingK, 0);
  const totalBB = teamGameSummary.reduce((s, g) => s + g.pitchingBB, 0);
  const avgStrikePct = (teamGameSummary.reduce((s, g) => s + g.strikePct, 0) / teamGameSummary.length).toFixed(1);
  const totalHR = teamGameSummary.reduce((s, g) => s + g.hr, 0);
  const totalHits = teamGameSummary.reduce((s, g) => s + g.hits, 0);
  const totalErrors = teamGameSummary.reduce((s, g) => s + g.errors, 0);

  // Top batters by hits across all games
  const batterHits = {};
  gameBatting.forEach(b => {
    batterHits[b.playerId] = (batterHits[b.playerId] || 0) + b.h;
  });
  const topBatters = Object.entries(batterHits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, hits]) => {
      const p = players.find(p => p.id === Number(id));
      return { name: `${p.firstName} ${p.lastName}`, hits, player: p };
    });

  // Top pitchers by K
  const pitcherKs = {};
  gamePitching.forEach(p => {
    pitcherKs[p.playerId] = (pitcherKs[p.playerId] || 0) + p.k;
  });
  const topPitchers = Object.entries(pitcherKs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, ks]) => {
      const p = players.find(p => p.id === Number(id));
      return { name: `${p.firstName} ${p.lastName}`, ks, player: p };
    });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>{user?.teamName} — 2026 Season Overview</p>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Record" value={`${wins}-${losses}`} subtitle={`Run diff: +${totalRuns - totalOppRuns}`} icon={Trophy} />
        <StatCard label="Team AVG" value={avgTeamAVG} subtitle={`${totalHits} total hits`} icon={TrendingUp} />
        <StatCard label="Team OPS" value={avgTeamOPS} subtitle={`${totalHR} HR this season`} icon={Zap} />
        <StatCard label="Strike %" value={`${avgStrikePct}%`} subtitle={`${totalK} K / ${totalBB} BB`} icon={Target} />
      </div>

      {/* Recent Games */}
      <div className="rounded-2xl border p-6" style={cardStyle}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Recent Games</h2>
          <Activity size={16} style={{ color: '#38bdf8' }} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: '#7dd3fc' }}>
                <th className="text-left py-2 px-3 font-semibold text-xs uppercase tracking-wider">Date</th>
                <th className="text-left py-2 px-3 font-semibold text-xs uppercase tracking-wider">Opponent</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">Result</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">Score</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">AVG</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">OPS</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">K (P)</th>
                <th className="text-center py-2 px-3 font-semibold text-xs uppercase tracking-wider">Errors</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {games.map((game, i) => {
                const summary = teamGameSummary.find(s => s.gameId === game.id);
                return (
                  <tr
                    key={game.id}
                    className="border-t transition-colors cursor-pointer"
                    style={{ borderColor: '#1e3a5f' }}
                    onClick={() => navigate(`/app/film-room/${game.id}`)}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <td className="py-3 px-3" style={{ color: '#cbd5e1' }}>
                      {new Date(game.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="py-3 px-3 text-white font-medium">
                      {game.location === 'Away' ? '@ ' : 'vs '}{game.opponent}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold"
                        style={{
                          backgroundColor: game.result === 'W' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: game.result === 'W' ? '#4ade80' : '#f87171',
                        }}
                      >
                        {game.result}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center text-white font-semibold">
                      {game.teamRuns}-{game.oppRuns}
                    </td>
                    <td className="py-3 px-3 text-center" style={{ color: '#cbd5e1' }}>{summary?.teamAVG.toFixed(3)}</td>
                    <td className="py-3 px-3 text-center" style={{ color: '#cbd5e1' }}>{summary?.teamOPS.toFixed(3)}</td>
                    <td className="py-3 px-3 text-center" style={{ color: '#cbd5e1' }}>{summary?.pitchingK}</td>
                    <td className="py-3 px-3 text-center" style={{ color: '#cbd5e1' }}>{summary?.errors}</td>
                    <td className="py-3 px-1 text-center"><ChevronRight size={14} style={{ color: '#475569' }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Leaderboards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top Batters */}
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <h3 className="text-sm font-bold uppercase tracking-wider mb-4" style={{ color: '#7dd3fc' }}>Top Hitters (Hits)</h3>
          <div className="space-y-3">
            {topBatters.map((b, i) => (
              <div key={b.name} className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <img src={getPlayerAvatarUrl(b.player)} alt={b.name} className="w-8 h-8 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: '#38bdf8', color: '#081a3d' }}>{i + 1}</span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white font-medium">{b.name}</span>
                    <span className="text-sm font-bold text-white">{b.hits}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(b.hits / topBatters[0].hits) * 100}%`,
                        background: 'linear-gradient(90deg, #38bdf8, #0ea5e9)',
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Pitchers */}
        <div className="rounded-2xl border p-6" style={cardStyle}>
          <h3 className="text-sm font-bold uppercase tracking-wider mb-4" style={{ color: '#7dd3fc' }}>Top Pitchers (Strikeouts)</h3>
          <div className="space-y-3">
            {topPitchers.map((p, i) => (
              <div key={p.name} className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <img src={getPlayerAvatarUrl(p.player)} alt={p.name} className="w-8 h-8 rounded-full" style={{ backgroundColor: '#1e3a5f' }} />
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: '#38bdf8', color: '#081a3d' }}>{i + 1}</span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white font-medium">{p.name}</span>
                    <span className="text-sm font-bold text-white">{p.ks}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(p.ks / topPitchers[0].ks) * 100}%`,
                        background: 'linear-gradient(90deg, #38bdf8, #0ea5e9)',
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Season Batting Metrics */}
      <div className="rounded-2xl border p-6" style={cardStyle}>
        <h3 className="text-sm font-bold uppercase tracking-wider mb-4" style={{ color: '#7dd3fc' }}>Season Batting Metrics</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Total Hits', value: totalHits },
            { label: 'Home Runs', value: totalHR },
            { label: 'Runs Scored', value: totalRuns },
            { label: 'Total Errors', value: totalErrors },
            { label: 'Stolen Bases', value: teamGameSummary.reduce((s, g) => s + g.sb, 0) },
            { label: 'Avg Hard Hit %', value: `${(teamGameSummary.reduce((s, g) => s + g.hardHitPct, 0) / teamGameSummary.length).toFixed(1)}%` },
          ].map(stat => (
            <div key={stat.label} className="rounded-xl border p-4 text-center" style={innerCardStyle}>
              <p className="text-2xl font-extrabold text-white">{stat.value}</p>
              <p className="text-xs mt-1 uppercase tracking-wide" style={{ color: '#94a3b8' }}>{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
