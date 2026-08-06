import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import BrandMark from '../../components/BrandMark';
import { cardStyle } from '../../components/admin/theme';

// Coach/director portal: read-only, assignment-scoped views. Analytics and
// the full team/tournament dashboards arrive in roadmap Phase 3/4 — this
// portal is the §2 permissions foundation those views will plug into.

export function StaffLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <header className="border-b" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.9)' }}>
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/staff"><BrandMark /></Link>
            <span className="text-xs font-bold tracking-widest uppercase px-2 py-1 rounded" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}>
              Staff
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm hidden sm:inline" style={{ color: '#94a3b8' }}>{user?.name || user?.email}</span>
            <button
              onClick={async () => { await logout(); navigate('/login'); }}
              className="text-sm font-bold px-4 py-2 rounded-xl border cursor-pointer hover:bg-slate-800"
              style={{ borderColor: '#334155', color: '#cfe8ff' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

export function StaffHomePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.staffOverview().then(setData).catch(err => setError(err.message));
  }, []);

  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Your teams & events</h1>
      <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
        Access assigned by Diamond Metrics. Performance analytics are on the way — rosters and schedules are live now.
      </p>

      <div className="grid md:grid-cols-2 gap-6 items-start">
        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-3">Teams</h2>
          {data.teams.length === 0 ? (
            <p className="text-sm" style={{ color: '#94a3b8' }}>No team access assigned.</p>
          ) : data.teams.map(t => (
            <Link key={t.id} to={`/staff/teams/${t.id}`} className="block py-2 border-t hover:bg-slate-800/40 px-2 -mx-2 rounded" style={{ borderColor: '#1e3a5f' }}>
              <span className="font-bold text-white">{t.name}</span>
              <span className="text-sm ml-2" style={{ color: '#94a3b8' }}>{[t.age_group, t.level].filter(Boolean).join(' · ')} · {t.organization_name}</span>
            </Link>
          ))}
        </section>

        <section className="rounded-2xl border p-6" style={cardStyle}>
          <h2 className="text-lg font-bold text-white mb-3">Tournaments</h2>
          {data.tournaments.length === 0 ? (
            <p className="text-sm" style={{ color: '#94a3b8' }}>No tournament access assigned.</p>
          ) : data.tournaments.map(t => (
            <Link key={t.id} to={`/staff/tournaments/${t.id}`} className="block py-2 border-t hover:bg-slate-800/40 px-2 -mx-2 rounded" style={{ borderColor: '#1e3a5f' }}>
              <span className="font-bold text-white">{t.name}</span>
              <span className="text-sm ml-2" style={{ color: '#94a3b8' }}>{t.start_date} → {t.end_date}{t.published ? '' : ' · private'}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}

export function StaffTeamPage() {
  const { teamId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.staffTeam(teamId).then(setData).catch(err => setError(err.status === 404 ? 'You do not have access to this team.' : err.message));
  }, [teamId]);

  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  const { team, roster, entries } = data;
  return (
    <div>
      <Link to="/staff" className="text-xs hover:underline" style={{ color: '#64748b' }}>← Your teams & events</Link>
      <h1 className="text-2xl font-bold text-white mt-1 mb-1">{team.name}</h1>
      <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
        {team.organization_name}{team.age_group ? ` · ${team.age_group}` : ''}{team.level ? ` · ${team.level}` : ''}
      </p>

      <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-3">Active roster</h2>
        {roster.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>No active roster members.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="py-2 pr-3">Player</th><th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Positions</th><th className="py-2 pr-3">Class</th><th className="py-2 pr-3">Profile</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r, i) => (
                <tr key={i} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                  <td className="py-2 pr-3 font-bold text-white">{r.first_name} {r.last_name}</td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>{r.jersey}</td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>{r.positions}</td>
                  <td className="py-2 pr-3" style={{ color: '#94a3b8' }}>{r.grad_year || '—'}</td>
                  <td className="py-2 pr-3">
                    {r.public_slug
                      ? <a href={`/p/${r.public_slug}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: '#38bdf8' }}>View</a>
                      : <span className="text-xs" style={{ color: '#475569' }}>Private</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-2xl border p-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-3">Tournament participation</h2>
        {entries.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>No tournament entries yet.</p>
        ) : entries.map(e => (
          <p key={e.id} className="text-sm py-1" style={{ color: '#cfe8ff' }}>
            <b>{e.tournament_name}</b> · {e.division_name} · {e.start_date}
            {e.placement ? ` · finished ${e.placement}` : ''}
          </p>
        ))}
      </section>
    </div>
  );
}

export function StaffTournamentPage() {
  const { tournamentId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.staffTournament(tournamentId).then(setData).catch(err => setError(err.status === 404 ? 'You do not have access to this tournament.' : err.message));
  }, [tournamentId]);

  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  const { tournament, divisions, entries, games } = data;
  return (
    <div>
      <Link to="/staff" className="text-xs hover:underline" style={{ color: '#64748b' }}>← Your teams & events</Link>
      <h1 className="text-2xl font-bold text-white mt-1 mb-1">{tournament.name}</h1>
      <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
        {tournament.start_date} → {tournament.end_date}{tournament.location ? ` · ${tournament.location}` : ''}
        {tournament.published ? '' : ' · private (not yet published)'}
      </p>

      <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-3">Divisions & teams</h2>
        {divisions.map(d => (
          <div key={d.id} className="mb-3">
            <p className="font-bold text-white text-sm mb-1">{d.name}</p>
            {entries.filter(e => e.division_id === d.id).map(e => (
              <p key={e.id} className="text-sm pl-3" style={{ color: '#cfe8ff' }}>
                {e.team_name}{e.seed ? ` · seed ${e.seed}` : ''}{e.placement ? ` · ${e.placement}` : ''}
              </p>
            ))}
          </div>
        ))}
      </section>

      <section className="rounded-2xl border p-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-3">Games</h2>
        {games.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>No games scheduled.</p>
        ) : games.map(g => (
          <p key={g.id} className="text-sm py-1 border-t" style={{ color: '#cfe8ff', borderColor: '#1e3a5f' }}>
            <span style={{ color: '#94a3b8' }}>{g.game_date}{g.game_time ? ` ${g.game_time}` : ''} · {g.division_name} · </span>
            <b>{g.home_team_name}</b>
            {g.home_score != null && g.away_score != null ? ` ${g.home_score} – ${g.away_score} ` : ' vs '}
            <b>{g.away_team_name}</b>
            {g.status === 'final' && <span className="text-xs ml-2" style={{ color: '#4ade80' }}>FINAL</span>}
          </p>
        ))}
      </section>
    </div>
  );
}
