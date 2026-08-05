import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Lock, Users, Trophy, CalendarDays } from 'lucide-react';
import { api } from '../lib/api';
import BrandMark from '../components/BrandMark';

// Team dashboard (/teams/:slug) — requirements §4. Private by default (§9):
// admins, assigned coaches, and players on the team. The ?tournament= filter
// switches the roster to that event's roster (guests labeled) and narrows
// the schedule.

function Card({ title, children, action }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title && <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function StatTile({ value, label }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3 text-center">
      <p className="text-xl font-extrabold text-slate-900">{value}</p>
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-0.5">{label}</p>
    </div>
  );
}

function StatePanel({ icon, title, note, cta }) {
  const Icon = icon;
  return (
    <div className="max-w-md mx-auto mt-16 bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
      <Icon size={28} className="mx-auto text-slate-300" />
      <p className="text-sm font-bold text-slate-700 mt-3">{title}</p>
      <p className="text-xs text-slate-400 mt-1">{note}</p>
      {cta}
    </div>
  );
}

export default function TeamDashboardPage() {
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tournamentFilter = searchParams.get('tournament') || '';
  // State keyed to the current request so stale results never render and
  // loading resets happen without synchronous setState in the effect.
  const requestKey = `${slug}|${tournamentFilter}`;
  const [result, setResult] = useState({ key: '', data: null, error: null });

  useEffect(() => {
    api.viewTeam(slug, tournamentFilter)
      .then(data => setResult({ key: requestKey, data, error: null }))
      .catch(err => setResult({ key: requestKey, data: null, error: { status: err.status, message: err.message } }));
  }, [slug, tournamentFilter, requestKey]);

  const data = result.key === requestKey ? result.data : null;
  const error = result.key === requestKey ? result.error : null;

  const shell = children => (
    <div className="min-h-screen pb-10" style={{ backgroundColor: '#eef2f7' }}>
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-[1100px] mx-auto px-4 md:px-6 py-3">
          <Link to="/"><BrandMark dark /></Link>
        </div>
      </header>
      <main className="max-w-[1100px] mx-auto px-4 md:px-6 mt-6">{children}</main>
    </div>
  );

  if (error) {
    return shell(
      <StatePanel
        icon={Lock}
        title={error.status === 404 ? 'Team not found' : 'This team dashboard is private'}
        note={error.status === 401
          ? 'Sign in with an account that has access to this team.'
          : error.status === 403
            ? 'Your account does not have access to this team. Ask Diamond Metrics if you believe this is a mistake.'
            : 'Check the link and try again.'}
        cta={error.status === 401 && (
          <Link to="/login" className="inline-block mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold">Sign in</Link>
        )}
      />
    );
  }
  if (!data) return shell(<p className="text-slate-400 mt-16 text-center">Loading team…</p>);

  const { team, summary, roster, events, games, context } = data;

  return shell(
    <>
      {/* team header */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 mb-4 flex flex-wrap items-center gap-4">
        <div className="w-14 h-14 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 overflow-hidden">
          {team.logo_url
            ? <img src={team.logo_url} alt="" className="w-full h-full object-cover" />
            : <Users size={22} className="text-slate-300" />}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold text-slate-900 leading-tight">{team.name}</h1>
          <p className="text-sm text-slate-500">
            {team.organization_name}{team.age_group ? ` · ${team.age_group}` : ''}{team.level ? ` · ${team.level}` : ''}
          </p>
        </div>
        {context && (
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Viewing event</p>
            <p className="text-sm font-bold text-slate-800">{context.tournament}</p>
            <button onClick={() => setSearchParams({})} className="text-xs text-slate-400 hover:underline cursor-pointer">clear filter</button>
          </div>
        )}
      </div>

      {/* summary */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-4">
        <StatTile value={`${summary.wins}–${summary.losses}`} label="Record (finals)" />
        <StatTile value={summary.tournaments_played} label="Tournaments" />
        <StatTile value={`${summary.games_final}/${summary.games_total}`} label="Games final" />
        <StatTile value={summary.roster_count} label={context ? 'Event roster' : 'Roster'} />
        <StatTile value={summary.latest_event ? summary.latest_event.date : '—'} label="Latest event" />
      </div>

      {/* data-completeness indicator (§4) */}
      <p className="text-[11px] text-slate-400 mb-4">
        Showing {summary.games_final} of {summary.games_total} games with final scores
        {context ? ` · roster from the ${context.tournament} event roster` : ' · roster as of today'}.
      </p>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Card title={context ? `Event roster — ${context.tournament}` : 'Roster'}>
          {roster.length === 0 ? (
            <p className="text-xs text-slate-400">No roster members{context ? ' on this event roster' : ''} yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-2 font-bold">Player</th><th className="py-2 pr-2 font-bold">#</th>
                  <th className="py-2 pr-2 font-bold">Class</th><th className="py-2 font-bold">Profile</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="py-2 pr-2 font-bold text-slate-800">
                      {r.first_name} {r.last_name}
                      {r.isGuest && <span className="ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Guest</span>}
                    </td>
                    <td className="py-2 pr-2 text-slate-600">{r.jersey}</td>
                    <td className="py-2 pr-2 text-slate-500">{r.grad_year || '—'}</td>
                    <td className="py-2">
                      {r.public_slug
                        ? <Link to={`/p/${r.public_slug}`} className="text-blue-600 hover:underline">View</Link>
                        : <span className="text-xs text-slate-300">Private</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Events">
            {events.length === 0 ? (
              <p className="text-xs text-slate-400">No tournaments yet.</p>
            ) : events.map((e, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                <div>
                  <button
                    onClick={() => setSearchParams({ tournament: e.tournament_slug })}
                    className="text-sm font-bold text-slate-800 hover:text-blue-600 cursor-pointer text-left"
                  >
                    {e.tournament_name}
                  </button>
                  <p className="text-xs text-slate-400">{e.division_name} · {e.start_date}</p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  {e.placement && <p className="font-bold text-amber-600"><Trophy size={11} className="inline mr-1" />{e.placement}</p>}
                  {(e.wins != null || e.losses != null) && <p>{e.wins ?? 0}–{e.losses ?? 0}</p>}
                </div>
              </div>
            ))}
          </Card>

          <Card title={context ? `Games — ${context.tournament}` : 'Recent games'}>
            {games.length === 0 ? (
              <p className="text-xs text-slate-400">No games yet.</p>
            ) : games.slice(0, 12).map(g => {
              const won = g.status === 'final' && g.home_score != null &&
                (g.is_home ? g.home_score > g.away_score : g.away_score > g.home_score);
              return (
                <div key={g.id} className="flex items-center gap-2 py-1.5 text-sm border-b border-slate-50 last:border-0">
                  <CalendarDays size={12} className="text-slate-300 shrink-0" />
                  <span className="text-xs text-slate-400 w-20 shrink-0">{g.date}</span>
                  <span className="flex-1 min-w-0 truncate text-slate-700">
                    {g.home_team_name} {g.home_score != null ? g.home_score : ''} – {g.away_score != null ? g.away_score : ''} {g.away_team_name}
                  </span>
                  {g.status === 'final'
                    ? <span className={`text-[10px] font-bold ${won ? 'text-green-600' : 'text-slate-400'}`}>{won ? 'W' : 'L'}</span>
                    : <span className="text-[10px] text-slate-300 uppercase">{g.status}</span>}
                </div>
              );
            })}
          </Card>
        </div>
      </div>
    </>
  );
}
