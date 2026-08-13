import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Lock, Users, Trophy, CalendarDays, Download } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../lib/api';
import BrandMark from '../components/BrandMark';
import { fmt, downloadCsv } from '../lib/format';
import { pageBg, headerBar, cardStyle, inputStyle, text, rowBorder, headBorder, stickyBg } from '../components/dashboards/theme';
import {
  TopPerformerCard, Sparkline, CoverageNote, CalcStamp, GuestBadge, LimitedBadge, PlayerLink, SectionHeading,
} from '../components/dashboards/shared';

// Team dashboard (/teams/:slug) — requirements §4 + Phase 4 aggregates.
// Private by default (§9). Filters live in the URL so views are shareable.
// Selecting a season turns the page into the season dashboard: season
// record, aggregate blocks, leaders, and metric trends over time.

function Card({ title, children, action }) {
  return (
    <div className="rounded-xl border p-3.5" style={cardStyle}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          {title && <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: text.secondary }}>{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function StatTile({ value, label }) {
  return (
    <div className="rounded-xl border p-2.5 text-center" style={cardStyle}>
      <p className="text-xl font-extrabold text-white">{value}</p>
      <p className="text-[9px] font-bold uppercase tracking-wider mt-0.5" style={{ color: text.faint }}>{label}</p>
    </div>
  );
}

function StatePanel({ icon, title, note, cta }) {
  const Icon = icon;
  return (
    <div className="max-w-md mx-auto mt-16 rounded-xl border p-8 text-center" style={cardStyle}>
      <Icon size={28} className="mx-auto" style={{ color: '#334155' }} />
      <p className="text-sm font-bold mt-3" style={{ color: text.body }}>{title}</p>
      <p className="text-xs mt-1" style={{ color: text.secondary }}>{note}</p>
      {cta}
    </div>
  );
}

const POSITION_GROUPS = ['C', 'P', 'INF', 'OF', 'UTIL'];
const GAME_TYPES = ['game', 'scrimmage', 'showcase', 'practice', 'bullpen', 'pro_day', 'athletic_testing'];
const CATEGORY_OPTIONS = [
  { key: '', label: 'All categories' },
  { key: 'hitting', label: 'Hitting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'defense_running', label: 'Defense & Running' },
];
const TREND_LABELS = {
  avg_exit_velo: 'Avg Exit Velocity', max_velo: 'Max Velocity (P)', strike_pct: 'Strike %',
  bs_h: 'Hits per date', bs_r: 'Runs per date',
};

// Comparison table column spec: [key, label, format opts, sample hint]
const COMPARE_COLS = [
  ['games', 'G', { decimals: 0 }],
  ['pa', 'PA', { decimals: 0 }],
  ['avg', 'AVG', { decimals: 3 }],
  ['obp', 'OBP', { decimals: 3 }],
  ['slg', 'SLG', { decimals: 3 }],
  ['ops', 'OPS', { decimals: 3 }],
  ['k_bb', 'K/BB', { decimals: 2 }],
  ['hard_hit_pct', 'HH%', { decimals: 0 }],
  ['avg_ev', 'Avg EV', { decimals: 1 }],
  ['max_ev', 'Max EV', { decimals: 1 }],
  ['strike_pct', 'Strike%', { decimals: 0 }],
  ['max_velo', 'Velo', { decimals: 1 }],
  ['ip', 'IP', { decimals: 1 }],
  ['k_bb_pitching', 'K/BB (P)', { decimals: 2 }],
  ['fielding', 'Fld%', { decimals: 0 }],
  ['errors', 'E', { decimals: 0 }],
  ['arm', 'Arm', { decimals: 0 }],
  ['h_to_first', 'H-1st', { decimals: 2 }],
  ['sprint', 'Sprint', { decimals: 1 }],
  ['sb', 'SB', { decimals: 0 }],
];
const LOWER_BETTER_COLS = new Set(['h_to_first', 'errors', 'k_bb']);

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: text.faint }}>
      {label}
      <select
        value={value}
        onChange={onChange}
        className="border rounded-lg px-2 py-1.5 text-sm font-normal normal-case tracking-normal cursor-pointer"
        style={inputStyle}
      >
        {children}
      </select>
    </label>
  );
}

