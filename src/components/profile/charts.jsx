// Lightweight pure-SVG chart primitives for the public player profile.
// All charts are deterministic (no Math.random at render) so profiles are stable.

import { FieldSvg, SpotDot, ZoneWedges } from '../FieldDiagram';
import { ZONES, ZONE_COLOR, ZONE_LABEL, zoneShares } from '../../lib/spray';

const BLUE = '#38bdf8';
const LIGHT_BLUE = '#60a5fa';
const GRID = 'rgba(148, 163, 184, 0.18)';
const MUTED = '#94a3b8';

function monthLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
}

// ── Trend line chart with end-value badge (mockup: "Exit Velocity Over Time") ──
export function TrendChart({ series, decimals = 1, height = 130, color = BLUE }) {
  const w = 320, h = height;
  const padL = 34, padR = 44, padT = 18, padB = 20;
  if (!series || series.length === 0) return null;

  const values = series.map(s => s.value);
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.15; max += span * 0.15;

  const x = i => series.length === 1
    ? (padL + (w - padL - padR) / 2)
    : padL + (i / (series.length - 1)) * (w - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  const gradId = `tg-${Math.round(values[0] * 100)}-${values.length}-${Math.round(lastY)}`;

  // Up to 4 y-axis ticks
  const ticks = [min + (max - min) * 0.1, min + (max - min) * 0.5, min + (max - min) * 0.9];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 170 }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
          <text x={padL - 5} y={y(t) + 3} textAnchor="end" fontSize="8" fill={MUTED}>{t.toFixed(decimals > 1 ? 1 : decimals)}</text>
        </g>
      ))}
      {series.length > 1 && (
        <path d={`M ${pts.join(' L ')} L ${lastX},${h - padB} L ${x(0)},${h - padB} Z`} fill={`url(#${gradId})`} />
      )}
      {series.length > 1 && (
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}
      <circle cx={lastX} cy={lastY} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />
      {/* end-value badge */}
      <g>
        <rect x={Math.min(lastX + 6, w - 42)} y={Math.max(lastY - 20, 2)} rx="4" width="38" height="15" fill={color} />
        <text x={Math.min(lastX + 6, w - 42) + 19} y={Math.max(lastY - 20, 2) + 10.5} textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff">
          {values[values.length - 1].toFixed(decimals)}
        </text>
      </g>
      {/* x labels: first + last month */}
      <text x={x(0)} y={h - 6} textAnchor="start" fontSize="8" fill={MUTED}>{monthLabel(series[0].date)}</text>
      {series.length > 1 && (
        <text x={lastX} y={h - 6} textAnchor="end" fontSize="8" fill={MUTED}>{monthLabel(series[series.length - 1].date)}</text>
      )}
    </svg>
  );
}

// ── Histogram (mockup: "Exit Velocity Distribution") ─────────────────────
export function Histogram({ buckets, height = 130 }) {
  // buckets: [{ label, count }]
  const w = 320, h = height;
  const padL = 10, padR = 10, padT = 22, padB = 26;
  const total = buckets.reduce((a, b) => a + b.count, 0);
  if (total === 0) return null;
  const maxCount = Math.max(...buckets.map(b => b.count));
  const bw = (w - padL - padR) / buckets.length;
  const modal = buckets.findIndex(b => b.count === maxCount);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 170 }}>
      {buckets.map((b, i) => {
        const pct = Math.round((b.count / total) * 100);
        const bh = maxCount ? (b.count / maxCount) * (h - padT - padB) : 0;
        const bx = padL + i * bw + bw * 0.18;
        const by = h - padB - bh;
        return (
          <g key={b.label}>
            <rect x={bx} y={by} width={bw * 0.64} height={Math.max(bh, b.count ? 2 : 0)} rx="3"
              fill={i === modal ? '#ef4444' : BLUE} opacity={b.count ? 1 : 0.15} />
            {b.count > 0 && (
              <text x={bx + bw * 0.32} y={by - 5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#f8fafc">{pct}%</text>
            )}
            <text x={padL + i * bw + bw / 2} y={h - 12} textAnchor="middle" fontSize="8" fill={MUTED}>{b.label}</text>
          </g>
        );
      })}
      <text x={w / 2} y={h - 2} textAnchor="middle" fontSize="7.5" fill={MUTED} letterSpacing="0.08em">EXIT VELO (MPH)</text>
    </svg>
  );
}

