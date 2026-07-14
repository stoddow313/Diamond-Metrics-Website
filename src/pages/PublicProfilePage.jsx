import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Rocket, Zap, Flame, Target, Gauge, Timer, Activity, Dumbbell, Wind,
  Crosshair, Shield, TrendingUp, FileText, Share2, Mail, Bell,
  MoreHorizontal, Star, User, Play, Dna, ClipboardList,
} from 'lucide-react';
import { api } from '../lib/api';
import BrandMark from '../components/BrandMark';
import { TrendChart, Histogram, DonutChart, RingGauge, SprayChart } from '../components/profile/charts';

/* ── Metric presentation config ──────────────────────────────────────────── */

const METRIC_ICONS = {
  max_exit_velo: Rocket, avg_exit_velo: Zap, hard_hit_pct: Flame, contact_pct: Target,
  launch_angle: TrendingUp, sprint_speed: Gauge, dash_60: Timer, sprint_30: Timer,
  home_to_first: Timer, arm_strength: Dumbbell, max_velo: Rocket, avg_velo: Zap,
  strike_pct: Target, whiff_pct: Wind, command_score: Crosshair, pop_time: Timer,
  throw_accuracy: Target, blocking_score: Shield, reaction_time: Zap, range_score: Activity,
};

const ATTR_LABELS = {
  power: 'Power', contact: 'Contact', speed: 'Speed',
  arm: 'Arm', defense: 'Defense', athleticism: 'Athleticism',
};

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'summary', label: 'Game Summary' },
  { key: 'hitting', label: 'Hitting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'running', label: 'Running' },
  { key: 'defense', label: 'Defense' },
  { key: 'biomechanics', label: 'Biomechanics' },
  { key: 'development', label: 'Development' },
  { key: 'video', label: 'Video' },
  { key: 'reports', label: 'Reports' },
];

const VIDEO_CATEGORIES = ['Hitting', 'Pitching', 'Defense', 'Running', 'Showcase Highlights'];
const REPORT_TYPES = ['Hitting Report', 'Pitching Report', 'Athletic Testing Report', 'Showcase Report'];

function fmt(value, def) {
  if (value === null || value === undefined) return '—';
  let s = Number(value).toFixed(def.decimals);
  // Baseball convention: .412, not 0.412
  if (def.decimals === 3 && s.startsWith('0.')) s = s.slice(1);
  return s;
}

function typeLabel(t) {
  return (t || '').replace('_', ' ');
}

function niceDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── Shared building blocks ──────────────────────────────────────────────── */

