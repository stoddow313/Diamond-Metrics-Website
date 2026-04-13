import { Link } from 'react-router-dom';
import { filmQueue } from '../../data/adminData';
import { Clock, CheckCircle, PlayCircle, AlertCircle, Calendar, User } from 'lucide-react';

const cardStyle = { backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' };

const statusConfig = {
  pending: { label: 'Needs Review', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', icon: AlertCircle },
  in_progress: { label: 'In Progress', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.12)', icon: PlayCircle },
  complete: { label: 'Complete', color: '#4ade80', bg: 'rgba(74, 222, 128, 0.12)', icon: CheckCircle },
};

export default function AdminFilmQueuePage() {
  const needsAction = filmQueue.filter(f => f.status !== 'complete');
  const completed = filmQueue.filter(f => f.status === 'complete');

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Film Review Queue</h1>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
          {needsAction.length} film{needsAction.length !== 1 ? 's' : ''} awaiting review
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Needs Review', count: filmQueue.filter(f => f.status === 'pending').length, color: '#f59e0b' },
          { label: 'In Progress', count: filmQueue.filter(f => f.status === 'in_progress').length, color: '#38bdf8' },
          { label: 'Completed', count: completed.length, color: '#4ade80' },
        ].map(s => (
          <div key={s.label} className="rounded-2xl border p-5" style={cardStyle}>
            <p className="text-3xl font-extrabold" style={{ color: s.color }}>{s.count}</p>
            <p className="text-xs uppercase tracking-wider mt-1" style={{ color: '#94a3b8' }}>{s.label}</p>
          </div>
        ))}
      </div>

      {/* Needs Action */}
      {needsAction.length > 0 && (
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: '#f59e0b' }}>
            <AlertCircle size={14} className="inline mr-2 -mt-0.5" />
            Needs Attention
          </h2>
          <div className="space-y-3">
            {needsAction.map(film => {
              const sc = statusConfig[film.status];
              const StatusIcon = sc.icon;
              return (
                <Link
                  key={film.id}
                  to={`/admin/review/${film.id}`}
                  className="block rounded-2xl border p-5 transition-all group"
                  style={cardStyle}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = sc.color; e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.9)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#1e3a5f'; e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.78)'; }}
                >
                  <div className="flex items-center gap-4">
                    {/* Team logo */}
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold shrink-0" style={{ backgroundColor: 'rgba(30, 41, 59, 0.85)', border: '1px solid #334155', color: '#7dd3fc' }}>
                      {film.teamLogo}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="text-white font-semibold">
                          {film.teamName} {film.location === 'Away' ? '@ ' : 'vs '}{film.opponent}
                        </h3>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold" style={{ backgroundColor: sc.bg, color: sc.color }}>
                          <StatusIcon size={12} />
                          {sc.label}
                        </span>
                        {film.progress != null && (
                          <span className="text-xs font-semibold" style={{ color: '#38bdf8' }}>{film.progress}%</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                        <span className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
                          <Calendar size={11} />
                          Game: {new Date(film.gameDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
                          <Clock size={11} />
                          {film.duration}
                        </span>
                        <span className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
                          <User size={11} />
                          {film.uploadedBy}
                        </span>
                        {film.notes && (
                          <span className="text-xs" style={{ color: '#64748b' }}>{film.notes}</span>
                        )}
                      </div>
                      {film.progress != null && (
                        <div className="mt-2 h-1.5 rounded-full overflow-hidden max-w-xs" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)' }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${film.progress}%`, background: 'linear-gradient(90deg, #38bdf8, #0ea5e9)' }} />
                        </div>
                      )}
                    </div>

                    <span className="text-xs font-medium shrink-0" style={{ color: '#64748b' }}>
                      Uploaded {new Date(film.uploadDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: '#4ade80' }}>
            <CheckCircle size={14} className="inline mr-2 -mt-0.5" />
            Completed
          </h2>
          <div className="space-y-2">
            {completed.map(film => (
              <div
                key={film.id}
                className="rounded-xl border p-4 flex items-center gap-4"
                style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)', borderColor: 'rgba(30, 58, 95, 0.5)' }}
              >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: 'rgba(74, 222, 128, 0.08)', border: '1px solid rgba(74, 222, 128, 0.2)', color: '#4ade80' }}>
                  {film.teamLogo}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium" style={{ color: '#cbd5e1' }}>
                    {film.teamName} {film.location === 'Away' ? '@ ' : 'vs '}{film.opponent}
                  </p>
                  <p className="text-xs" style={{ color: '#64748b' }}>
                    {new Date(film.gameDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — Completed {new Date(film.completedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}>
                  <CheckCircle size={11} />
                  Done
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
