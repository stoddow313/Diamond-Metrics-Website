import { Link } from 'react-router-dom';
import { games, teamGameSummary } from '../data/dummyData';
import { Upload, Play, Calendar, MapPin, ChevronRight } from 'lucide-react';

const cardStyle = {
  backgroundColor: 'rgba(15, 23, 42, 0.78)',
  borderColor: '#1e3a5f',
};

export default function FilmRoomPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Film Room</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>{games.length} game films uploaded</p>
        </div>
        <button
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-transform hover:-translate-y-0.5 cursor-pointer"
          style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}
        >
          <Upload size={16} />
          Upload Film
        </button>
      </div>

      {/* Film list */}
      <div className="space-y-3">
        {games.map(game => {
          const summary = teamGameSummary.find(s => s.gameId === game.id);
          return (
            <Link
              key={game.id}
              to={`/app/film-room/${game.id}`}
              className="block rounded-2xl border p-5 transition-all hover:shadow-lg group"
              style={cardStyle}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = '#38bdf8';
                e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.9)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = '#1e3a5f';
                e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.78)';
              }}
            >
              <div className="flex items-center gap-4">
                {/* Thumbnail placeholder */}
                <div
                  className="w-20 h-14 rounded-xl flex items-center justify-center shrink-0"
                  style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', border: '1px solid #334155' }}
                >
                  <Play size={20} style={{ color: '#38bdf8' }} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h3 className="text-white font-semibold text-base">
                      {game.location === 'Away' ? '@ ' : 'vs '}{game.opponent}
                    </h3>
                    <span
                      className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold"
                      style={{
                        backgroundColor: game.result === 'W' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                        color: game.result === 'W' ? '#4ade80' : '#f87171',
                      }}
                    >
                      {game.result} {game.teamRuns}-{game.oppRuns}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
                      <Calendar size={12} />
                      {new Date(game.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    <span className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
                      <MapPin size={12} />
                      {game.location}
                    </span>
                  </div>
                </div>

                {/* Quick stats */}
                <div className="hidden md:flex items-center gap-6">
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-wide" style={{ color: '#64748b' }}>AVG</p>
                    <p className="text-sm font-bold text-white">{summary?.teamAVG.toFixed(3)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-wide" style={{ color: '#64748b' }}>OPS</p>
                    <p className="text-sm font-bold text-white">{summary?.teamOPS.toFixed(3)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-wide" style={{ color: '#64748b' }}>K</p>
                    <p className="text-sm font-bold text-white">{summary?.pitchingK}</p>
                  </div>
                </div>

                <ChevronRight size={18} style={{ color: '#475569' }} className="shrink-0" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