function Card({ title, action, children, className = '' }) {
  return (
    <div className={`bg-white rounded-xl border border-slate-200 shadow-sm p-4 ${className}`}>
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

// Uniform-height chart panel so cards in the same grid row line up cleanly.
function ChartCard({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2 leading-snug">{title}</p>
      <div className="flex-1 min-h-[170px] flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

// Column counts chosen per metric count so rows always wrap balanced
// (3+3 on laptops, one row on wide screens) — never a lone orphan card.
const HERO_GRID_BY_COUNT = {
  1: 'grid-cols-1 max-w-xs',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
  5: 'grid-cols-2 md:grid-cols-3 2xl:grid-cols-5',
  6: 'grid-cols-2 md:grid-cols-3 2xl:grid-cols-6',
  7: 'grid-cols-2 md:grid-cols-4 2xl:grid-cols-7',
};

function MetricCardGrid({ metrics }) {
  const gridClass = HERO_GRID_BY_COUNT[metrics.length] || 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4';
  return (
    <div className={`grid gap-3 ${gridClass}`}>
      {metrics.map(m => <KeyMetricCard key={m.key} metric={m} />)}
    </div>
  );
}

function KeyMetricCard({ metric }) {
  const Icon = METRIC_ICONS[metric.key] || Activity;
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-2.5 flex items-center gap-2">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-50">
        <Icon size={16} className="text-blue-600" />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-extrabold text-slate-900 leading-none whitespace-nowrap">
          {fmt(metric.headline, metric)}
          {metric.unit && <span className="text-[9px] font-bold text-slate-400 ml-1">{metric.unit}</span>}
        </p>
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-1 leading-tight">{metric.label}</p>
      </div>
    </div>
  );
}

function EmptyPanel({ icon, title, note }) {
  const Icon = icon;
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
      <Icon size={28} className="mx-auto text-slate-300" />
      <p className="text-sm font-bold text-slate-700 mt-3">{title}</p>
      <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">{note}</p>
    </div>
  );
}

function RecentActivity({ games, onViewAll }) {
  const recent = [...games].reverse().slice(0, 5);
  return (
    <Card title="Recent Activity">
      {recent.length === 0 ? (
        <p className="text-xs text-slate-400">No events logged yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {recent.map(g => (
            <div key={g.id} className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center shrink-0 mt-0.5">
                <User size={12} className="text-slate-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{niceDate(g.game_date)}</p>
                <p className="text-xs font-bold text-slate-800 truncate">{g.opponent || typeLabel(g.game_type)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={onViewAll}
        className="w-full mt-4 py-2 rounded-lg border border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 cursor-pointer"
      >
        View All Activity
      </button>
    </Card>
  );
}

/* ── Chart data derivations ──────────────────────────────────────────────── */

function evDistributionBuckets(metrics) {
  // Distribution of per-game exit velo marks (avg entries preferred, else max).
  const src = metrics.avg_exit_velo?.series?.length ? metrics.avg_exit_velo : metrics.max_exit_velo;
  if (!src) return null;
  const defs = [
    { label: '< 70', test: v => v < 70 },
    { label: '70-80', test: v => v >= 70 && v < 80 },
    { label: '80-90', test: v => v >= 80 && v < 90 },
    { label: '90-100', test: v => v >= 90 && v < 100 },
    { label: '> 100', test: v => v >= 100 },
  ];
  return defs.map(d => ({ label: d.label, count: src.series.filter(s => d.test(s.value)).length }));
}

function launchAngleSegments(metrics) {
  const la = metrics.launch_angle;
  if (!la || !la.series.length) return null;
  const bands = [
    { label: '> 30°', color: '#ef4444', test: v => v > 30 },
    { label: '20° - 30°', color: '#f97316', test: v => v > 20 && v <= 30 },
    { label: '10° - 20°', color: '#fbbf24', test: v => v > 10 && v <= 20 },
    { label: '0° - 10°', color: '#2563eb', test: v => v >= 0 && v <= 10 },
    { label: '< 0°', color: '#1e3a5f', test: v => v < 0 },
  ];
  const n = la.series.length;
  return {
    avg: la.headline,
    segments: bands.map(b => ({ label: b.label, color: b.color, pct: (la.series.filter(s => b.test(s.value)).length / n) * 100 })),
  };
}

/* ── Tab bodies ──────────────────────────────────────────────────────────── */

function TrendCard({ metric }) {
  return (
    <ChartCard title={`${metric.label} Over Time`}>
      {metric.series.length > 1 ? (
        <TrendChart series={metric.series} decimals={metric.decimals} />
      ) : (
        <p className="text-xs text-slate-400 text-center px-4">
          One entry so far ({fmt(metric.headline, metric)}{metric.unit && ` ${metric.unit}`}) — trend appears after the next logged game.
        </p>
      )}
    </ChartCard>
  );
}

function GameLogTable({ games, metrics, categoryMetrics }) {
  // Per-game log for this category: only metrics that have at least one entry.
  const cols = categoryMetrics.filter(m => metrics[m.key]);
  if (!cols.length) return null;
  const valueByGameAndKey = {};
  for (const m of cols) {
    for (const pt of metrics[m.key].series) {
      valueByGameAndKey[`${pt.gameId}:${m.key}`] = pt.value;
    }
  }
  const rows = [...games].reverse().filter(g => cols.some(m => valueByGameAndKey[`${g.id}:${m.key}`] !== undefined));
  if (!rows.length) return null;

  return (
    <Card title="Game Log" className="overflow-x-auto">
      <table className="w-full text-xs min-w-[520px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
            <th className="py-2 pr-3 font-bold">Date</th>
            <th className="py-2 pr-3 font-bold">Event</th>
            {cols.map(m => <th key={m.key} className="py-2 pr-3 font-bold text-right">{m.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(g => (
            <tr key={g.id} className="border-b border-slate-50">
              <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{niceDate(g.game_date)}</td>
              <td className="py-2 pr-3 font-bold text-slate-700">{g.opponent || typeLabel(g.game_type)}</td>
              {cols.map(m => {
                const v = valueByGameAndKey[`${g.id}:${m.key}`];
                return <td key={m.key} className="py-2 pr-3 text-right font-bold text-slate-900">{v === undefined ? '—' : fmt(v, m)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CategoryTab({ categoryKey, data, extras = null }) {
  const { metrics, catalog, games } = data;
  const categoryMetrics = catalog.metrics.filter(m => m.category === categoryKey);
  const withData = categoryMetrics.filter(m => metrics[m.key]).map(m => metrics[m.key]);
  const missing = categoryMetrics.filter(m => !metrics[m.key]);

  if (!withData.length && !extras) {
    return (
      <EmptyPanel
        icon={Activity}
        title={`No ${categoryKey} data yet`}
        note={`${missing.map(m => m.label).join(', ')} will appear here once captured at a game or showcase.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {withData.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {withData.map(m => <KeyMetricCard key={m.key} metric={m} />)}
        </div>
      )}
      {extras}
      {withData.filter(m => m.series.length > 0).length > 0 && (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {withData.map(m => <TrendCard key={m.key} metric={m} />)}
        </div>
      )}
      <GameLogTable games={games} metrics={metrics} categoryMetrics={categoryMetrics} />
      {missing.length > 0 && (
        <p className="text-[11px] text-slate-400">
          Not yet captured: {missing.map(m => m.label).join(' · ')}
        </p>
      )}
    </div>
  );
}

function HittingExtras({ data }) {
  const { metrics, player } = data;
  const evBuckets = evDistributionBuckets(metrics);
  const la = launchAngleSegments(metrics);
  const hasSpray = metrics.pull_pct || metrics.middle_pct || metrics.oppo_pct;
  if (!evBuckets && !la && !hasSpray) return null;
  return (
    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {hasSpray && (
        <ChartCard title="Spray Chart">
          <SprayChart
            pullPct={metrics.pull_pct?.headline || 0}
            middlePct={metrics.middle_pct?.headline || 0}
            oppoPct={metrics.oppo_pct?.headline || 0}
            bats={player.bats}
          />
        </ChartCard>
      )}
      {evBuckets && (
        <ChartCard title="Exit Velocity Distribution">
          <Histogram buckets={evBuckets} />
        </ChartCard>
      )}
      {la && (
        <ChartCard title="Launch Angle Breakdown">
          <DonutChart segments={la.segments} centerTop="AVG" centerBottom={`${la.avg.toFixed(1)}°`} />
        </ChartCard>
      )}
    </div>
  );
}

function PitchingExtras() {
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <ChartCard title="Pitch Mix">
        <p className="text-xs text-slate-400 text-center px-4">Pitch-type tracking is coming soon — mix breakdown will appear here.</p>
      </ChartCard>
      <ChartCard title="Strike Zone Heat Map">
        <p className="text-xs text-slate-400 text-center px-4">Zone-level location data is coming soon — the heat map will appear here.</p>
      </ChartCard>
    </div>
  );
}

function OverviewTab({ data, heroMetrics, onViewAll }) {
  const { metrics, player, games } = data;
  const evBuckets = evDistributionBuckets(metrics);
  const la = launchAngleSegments(metrics);
  const hasSpray = metrics.pull_pct || metrics.middle_pct || metrics.oppo_pct;
  const evTrend = metrics.avg_exit_velo?.series?.length > 1 ? metrics.avg_exit_velo
    : metrics.max_exit_velo?.series?.length > 1 ? metrics.max_exit_velo
    : metrics.avg_velo?.series?.length > 1 ? metrics.avg_velo
    : metrics.max_velo?.series?.length > 1 ? metrics.max_velo : null;

  const attrs = Object.keys(ATTR_LABELS).map(a => ({ key: a, label: ATTR_LABELS[a], value: player[`attr_${a}`] }));
  const hasAttrs = attrs.some(a => a.value !== null && a.value !== undefined);

  // Analytics row (mockup row 2): spray / distribution / breakdown / trend.
  const analyticsCards = [];
  if (hasSpray) {
    analyticsCards.push({
      key: 'spray', title: 'Spray Chart',
      node: <SprayChart
        pullPct={metrics.pull_pct?.headline || 0}
        middlePct={metrics.middle_pct?.headline || 0}
        oppoPct={metrics.oppo_pct?.headline || 0}
        bats={player.bats}
      />,
    });
  }
  if (evBuckets) analyticsCards.push({ key: 'dist', title: 'Exit Velocity Distribution', node: <Histogram buckets={evBuckets} /> });
  if (la) analyticsCards.push({ key: 'la', title: 'Launch Angle Breakdown', node: <DonutChart segments={la.segments} centerTop="AVG" centerBottom={`${la.avg.toFixed(1)}°`} /> });
  if (evTrend) analyticsCards.push({ key: 'evtrend', title: `${evTrend.label} Over Time`, node: <TrendChart series={evTrend.series} decimals={evTrend.decimals} /> });

  // Trend row (mockup row 3): attributes + hero-metric trends, hero set first.
  const trendOrder = [...data.heroKeys, ...Object.keys(metrics)];
  const seen = new Set();
  const bottomTrends = trendOrder
    .filter(k => !seen.has(k) && seen.add(k))
    .map(k => metrics[k])
    .filter(m => m && m.series.length > 1 && m.key !== evTrend?.key && m.category !== 'box')
    .slice(0, hasAttrs ? 3 : 4);

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_230px] gap-4 items-start">
      <div className="flex flex-col gap-4 min-w-0">
        {heroMetrics.length > 0 ? (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">Key Metrics</p>
            <MetricCardGrid metrics={heroMetrics} />
          </div>
        ) : (
          <EmptyPanel icon={Activity} title="No stats logged yet" note="Key metrics appear here after this player's first logged event." />
        )}

        {analyticsCards.length > 0 && (
          <div className="grid sm:grid-cols-2 2xl:grid-cols-4 gap-4">
            {analyticsCards.map(c => <ChartCard key={c.key} title={c.title}>{c.node}</ChartCard>)}
          </div>
        )}

        {(hasAttrs || bottomTrends.length > 0) && (
          <div className="grid sm:grid-cols-2 2xl:grid-cols-4 gap-4">
            {hasAttrs && (
              <ChartCard title="Player Attributes">
                <div className="grid grid-cols-3 gap-x-3 gap-y-2 w-full place-items-center">
                  {attrs.map(a => <RingGauge key={a.key} label={a.label} value={a.value} />)}
                </div>
              </ChartCard>
            )}
            {bottomTrends.map(m => (
              <ChartCard key={m.key} title={`${m.label} Over Time`}>
                <TrendChart series={m.series} decimals={m.decimals} />
              </ChartCard>
            ))}
          </div>
        )}
      </div>

      <div className="xl:sticky xl:top-4 min-w-0">
        <RecentActivity games={games} onViewAll={onViewAll} />
      </div>
    </div>
  );
}

function GameSummaryTab({ data }) {
  const { metrics, games, catalog } = data;
  const boxMetrics = catalog.metrics.filter(m => m.category === 'box' && metrics[m.key]).map(m => metrics[m.key]);

  if (boxMetrics.length === 0) {
    return (
      <EmptyPanel
        icon={ClipboardList}
        title="No box scores logged yet"
        note="Game-by-game counting stats (plate appearances, hits, RBIs, innings pitched…) will appear here once logged."
      />
    );
  }

  const valueByGameAndKey = {};
  for (const m of boxMetrics) {
    for (const pt of m.series) valueByGameAndKey[`${pt.gameId}:${m.key}`] = pt.value;
  }
  const rows = [...games].reverse().filter(g => boxMetrics.some(m => valueByGameAndKey[`${g.id}:${m.key}`] !== undefined));

  return (
    <div className="flex flex-col gap-4">
      {/* Season totals */}
      <div>
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">
          Season Totals · {rows.length} game{rows.length === 1 ? '' : 's'}
        </p>
        <div className="grid gap-3 grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {boxMetrics.map(m => (
            <div key={m.key} className="bg-white rounded-xl border border-slate-200 shadow-sm p-2.5 text-center">
              <p className="text-lg font-extrabold text-slate-900 leading-none">{fmt(m.headline, m)}</p>
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-1 leading-tight" title={m.label}>{m.short}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Box score game log */}
      <Card title="Box Scores" className="overflow-x-auto">
        <table className="w-full text-xs" style={{ minWidth: 120 + boxMetrics.length * 44 }}>
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <th className="py-2 pr-3 font-bold">Date</th>
              <th className="py-2 pr-3 font-bold">Event</th>
              {boxMetrics.map(m => (
                <th key={m.key} className="py-2 px-1.5 font-bold text-right" title={m.label}>{m.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(g => (
              <tr key={g.id} className="border-b border-slate-50">
                <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{niceDate(g.game_date)}</td>
                <td className="py-2 pr-3 font-bold text-slate-700 whitespace-nowrap">{g.opponent || typeLabel(g.game_type)}</td>
                {boxMetrics.map(m => {
                  const v = valueByGameAndKey[`${g.id}:${m.key}`];
                  return (
                    <td key={m.key} className="py-2 px-1.5 text-right font-bold text-slate-900">
                      {v === undefined ? <span className="text-slate-300 font-normal">—</span> : fmt(v, m)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200">
              <td className="py-2 pr-3 text-[10px] font-bold uppercase tracking-wider text-slate-400" colSpan={2}>Totals</td>
              {boxMetrics.map(m => (
                <td key={m.key} className="py-2 px-1.5 text-right font-extrabold text-blue-700">{fmt(m.headline, m)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}

function DevelopmentTab({ games }) {
  const rows = [...games].reverse();
  if (!rows.length) {
    return <EmptyPanel icon={TrendingUp} title="No development log yet" note="Every logged game, practice, bullpen, and showcase will appear here as a training timeline." />;
  }
  return (
    <Card title="Development Timeline">
      <div className="flex flex-col">
        {rows.map((g, i) => (
          <div key={g.id} className={`flex items-start gap-3 py-3 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
            <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
              <Activity size={13} className="text-blue-600" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800">{g.opponent || typeLabel(g.game_type)}</p>
              <p className="text-[11px] text-slate-400">
                {niceDate(g.game_date)} · {typeLabel(g.game_type)}{g.location ? ` · ${g.location}` : ''}
              </p>
              {g.notes && <p className="text-xs text-slate-600 mt-1">{g.notes}</p>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function VideoTab() {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      {VIDEO_CATEGORIES.map(cat => (
        <Card key={cat} title={cat}>
          <div className="rounded-lg bg-slate-100 aspect-video flex flex-col items-center justify-center">
            <Play size={24} className="text-slate-300" />
            <p className="text-[11px] text-slate-400 mt-2">No videos uploaded yet</p>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ReportsTab({ playerName }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {REPORT_TYPES.map(r => (
        <Card key={r}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <FileText size={18} className="text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-800">{r}</p>
              <p className="text-[11px] text-slate-400">Compiled from {playerName}'s logged data — coming soon.</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function BiomechanicsTab() {
  return (
    <EmptyPanel
      icon={Dna}
      title="Biomechanics assessment coming soon"
      note="Motion-capture and biomechanical breakdowns will live here once this player completes a Diamond Metrics capture session."
    />
  );
}

/* ── Player card (dark sidebar) ──────────────────────────────────────────── */

function PlayerCard({ player }) {
  const stars = player.overall_rating != null ? Math.round(player.overall_rating / 20) : null;
  return (
    <aside className="rounded-2xl overflow-hidden text-white flex flex-col" style={{ background: 'linear-gradient(180deg, #0b1730 0%, #060e21 100%)' }}>
      {player.photo_url ? (
        <div className="h-44 lg:h-52 bg-cover bg-center" style={{ backgroundImage: `url(${player.photo_url})` }} />
      ) : (
        <div className="h-20 lg:h-28 flex items-center justify-center" style={{ background: 'radial-gradient(circle at 50% 30%, #12264d 0%, #0b1730 70%)' }}>
          <span className="text-3xl font-extrabold" style={{ color: '#1e3a5f' }}>
            {(player.first_name[0] || '') + (player.last_name[0] || '')}
          </span>
        </div>
      )}

      <div className="p-5 flex-1">
        <h1 className="text-2xl font-extrabold uppercase leading-tight">
          {player.first_name}<br /><span style={{ color: '#4da3ff' }}>{player.last_name}</span>
        </h1>
        <p className="text-sm font-bold mt-2" style={{ color: '#cfe8ff' }}>
          {player.primary_position}{player.secondary_position ? ` / ${player.secondary_position}` : ''}
        </p>
        <div className="mt-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: '#7d92b8' }}>
          {player.school && <p>{player.school}</p>}
          {(player.city || player.state) && <p className="mt-0.5">{[player.city, player.state].filter(Boolean).join(', ')}</p>}
          {player.grad_year && <p className="mt-0.5 text-white">Class of {player.grad_year}</p>}
        </div>

        <div className="flex gap-4 mt-4 pt-4 border-t" style={{ borderColor: '#1b2c4f' }}>
          {player.height && (
            <div>
              <p className="text-sm font-extrabold">{player.height}</p>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: '#7d92b8' }}>Height</p>
            </div>
          )}
          {player.weight_lbs && (
            <div>
              <p className="text-sm font-extrabold">{player.weight_lbs} lbs</p>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: '#7d92b8' }}>Weight</p>
            </div>
          )}
          {(player.bats || player.throws) && (
            <div>
              <p className="text-sm font-extrabold">{player.bats || '?'} / {player.throws || '?'}</p>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: '#7d92b8' }}>Bats/Throws</p>
            </div>
          )}
        </div>

        {player.committed_to && (
          <div className="flex items-center gap-2.5 mt-4 pt-4 border-t" style={{ borderColor: '#1b2c4f' }}>
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shrink-0">
              <span className="text-xs font-extrabold text-slate-900">{player.committed_to[0]}</span>
            </div>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: '#7d92b8' }}>Committed to</p>
              <p className="text-sm font-extrabold">{player.committed_to}</p>
            </div>
          </div>
        )}
      </div>

      {(player.overall_rating != null || player.college_projection) && (
        <div className="grid grid-cols-2 border-t" style={{ borderColor: '#1b2c4f', backgroundColor: 'rgba(0,0,0,0.25)' }}>
          {player.overall_rating != null && (
            <div className="p-4 text-center border-r" style={{ borderColor: '#1b2c4f' }}>
              <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7d92b8' }}>Overall Rating</p>
              <p className="text-4xl font-extrabold mt-1">{player.overall_rating}<span className="text-sm" style={{ color: '#7d92b8' }}>/100</span></p>
            </div>
          )}
          <div className="p-4 text-center flex flex-col items-center justify-center">
            {stars != null && (
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map(i => (
                  <Star key={i} size={14} fill={i <= stars ? '#fbbf24' : 'none'} stroke="#fbbf24" />
                ))}
              </div>
            )}
            {player.college_projection && (
              <>
                <p className="text-[9px] font-bold uppercase tracking-widest mt-2" style={{ color: '#7d92b8' }}>College Projection</p>
                <p className="text-xs font-extrabold uppercase mt-0.5" style={{ color: '#fbbf24' }}>{player.college_projection}</p>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function PublicProfilePage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return TABS.some(t => t.key === h) ? h : 'overview';
  });

  useEffect(() => {
    api.publicProfile(slug)
      .then(setData)
      .catch(err => setError(err.status === 404 ? 'Player profile not found.' : err.message));
  }, [slug]);

  function selectTab(key) {
    setTab(key);
    window.history.replaceState(null, '', `#${key}`);
  }

  const heroMetrics = useMemo(
    () => (data ? data.heroKeys.map(k => data.metrics[k]).filter(Boolean) : []),
    [data]
  );

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-100">
        <BrandMark />
        <p className="text-slate-700">{error}</p>
        <Link to="/" className="text-sm text-blue-600 hover:underline">Diamond Metrics home</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-100"><p className="text-slate-400">Loading profile…</p></div>;
  }

  const { player } = data;
  const playerName = `${player.first_name} ${player.last_name}`;
  const shareSubject = encodeURIComponent(`${playerName} — Diamond Metrics Player Profile`);
  const shareBody = encodeURIComponent(`Check out ${playerName}'s Diamond Metrics profile: ${window.location.origin}/p/${player.slug}`);

  return (
    <div className="min-h-screen pb-10" style={{ backgroundColor: '#eef2f7' }}>
      {/* Site header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
          <Link to="/" className="min-w-0"><BrandMark dark /></Link>
          <button
            onClick={copyLink}
            className="flex items-center gap-2 text-xs font-bold px-3.5 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Share2 size={13} /> {copied ? 'Link copied ✓' : 'Share profile'}
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-6 mt-5">
        <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] gap-4 items-start">
          <div className="lg:sticky lg:top-4 w-full max-w-md mx-auto lg:max-w-none">
            <PlayerCard player={player} />
          </div>

          <div className="min-w-0">
            {/* Tab bar */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm mb-4 flex items-center">
              <nav className="flex-1 min-w-0 flex overflow-x-auto no-scrollbar px-2">
                {TABS.map(t => (
                  <button
                    key={t.key}
                    onClick={() => selectTab(t.key)}
                    className={`px-3.5 py-3 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer border-b-2 transition-colors ${
                      tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
              <div className="hidden xl:flex items-center gap-1 px-2 border-l border-slate-100 text-slate-400 shrink-0 self-stretch">
                <a
                  href={`mailto:?subject=${shareSubject}&body=${shareBody}`}
                  className="p-1.5 rounded hover:bg-slate-100 hover:text-slate-600 self-center" title="Email this profile"
                >
                  <Mail size={15} />
                </a>
                <button onClick={copyLink} className="p-1.5 rounded hover:bg-slate-100 hover:text-slate-600 cursor-pointer self-center" title="Copy link">
                  <Bell size={15} />
                </button>
                <button className="p-1.5 rounded hover:bg-slate-100 hover:text-slate-600 cursor-pointer self-center" title="More">
                  <MoreHorizontal size={15} />
                </button>
              </div>
            </div>

            {/* Tab content */}
            {tab === 'overview' && <OverviewTab data={data} heroMetrics={heroMetrics} onViewAll={() => selectTab('development')} />}
            {tab === 'summary' && <GameSummaryTab data={data} />}
            {tab === 'hitting' && <CategoryTab categoryKey="hitting" data={data} extras={<HittingExtras data={data} />} />}
            {tab === 'pitching' && <CategoryTab categoryKey="pitching" data={data} extras={<PitchingExtras />} />}
            {tab === 'running' && <CategoryTab categoryKey="running" data={data} />}
            {tab === 'defense' && <CategoryTab categoryKey="defense" data={data} />}
            {tab === 'biomechanics' && <BiomechanicsTab />}
            {tab === 'development' && <DevelopmentTab games={data.games} />}
            {tab === 'video' && <VideoTab />}
            {tab === 'reports' && <ReportsTab playerName={playerName} />}
          </div>
        </div>
      </main>
    </div>
  );
}
