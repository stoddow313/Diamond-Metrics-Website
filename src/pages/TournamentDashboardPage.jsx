import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock, Users, MapPin } from 'lucide-react';
import { api } from '../lib/api';
import BrandMark from '../components/BrandMark';
import { fmt } from '../lib/format';
import {
  LeaderboardTable, TopPerformerCard, CoverageNote, CalcStamp, ChampionChip,
} from '../components/dashboards/shared';

// Tournament dashboard (/tournaments/:slug) — requirements §5 + Phase 4
// aggregates. Private until published (§9); every section carries coverage
// and sample-size context so partial data reads as partial.

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

const BOARD_TABS = [
  { key: 'hitting', label: 'Hitting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'defense', label: 'Defense' },
  { key: 'speed', label: 'Speed' },
  { key: 'overall', label: 'Overall' },
];

const CARD_TITLES = {
  hitting: 'Top Hitter', pitching: 'Top Pitcher', defense: 'Top Defender',
  speed: 'Top Speed', overall: 'Event Standout',
};

export default function TournamentDashboardPage() {
  const { slug } = useParams();
  const [result, setResult] = useState({ key: '', data: null, error: null });
  const [boardTab, setBoardTab] = useState('hitting');

  useEffect(() => {
    api.viewTournament(slug)
      .then(data => setResult({ key: slug, data, error: null }))
      .catch(err => setResult({ key: slug, data: null, error: { status: err.status, message: err.message } }));
  }, [slug]);

  const data = result.key === slug ? result.data : null;
  const error = result.key === slug ? result.error : null;

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
      <div className="max-w-md mx-auto mt-16 bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
        <Lock size={28} className="mx-auto text-slate-300" />
        <p className="text-sm font-bold text-slate-700 mt-3">
          {error.status === 404 ? 'Tournament not found' : 'This tournament has not been published yet'}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          {error.status === 401
            ? 'Results will appear here once the event is published. Organizers can sign in to preview.'
            : error.status === 403
              ? 'Your account does not have access to this event preview.'
              : 'Check the link and try again.'}
        </p>
        {error.status === 401 && (
          <Link to="/login" className="inline-block mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold">Organizer sign in</Link>
        )}
      </div>
    );
  }
  if (!data) return shell(<p className="text-slate-400 mt-16 text-center">Loading tournament…</p>);

  const { tournament, coverage, counts, divisions, entries, games, standings, leaderboards, top_performers, players_with_data, calc } = data;
  const board = leaderboards?.[boardTab];
  const performerCards = BOARD_TABS.map(t => ({ key: t.key, title: CARD_TITLES[t.key], row: top_performers?.[t.key] })).filter(c => c.row);

  return shell(
    <>
      {/* header + coverage (§5) */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-extrabold text-slate-900 leading-tight">{tournament.name}</h1>
            <p className="text-sm text-slate-500 flex items-center gap-1 flex-wrap">
              {tournament.start_date} → {tournament.end_date}
              {tournament.location && <><MapPin size={12} className="ml-1" />{tournament.location}</>}
              {tournament.organizer && <span>· {tournament.organizer}</span>}
            </p>
          </div>
          {!tournament.published && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-amber-100 text-amber-700">
              Preview — not published
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-slate-600">
          <span><b>{counts.divisions}</b> division{counts.divisions === 1 ? '' : 's'}</span>
          <span><b>{counts.teams}</b> teams</span>
          <span><b>{counts.players}</b> rostered players</span>
          <span><b>{players_with_data}</b> with logged metrics</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <CoverageNote>
            {coverage.games_final} of {coverage.games_total} games have final results
            {coverage.games_final < coverage.games_total ? ' — results shown are partial.' : '.'}
          </CoverageNote>
          <CalcStamp calc={calc} />
        </div>
      </div>

      {/* top performers — Pro-Day-styled cards */}
      {performerCards.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          {performerCards.map(c => <TopPerformerCard key={c.key} title={c.title} row={c.row} />)}
        </div>
      )}

      {/* standings per division */}
      {divisions.map(d => {
        const rows = (standings || []).filter(s => s.division_id === d.id);
        return (
          <div key={d.id} className="mb-4">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">{d.name}</h2>
              <ChampionChip name={d.champion} />
            </div>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                      <th className="py-2 pr-3 font-bold">Seed</th>
                      <th className="py-2 pr-3 font-bold">Team</th>
                      <th className="py-2 pr-3 font-bold text-right">W-L-T</th>
                      <th className="py-2 pr-3 font-bold text-right">Win %</th>
                      <th className="py-2 pr-3 font-bold text-right">RS</th>
                      <th className="py-2 pr-3 font-bold text-right">RA</th>
                      <th className="py-2 pr-3 font-bold text-right">Diff</th>
                      <th className="py-2 pr-3 font-bold">Result</th>
                      <th className="py-2 font-bold text-right">Finals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(s => (
                      <tr key={s.entry_id} className="border-b border-slate-50">
                        <td className="py-2 pr-3 text-slate-400">{s.seed ?? '—'}</td>
                        <td className="py-2 pr-3">
                          <Link to={`/teams/${s.team_slug}?tournament=${slug}`} className="font-bold text-slate-800 hover:text-blue-600">
                            {s.team_name}
                          </Link>
                          {s.pool && <span className="ml-2 text-xs text-slate-400">Pool {s.pool}</span>}
                        </td>
                        <td className="py-2 pr-3 text-right font-bold text-slate-900">{s.wins}-{s.losses}-{s.ties}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{s.win_pct == null ? '—' : fmt(s.win_pct, { decimals: 3 })}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{s.runs_scored ?? '—'}</td>
                        <td className="py-2 pr-3 text-right text-slate-600">{s.runs_allowed ?? '—'}</td>
                        <td className={`py-2 pr-3 text-right font-bold ${s.run_diff > 0 ? 'text-green-600' : s.run_diff < 0 ? 'text-red-500' : 'text-slate-500'}`}>
                          {s.run_diff == null ? '—' : s.run_diff > 0 ? `+${s.run_diff}` : s.run_diff}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{s.placement || '—'}</td>
                        <td className="py-2 text-right text-xs text-slate-400">{s.games_final}/{s.games_total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        );
      })}

      {/* player leaderboards */}
      <Card
        title={`Player leaderboards · ${counts.players} rostered`}
        action={
          <div className="flex gap-1 flex-wrap">
            {BOARD_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setBoardTab(t.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer ${boardTab === t.key ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        <LeaderboardTable board={board} />
      </Card>

      {/* team cards */}
      <div className="mt-4 mb-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-2">Teams</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {entries.map((e, i) => (
            <Link
              key={i}
              to={`/teams/${e.team_slug}?tournament=${slug}`}
              className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:border-blue-300 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                  <Users size={15} className="text-slate-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate">{e.team_name}</p>
                  <p className="text-xs text-slate-400 truncate">
                    {e.organization_name} · {e.division_name}
                    {e.event_roster_count ? ` · ${e.event_roster_count} on event roster` : ''}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* games */}
      <Card title="Games">
        {games.length === 0 ? (
          <p className="text-xs text-slate-400">No games scheduled yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3 font-bold">Date</th>
                  <th className="py-2 pr-3 font-bold">Division</th>
                  <th className="py-2 pr-3 font-bold">Matchup</th>
                  <th className="py-2 pr-3 font-bold text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {games.map(g => (
                  <tr key={g.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{g.date}{g.time ? ` ${g.time}` : ''}</td>
                    <td className="py-2 pr-3 text-slate-500">{g.division_name}</td>
                    <td className="py-2 pr-3 font-bold text-slate-800">
                      <Link to={`/teams/${g.home_team_slug}?tournament=${slug}`} className="hover:text-blue-600">{g.home_team_name}</Link>
                      {' vs '}
                      <Link to={`/teams/${g.away_team_slug}?tournament=${slug}`} className="hover:text-blue-600">{g.away_team_name}</Link>
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      {g.status === 'final' && g.home_score != null
                        ? <b className="text-slate-900">{g.home_score} – {g.away_score}</b>
                        : <span className="text-xs uppercase text-slate-300">{g.status}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