// ── Donut breakdown (mockup: "Launch Angle Breakdown") ───────────────────
export function DonutChart({ segments, centerTop, centerBottom, size = 130 }) {
  // segments: [{ label, pct, color }] — pct 0-100, sum ≈ 100
  const r = 42, cx = 60, cy = 60, sw = 16;
  const c = 2 * Math.PI * r;
  const visible = segments.filter(s => s.pct > 0);
  // Precompute each segment's arc length and start offset around the ring.
  const arcs = [];
  visible.reduce((offset, s) => {
    const dash = (s.pct / 100) * c;
    arcs.push({ ...s, dash, offset });
    return offset + dash;
  }, 0);

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
      <svg width={size} height={size} viewBox="0 0 120 120" className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRID} strokeWidth={sw} />
        {arcs.map(s => (
          <circle key={s.label} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={sw}
            strokeDasharray={`${s.dash} ${c - s.dash}`} strokeDashoffset={-s.offset}
            transform="rotate(-90 60 60)" />
        ))}
        <text x={cx} y={cy - 3} textAnchor="middle" fontSize="10" fill={MUTED} fontWeight="600">{centerTop}</text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="15" fontWeight="800" fill="#f8fafc">{centerBottom}</text>
      </svg>
      <div className="flex flex-col gap-1.5 text-xs">
        {segments.map(s => (
          <div key={s.label} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            <span className="w-16" style={{ color: '#94a3b8' }}>{s.label}</span>
            <span className="font-bold" style={{ color: '#f8fafc' }}>{Math.round(s.pct)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Attribute ring gauge (mockup: "Player Attributes") ───────────────────
export function RingGauge({ label, value }) {
  const r = 24, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="60" height="60" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r={r} fill="none" stroke={GRID} strokeWidth="5" />
        <circle cx="30" cy="30" r={r} fill="none" stroke={BLUE} strokeWidth="5"
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 30 30)" />
        <text x="30" y="35" textAnchor="middle" fontSize="15" fontWeight="800" fill="#f8fafc">{value ?? '—'}</text>
      </svg>
      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
    </div>
  );
}

// ── Spray chart: where each batted ball landed ───────────────────────────
// Dots are the landing spots placed in the scorebook, coloured by zone (pull /
// middle / oppo for the side the batter hit from). Shares recorded before
// landing spots existed shade the three zones instead — never invented dots.
export function SprayChart({ balls = [], pullPct, middlePct, oppoPct, count, bats }) {
  const placed = balls.length > 0;
  const shares = placed ? zoneShares(balls) : null;
  const pct = placed ? shares.pct : { pull: pullPct || 0, middle: middlePct || 0, oppo: oppoPct || 0 };
  const n = placed ? shares.n : count;
  if (!placed && !(pct.pull + pct.middle + pct.oppo)) return null;
  // Shading follows the roster's side. The field's PULL / OPPO words follow
  // the side the dots were hit from, and drop out when a switch hitter's
  // dots mix both sides.
  const rosterBats = String(bats || '').toUpperCase();
  const side = rosterBats === 'L' ? 'L' : 'R';
  const sides = new Set(balls.map(b => b.bats));
  const labelSide = placed ? (sides.size === 1 ? [...sides][0] : null) : (['L', 'R'].includes(rosterBats) ? rosterBats : null);
  return (
    <div className="w-full">
      <FieldSvg style={{ maxHeight: 170 }} className="mx-auto" guides={placed} side={labelSide}>
        {placed
          ? balls.map((b, i) => <SpotDot key={i} spot={b} zone={b.zone} r={3.4} opacity={0.9} />)
          : <ZoneWedges pct={pct} side={side} />}
      </FieldSvg>
      {/* Each zone: its share as a bar, the percentage and (from landing spots) the ball count. */}
      <div className="w-full mt-3 flex flex-col gap-1.5" data-testid="spray-zones">
        {ZONES.map(z => (
          <div key={z} className="flex items-center gap-2 text-[11px] font-bold">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ZONE_COLOR[z] }} />
            <span className="w-12 shrink-0" style={{ color: MUTED }}>{ZONE_LABEL[z]}</span>
            <span className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: GRID }}>
              <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct[z]))}%`, backgroundColor: ZONE_COLOR[z] }} />
            </span>
            <span className="w-9 text-right tabular-nums text-white">{Math.round(pct[z])}%</span>
            {placed && <span className="w-12 text-right tabular-nums" style={{ color: '#64748b' }}>{shares.counts[z]} {shares.counts[z] === 1 ? 'ball' : 'balls'}</span>}
          </div>
        ))}
        {n > 0 && <p className="text-[10px] font-bold uppercase tracking-wider text-right mt-0.5" style={{ color: '#64748b' }}>{n} charted</p>}
      </div>
    </div>
  );
}
