import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { fmt } from '../../lib/format';

// Shared pieces for the Team / Season / Tournament dashboards. All values
// arrive pre-aggregated from the API; null means unknown and renders as an
// em dash — never as a zero.

export function LimitedBadge() {
  return (
    <span className="ml-2 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 whitespace-nowrap">
      Limited sample
    </span>
  );
}

export function GuestBadge() {
  return (
    <span className="ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">Guest</span>
  );
}

export function PlayerLink({ slug, name }) {
  return slug
    ? <Link to={`/p/${slug}`} className="font-bold text-slate-800 hover:text-blue-600">{name}</Link>
    : <span className="font-bold text-slate-800">{name}</span>;
}

// Rank + player + team + position + value + sample — requirements §leaderboards.
export function LeaderboardTable({ board, showTeam = true }) {
  if (!board || !board.metric || board.rows.length === 0) {
    return <p className="text-xs text-slate-400">No data logged for this category yet.</p>;
  }
  const { metric } = board;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[460px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
            <th className="py-2 pr-2 font-bold w-8">#</th>
            <th className="py-2 pr-3 font-bold">Player</th>
            {showTeam && <th className="py-2 pr-3 font-bold">Team</th>}
            <th className="py-2 pr-3 font-bold">Pos</th>
            <th className="py-2 pr-3 font-bold text-right">{metric.label}</th>
            <th className="py-2 pr-3 font-bold text-right">Sample</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map(r => (
            <tr key={r.player_id} className="border-b border-slate-50">
              <td className="py-2 pr-2 text-slate-400 font-bold">{r.rank}</td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <PlayerLink slug={r.slug} name={r.name} />
                {r.isGuest && <GuestBadge />}
                {r.limited && <LimitedBadge />}
              </td>
              {showTeam && <td className="py-2 pr-3 text-slate-500">{r.team || '—'}</td>}
              <td className="py-2 pr-3 text-slate-500">{r.position || '—'}</td>
              <td className="py-2 pr-3 text-right font-bold text-slate-900">{fmt(r.value, metric)}</td>
              <td className="py-2 pr-3 text-right text-slate-400 text-xs">
                {r.sample}{board.category === 'hitting' ? ' PA' : board.category === 'pitching' && metric.key === 'k_bb_pitching' ? ' IP' : ' games'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-400 mt-2">
        Qualified at {board.min_sample}+ {board.category === 'hitting' ? 'PA' : board.category === 'pitching' && metric.key === 'k_bb_pitching' ? 'IP' : 'games'};
        smaller samples are shown but labeled.{board.note ? ` ${board.note}` : ''}
      </p>
    </div>
  );
}

// Mini collectible card for top performers — same prestige language as the
// Pro Day card (chrome edge, dark diamond face) at dashboard scale.
export function TopPerformerCard({ title, row }) {
  if (!row) return null;
  return (
    <div className="rounded-2xl p-[2px] shadow-md" style={{ background: 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 25%, #f8fafc 50%, #94a3b8 75%, #e2e8f0 100%)' }}>
      <div className="rounded-[14px] px-4 py-3 h-full" style={{ background: 'linear-gradient(160deg, #0b1f42 0%, #06122b 100%)' }}>
        <p className="text-[9px] font-bold uppercase tracking-[0.18em]" style={{ color: '#38bdf8' }}>{title}</p>
        <div className="flex items-baseline justify-between gap-3 mt-1">
          <div className="min-w-0">
            {row.slug
              ? <Link to={`/p/${row.slug}`} className="text-sm font-extrabold text-white truncate block hover:underline">{row.name}</Link>
              : <p className="text-sm font-extrabold text-white truncate">{row.name}</p>}
            <p className="text-[10px] truncate" style={{ color: '#9fc3ec' }}>
              {[row.team, row.position].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-black leading-none" style={{ color: '#f8fafc' }}>{fmt(row.value, row.metric)}</p>
            <p className="text-[9px] uppercase tracking-wide mt-0.5" style={{ color: '#64748b' }}>{row.metric.label}</p>
          </div>
        </div>
        <p className="text-[9px] mt-1" style={{ color: '#64748b' }}>
          {row.sample} {row.metric.key === 'ops' || row.metric.key === 'avg' ? 'PA' : 'games'}{row.limited ? ' · limited sample' : ''}
        </p>
      </div>
    </div>
  );
}

// Inline SVG sparkline for season trends. Lightweight on purpose — no
// charting dependency for a 5-point line.
export function Sparkline({ series, width = 220, height = 44, lowerIsBetter = false }) {
  if (!series || series.length < 2) return null;
  const values = series.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = series.map((p, i) => {
    const x = (i / (series.length - 1)) * (width - 8) + 4;
    const y = height - 6 - ((p.value - min) / span) * (height - 12);
    return `${x},${y}`;
  });
  const improving = lowerIsBetter ? values[values.length - 1] <= values[0] : values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} className="block" role="img" aria-label="trend">
      <polyline points={pts.join(' ')} fill="none" stroke={improving ? '#16a34a' : '#dc2626'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((pt, i) => {
        const [x, y] = pt.split(',');
        return <circle key={i} cx={x} cy={y} r="2.4" fill={improving ? '#16a34a' : '#dc2626'} />;
      })}
    </svg>
  );
}

export function CoverageNote({ children }) {
  return <p className="text-[11px] font-bold text-blue-700">{children}</p>;
}

export function CalcStamp({ calc }) {
  if (!calc) return null;
  return (
    <p className="text-[10px] text-slate-400">
      Calculated {new Date(calc.calculated_at).toLocaleString()} · {calc.version} · minimums: {calc.mins.pa} PA / {calc.mins.ip} IP / {calc.mins.samples} games
    </p>
  );
}

export function ChampionChip({ name }) {
  if (!name) return null;
  return (
    <span className="text-xs font-bold text-amber-600"><Trophy size={12} className="inline mr-1" />{name}</span>
  );
}
