import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { players } from '../data/dummyData';
import { getPlayerAvatarUrl } from '../data/avatars';
import { Search, Filter, ChevronRight } from 'lucide-react';

const cardStyle = {
  backgroundColor: 'rgba(15, 23, 42, 0.78)',
  borderColor: '#1e3a5f',
};

const positionColors = {
  C: '#f59e0b',
  '1B': '#10b981',
  '2B': '#3b82f6',
  SS: '#8b5cf6',
  '3B': '#ef4444',
  LF: '#06b6d4',
  CF: '#06b6d4',
  RF: '#06b6d4',
  OF: '#06b6d4',
  RHP: '#f97316',
  LHP: '#f97316',
  UTIL: '#6366f1',
  IF: '#a855f7',
};

function PositionBadge({ pos }) {
  const color = positionColors[pos] || '#94a3b8';
  return (
    <span
      className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {pos}
    </span>
  );
}

export default function RosterPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('All');

  const positions = ['All', 'C', 'IF', '1B', '2B', 'SS', '3B', 'OF', 'LF', 'CF', 'RF', 'RHP', 'LHP', 'UTIL'];

  const filtered = players.filter(p => {
    const matchesSearch = `${p.firstName} ${p.lastName} ${p.jersey}`.toLowerCase().includes(search.toLowerCase());
    const matchesPos = posFilter === 'All' || p.primaryPos === posFilter || p.secondaryPos === posFilter;
    return matchesSearch && matchesPos;
  });

  const gradYears = [...new Set(players.map(p => p.gradYear))].sort();

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Roster</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>{players.length} players</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: '#64748b' }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search players..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border text-sm text-white outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
            style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }}
            onFocus={e => e.target.style.borderColor = '#38bdf8'}
            onBlur={e => e.target.style.borderColor = '#334155'}
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Filter size={14} style={{ color: '#64748b' }} />
          {positions.map(pos => (
            <button
              key={pos}
              onClick={() => setPosFilter(pos)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer"
              style={{
                backgroundColor: posFilter === pos ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                color: posFilter === pos ? '#38bdf8' : '#64748b',
                border: `1px solid ${posFilter === pos ? '#38bdf8' : '#334155'}`,
              }}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>

      {/* Roster Table */}
      <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)' }}>
                <th className="text-left py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>#</th>
                <th className="text-left py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Player</th>
                <th className="text-left py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Position</th>
                <th className="text-left py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Alt</th>
                <th className="text-center py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Bats</th>
                <th className="text-center py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Throws</th>
                <th className="text-center py-3 px-4 font-semibold text-xs uppercase tracking-wider" style={{ color: '#7dd3fc' }}>Class</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(player => (
                <tr
                  key={player.id}
                  className="border-t transition-colors cursor-pointer"
                  style={{ borderColor: '#1e3a5f' }}
                  onClick={() => navigate(`/app/roster/${player.id}`)}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.04)'}
                  onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <td className="py-3 px-4">
                    <span className="text-lg font-bold" style={{ color: '#38bdf8' }}>{player.jersey}</span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <img
                        src={getPlayerAvatarUrl(player)}
                        alt={`${player.firstName} ${player.lastName}`}
                        className="w-9 h-9 rounded-full shrink-0"
                        style={{ backgroundColor: '#1e3a5f' }}
                      />
                      <div>
                        <p className="text-white font-semibold">{player.firstName} {player.lastName}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4"><PositionBadge pos={player.primaryPos} /></td>
                  <td className="py-3 px-4"><PositionBadge pos={player.secondaryPos} /></td>
                  <td className="py-3 px-4 text-center text-white font-medium">{player.bats}</td>
                  <td className="py-3 px-4 text-center text-white font-medium">{player.throws}</td>
                  <td className="py-3 px-4 text-center">
                    <span className="text-xs font-semibold px-2 py-1 rounded-md" style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', color: '#cbd5e1' }}>
                      {player.gradYear}
                    </span>
                  </td>
                  <td className="py-3 px-2">
                    <ChevronRight size={16} style={{ color: '#475569' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center" style={{ color: '#64748b' }}>
            <p>No players match your search.</p>
          </div>
        )}
      </div>
    </div>
  );
}