export default function TeamDashboardPage() {
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sort, setSort] = useState({ col: 'ops', dir: 'desc' });

  const params = {
    tournament: searchParams.get('tournament') || '',
    season: searchParams.get('season') || '',
    from: searchParams.get('from') || '',
    to: searchParams.get('to') || '',
    game_type: searchParams.get('game_type') || '',
    position: searchParams.get('position') || '',
    player: searchParams.get('player') || '',
  };
  const category = searchParams.get('category') || '';
  const requestKey = `${slug}|${JSON.stringify(params)}`;
  const [result, setResult] = useState({ key: '', data: null, error: null });

  useEffect(() => {
    api.viewTeam(slug, params)
      .then(data => setResult({ key: requestKey, data, error: null }))
      .catch(err => setResult({ key: requestKey, data: null, error: { status: err.status, message: err.message } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, requestKey]);

  const data = result.key === requestKey ? result.data : null;
  const error = result.key === requestKey ? result.error : null;

  function setFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next);
  }

  const sortedComparison = useMemo(() => {
    if (!data?.comparison) return [];
    const rows = [...data.comparison];
    const { col, dir } = sort;
    rows.sort((a, b) => {
      const av = col === 'name' ? a.name : a[col];
      const bv = col === 'name' ? b.name : b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;                    // unknown sorts last, both directions
      if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [data, sort]);

  const shell = children => (
    <div className="min-h-screen pb-8" style={pageBg}>
      <header className="border-b" style={headerBar}>
        <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-2.5">
          <Link to="/"><BrandMark /></Link>
        </div>
      </header>
      {/* inline display:block — the marketing stylesheet's unlayered `main { display:flex; gap:72px }`
          outranks Tailwind's layered utilities, so a class can't override it */}
      <main className="max-w-[1200px] mx-auto px-4 md:px-6 mt-4" style={{ display: 'block' }}>{children}</main>
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
          <Link to="/login" className="inline-block mt-4 px-4 py-2 rounded-lg text-sm font-bold" style={{ backgroundColor: text.accent, color: '#06122b' }}>Sign in</Link>
        )}
      />
    );
  }
  if (!data) return shell(<p className="mt-16 text-center" style={{ color: text.secondary }}>Loading team…</p>);

  const { team, summary, roster, events, games, context, seasons, season, aggregates, comparison, top_performers, trends, calc } = data;
  const agg = aggregates;
  const record = agg?.record || { wins: summary.wins, losses: summary.losses, ties: 0 };
  const seasonEvents = season
    ? events.filter(e => e.start_date <= season.end_date && (e.end_date || e.start_date) >= season.start_date)
    : events;
  const performerCards = [
    ['hitting', 'Top Hitter'], ['pitching', 'Top Pitcher'], ['defense', 'Top Defender'], ['speed', 'Top Speed'], ['overall', 'Standout'],
  ].map(([key, title]) => ({ key, title, row: top_performers?.[key] })).filter(c => c.row);

  const exportComparison = () => downloadCsv(
    `${team.name.replace(/\s+/g, '-').toLowerCase()}-players${season ? `-${season.label.replace(/\s+/g, '-').toLowerCase()}` : ''}.csv`,
    ['Player', 'Position', ...COMPARE_COLS.map(([, label]) => label)],
    sortedComparison.map(r => [r.name, r.position, ...COMPARE_COLS.map(([key]) => r[key] ?? '')])
  );

  const visibleBlocks = Object.entries(agg?.blocks || {}).filter(([key]) => !category || key === category);
  const blockTitle = { hitting: 'Hitting', pitching: 'Pitching', defense_running: 'Defense & Running' };

  return shell(
    <>
      {/* team header + context chips */}
      <div className="rounded-xl border p-4 mb-5 flex flex-wrap items-center gap-4" style={cardStyle}>
        <div className="w-14 h-14 rounded-xl border flex items-center justify-center shrink-0 overflow-hidden" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', borderColor: '#1e3a5f' }}>
          {team.logo_url
            ? <img src={team.logo_url} alt="" className="w-full h-full object-cover" />
            : <Users size={22} style={{ color: '#475569' }} />}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold text-white leading-tight">{team.name}</h1>
          <p className="text-sm" style={{ color: text.secondary }}>
            {team.organization_name}{team.age_group ? ` · ${team.age_group}` : ''}{team.level ? ` · ${team.level}` : ''}
          </p>
        </div>
        {season && (
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: text.good }}>Season dashboard</p>
            <p className="text-sm font-bold text-white">{season.label}</p>
            <button onClick={() => setFilter('season', '')} className="text-xs hover:underline cursor-pointer" style={{ color: text.faint }}>clear</button>
          </div>
        )}
        {context && (
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: text.accent }}>Viewing event</p>
            <p className="text-sm font-bold text-white">{context.tournament}</p>
            <button onClick={() => setFilter('tournament', '')} className="text-xs hover:underline cursor-pointer" style={{ color: text.faint }}>clear filter</button>
          </div>
        )}
      </div>

      {/* filters — season, tournament, date range, game type, position, player, category */}
      <section className="mb-5">
      <SectionHeading>Filters</SectionHeading>
      <div className="rounded-xl border p-3.5" style={cardStyle}>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2.5">
          <FilterSelect label="Season" value={params.season} onChange={e => setFilter('season', e.target.value)}>
            <option value="">All</option>
            {(seasons || []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </FilterSelect>
          <FilterSelect label="Tournament" value={params.tournament} onChange={e => setFilter('tournament', e.target.value)}>
            <option value="">All</option>
            {events.map(e => <option key={e.tournament_slug} value={e.tournament_slug}>{e.tournament_name}</option>)}
          </FilterSelect>
          <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: text.faint }}>
            From
            <input type="date" value={params.from} onChange={e => setFilter('from', e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-sm font-normal" style={inputStyle} />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: text.faint }}>
            To
            <input type="date" value={params.to} onChange={e => setFilter('to', e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-sm font-normal" style={inputStyle} />
          </label>
          <FilterSelect label="Game type" value={params.game_type} onChange={e => setFilter('game_type', e.target.value)}>
            <option value="">Games (default)</option>
            {GAME_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </FilterSelect>
          <FilterSelect label="Position" value={params.position} onChange={e => setFilter('position', e.target.value)}>
            <option value="">All</option>
            {POSITION_GROUPS.map(p => <option key={p} value={p}>{p}</option>)}
          </FilterSelect>
          <FilterSelect label="Player" value={params.player} onChange={e => setFilter('player', e.target.value)}>
            <option value="">All</option>
            {(comparison || []).map(p => <option key={p.player_id} value={p.player_id}>{p.name}</option>)}
          </FilterSelect>
          <FilterSelect label="Category" value={category} onChange={e => setFilter('category', e.target.value)}>
            {CATEGORY_OPTIONS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </FilterSelect>
        </div>
        {params.game_type && ['pro_day', 'athletic_testing'].includes(params.game_type) && (
          <p className="text-[11px] font-bold mt-2" style={{ color: '#fbbf24' }}>
            Showing {params.game_type.replace('_', ' ')} data — testing metrics are kept separate from game performance by default.
          </p>
        )}
      </div>
      </section>

      {/* record + run tiles + coverage */}
      <section className="mb-5">
      <SectionHeading>Overview{season ? ` — ${season.label}` : context ? ` — ${context.tournament}` : ''}</SectionHeading>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-2">
        <StatTile value={`${record.wins}–${record.losses}${record.ties ? `–${record.ties}` : ''}`} label="Record (finals)" />
        <StatTile value={agg?.runs_scored ?? '—'} label="Runs scored" />
        <StatTile value={agg?.runs_allowed ?? '—'} label="Runs allowed" />
        <StatTile
          value={agg?.run_diff == null ? '—' : agg.run_diff > 0 ? `+${agg.run_diff}` : agg.run_diff}
          label="Run diff"
        />
        <StatTile value={agg?.games_tracked ?? 0} label="Games tracked" />
        <StatTile value={`${summary.games_final}/${summary.games_total}`} label="Event finals" />
      </div>

      {/* coverage statement (§4) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <CoverageNote>
          {summary.games_final} of {summary.games_total} scheduled games have final scores ·
          {' '}{agg?.players_with_data ?? 0} of {summary.roster_count} rostered players have logged data
          {context ? ` · roster from the ${context.tournament} event roster` : season ? ` · ${season.label} attribution by dated membership` : ' · roster as of today'}.
        </CoverageNote>
        <CalcStamp calc={calc} />
      </div>
      </section>

      {/* top performers */}
      {performerCards.length > 0 && (
        <section className="mb-5">
          <SectionHeading>Top Performers</SectionHeading>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {performerCards.map(c => <TopPerformerCard key={c.key} title={c.title} row={c.row} />)}
          </div>
        </section>
      )}

      {/* team aggregate blocks */}
      {visibleBlocks.length > 0 && (
        <section className="mb-5">
        <SectionHeading>Team Totals</SectionHeading>
        <div className={`grid gap-3 ${visibleBlocks.length > 1 ? 'lg:grid-cols-3' : ''}`}>
          {visibleBlocks.map(([key, stats]) => (
            <Card key={key} title={blockTitle[key] || key}>
              <div className="grid grid-cols-2 gap-x-4">
                {stats.map(s => (
                  <div key={s.key} className="flex items-baseline justify-between py-1 border-b gap-2" style={rowBorder}>
                    <span className="text-xs truncate" style={{ color: text.secondary }}>{s.label}</span>
                    <span className="text-sm font-bold text-white whitespace-nowrap">
                      {fmt(s.value, s)}
                      {s.sample != null && s.value != null && (
                        <span className="text-[9px] font-normal ml-1" style={{ color: text.faint }}>
                          {fmt(s.sample, { decimals: s.sampleUnit === 'IP' ? 1 : 0 })} {s.sampleUnit === 'games' && s.sample === 1 ? 'game' : s.sampleUnit || 'games'}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
        </section>
      )}

      {/* sortable player comparison */}
      <section className="mb-5">
      <SectionHeading>Player Comparison · {sortedComparison.length} with data</SectionHeading>
      <Card
        action={
          <button
            onClick={exportComparison}
            className="flex items-center gap-1.5 text-xs font-bold cursor-pointer hover:text-[#38bdf8]"
            style={{ color: text.secondary }}
          >
            <Download size={13} /> Export CSV
          </button>
        }
      >
        {sortedComparison.length === 0 ? (
          <p className="text-xs" style={{ color: text.faint }}>No logged player data in this scope yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[1080px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider border-b" style={{ color: text.faint, ...headBorder }}>
                  <th className="py-1.5 pr-3 font-bold sticky left-0 cursor-pointer" style={stickyBg} onClick={() => setSort(s => ({ col: 'name', dir: s.col === 'name' && s.dir === 'asc' ? 'desc' : 'asc' }))}>
                    Player{sort.col === 'name' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                  <th className="py-1.5 pr-3 font-bold">Pos</th>
                  {COMPARE_COLS.map(([key, label]) => (
                    <th
                      key={key}
                      className="py-1.5 pr-3 font-bold text-right cursor-pointer whitespace-nowrap hover:text-[#38bdf8]"
                      onClick={() => setSort(s => ({
                        col: key,
                        dir: s.col === key
                          ? (s.dir === 'asc' ? 'desc' : 'asc')
                          : (LOWER_BETTER_COLS.has(key) ? 'asc' : 'desc'),
                      }))}
                    >
                      {label}{sort.col === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedComparison.map(r => (
                  <tr key={r.player_id} className="border-b" style={rowBorder}>
                    <td className="py-1.5 pr-3 whitespace-nowrap sticky left-0" style={stickyBg}>
                      <PlayerLink slug={r.slug} name={r.name} />
                      {r.isGuest && <GuestBadge />}
                      {r.games < (calc?.mins?.samples ?? 2) && <LimitedBadge sample={r.games} unit="games" />}
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: text.secondary }}>{r.position || '—'}</td>
                    {COMPARE_COLS.map(([key, , opts]) => (
                      <td key={key} className="py-1.5 pr-3 text-right whitespace-nowrap" style={{ color: text.body }}>{fmt(r[key], opts)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </section>

      {/* season trends */}
      {trends && trends.length > 0 && (
        <section className="mb-5">
        <SectionHeading>Metric Trends{season ? ` — ${season.label}` : ''}</SectionHeading>
        <Card>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {trends.map(t => (
              <div key={t.key} className="border rounded-lg p-3" style={{ borderColor: '#1e3a5f' }}>
                <p className="text-xs font-bold mb-1" style={{ color: text.body }}>{TREND_LABELS[t.key] || t.key}</p>
                <Sparkline series={t.series} />
                <p className="text-[10px] mt-1" style={{ color: text.faint }}>
                  {t.series[0].date} → {t.series[t.series.length - 1].date} · {t.series.length} dates
                </p>
              </div>
            ))}
          </div>
        </Card>
        </section>
      )}

      <section>
      <SectionHeading>Roster & Schedule</SectionHeading>
      <div className="grid lg:grid-cols-2 gap-3 items-start">
        <Card title={context ? `Event roster — ${context.tournament}` : 'Roster'}>
          {roster.length === 0 ? (
            <p className="text-xs" style={{ color: text.faint }}>No roster members{context ? ' on this event roster' : ''} yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider border-b" style={{ color: text.faint, ...headBorder }}>
                  <th className="py-1.5 pr-2 font-bold">Player</th><th className="py-1.5 pr-2 font-bold">#</th>
                  <th className="py-1.5 pr-2 font-bold">Class</th><th className="py-1.5 font-bold">Profile</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r, i) => (
                  <tr key={i} className="border-b" style={rowBorder}>
                    <td className="py-1.5 pr-2 font-bold text-white">
                      {r.first_name} {r.last_name}
                      {r.isGuest && <GuestBadge />}
                    </td>
                    <td className="py-1.5 pr-2" style={{ color: text.body }}>{r.jersey}</td>
                    <td className="py-1.5 pr-2" style={{ color: text.secondary }}>{r.grad_year || '—'}</td>
                    <td className="py-1.5">
                      {r.public_slug
                        ? <Link to={`/p/${r.public_slug}`} className="hover:underline" style={{ color: text.accent }}>View</Link>
                        : <span className="text-xs" style={{ color: '#475569' }}>Private</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title={season ? `Events — ${season.label}` : 'Events'}>
            {seasonEvents.length === 0 ? (
              <p className="text-xs" style={{ color: text.faint }}>No tournaments in this scope.</p>
            ) : seasonEvents.map((e, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b last:border-0" style={rowBorder}>
                <div>
                  <button
                    onClick={() => setFilter('tournament', e.tournament_slug)}
                    className="text-sm font-bold text-white hover:text-[#38bdf8] cursor-pointer text-left"
                  >
                    {e.tournament_name}
                  </button>
                  <p className="text-xs" style={{ color: text.secondary }}>{e.division_name} · {e.start_date}</p>
                </div>
                <div className="text-right text-xs" style={{ color: text.secondary }}>
                  {e.placement && <p className="font-bold" style={{ color: '#fbbf24' }}><Trophy size={11} className="inline mr-1" />{e.placement}</p>}
                  {(e.wins != null || e.losses != null) && <p>{e.wins ?? 0}–{e.losses ?? 0}</p>}
                </div>
              </div>
            ))}
          </Card>

          <Card title={context ? `Games — ${context.tournament}` : 'Games'}>
            {games.length === 0 ? (
              <p className="text-xs" style={{ color: text.faint }}>No games in this scope.</p>
            ) : games.slice(0, 14).map(g => {
              const scored = g.status === 'final' && g.home_score != null;
              const tied = scored && g.home_score === g.away_score;
              const won = scored && !tied && (g.is_home ? g.home_score > g.away_score : g.away_score > g.home_score);
              return (
                <div key={g.id} className="flex items-center gap-2 py-1.5 text-sm border-b last:border-0" style={rowBorder}>
                  <CalendarDays size={12} className="shrink-0" style={{ color: '#475569' }} />
                  <span className="text-xs w-20 shrink-0" style={{ color: text.faint }}>{g.date}</span>
                  <span className="flex-1 min-w-0 truncate" style={{ color: text.body }}>
                    {g.home_team_name} {g.home_score != null ? g.home_score : ''} – {g.away_score != null ? g.away_score : ''} {g.away_team_name}
                  </span>
                  {g.status === 'final'
                    ? <span className="text-[10px] font-bold" style={{ color: won ? text.good : tied ? text.secondary : text.bad }}>{won ? 'W' : tied ? 'T' : 'L'}</span>
                    : <span className="text-[10px] uppercase" style={{ color: '#475569' }}>{g.status}</span>}
                </div>
              );
            })}
          </Card>
        </div>
      </div>
      </section>
    </>
  );
}
