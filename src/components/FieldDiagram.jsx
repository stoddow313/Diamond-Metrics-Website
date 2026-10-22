import { useRef, useState } from 'react';
import { sprayZone, ZONE_COLOR, ZONE_LABEL } from '../lib/spray';

// A baseball field drawn in spray units (src/lib/spray.js) scaled by 100:
// home plate at the origin, the fence 100 out, foul poles at ±45°. Shared by
// the scorebook's landing-spot picker and the profile's spray chart.
const S = 100;
const at = (deg, r) => [Math.sin(deg * Math.PI / 180) * r * S, -Math.cos(deg * Math.PI / 180) * r * S];
const p = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const VIEW = { x: -112, y: -110, w: 224, h: 126 };
const sector = (from, to, r = 1) => `M 0 0 L ${p(at(from, r))} A ${r * S} ${r * S} 0 0 1 ${p(at(to, r))} Z`;

export function FieldBackdrop({ guides = true, children }) {
  const base = 0.27;
  const bases = [at(45, base), at(0, base * Math.SQRT2), at(-45, base)];
  return (
    <>
      <rect x={VIEW.x} y={VIEW.y} width={VIEW.w} height={VIEW.h} rx="8" fill="#0b1f17" />
      <path d={sector(-45, 45)} fill="#123d27" stroke="#4ade80" strokeOpacity="0.45" strokeWidth="1.2" />
      <path d={sector(-45, 45, 0.5)} fill="#6b4f33" fillOpacity="0.55" />
      <path d={`M 0 0 L ${p(bases[0])} L ${p(bases[1])} L ${p(bases[2])} Z`} fill="#123d27" />
      <circle cx="0" cy="0" r="7" fill="#6b4f33" fillOpacity="0.7" />
      <circle cx={at(0, 0.19)[0]} cy={at(0, 0.19)[1]} r="3" fill="#6b4f33" />
      {guides && [-15, 15].map(d => {
        const [x1, y1] = at(d, 0.32), [x2, y2] = at(d, 1);
        return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#cbd5e1" strokeOpacity="0.3" strokeWidth="0.8" strokeDasharray="3 3" />;
      })}
      {[-45, 45].map(d => { const [x, y] = at(d, 1.04); return <line key={d} x1="0" y1="0" x2={x} y2={y} stroke="#e2e8f0" strokeOpacity="0.75" strokeWidth="0.9" />; })}
      {bases.map(([x, y], i) => <rect key={i} x={x - 2.2} y={y - 2.2} width="4.4" height="4.4" fill="#f8fafc" transform={`rotate(45 ${x} ${y})`} />)}
      <path d="M -2.6 -1 L 2.6 -1 L 2.6 1.2 L 0 3 L -2.6 1.2 Z" fill="#f8fafc" />
      {children}
    </>
  );
}

export function FieldSvg({ children, className = '', style, guides, ...rest }) {
  return (
    <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} className={`block w-full ${className}`} style={style} {...rest}>
      <FieldBackdrop guides={guides}>{children}</FieldBackdrop>
    </svg>
  );
}

export function SpotDot({ spot, zone, r = 3.6, opacity = 0.95 }) {
  return <circle cx={spot.x * S} cy={-spot.y * S} r={r} fill={ZONE_COLOR[zone]} fillOpacity={opacity} stroke="#06122b" strokeWidth="0.9" />;
}

// Legacy shares (no landing spots on record): the three zones shaded by share, no dots.
export function ZoneWedges({ pct, side = 'R' }) {
  const left = side === 'L' ? 'oppo' : 'pull', right = side === 'L' ? 'pull' : 'oppo';
  return [[left, -45, -15], ['middle', -15, 15], [right, 15, 45]].map(([z, from, to]) => {
    const [tx, ty] = at((from + to) / 2, 0.72);
    return (
      <g key={z}>
        <path d={sector(from, to)} fill={ZONE_COLOR[z]} fillOpacity={0.12 + 0.5 * (pct[z] || 0) / 100} />
        <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="800" fill="#f8fafc">{Math.round(pct[z] || 0)}%</text>
      </g>
    );
  });
}

// The scorebook's landing-spot picker: tap where the ball landed. `side` is
// stored only when the scorer overrides the roster (a switch hitter's side,
// or a batter whose roster entry has none).
export function FieldSpot({ value, onChange, rosterSide = 'R', testId = 'field-spot' }) {
  const svgRef = useRef(null);
  const [pending, setPending] = useState(null);   // a side picked before the dot is placed
  const side = value?.side || pending || rosterSide;
  const zone = value ? sprayZone(value, side) : null;
  const withSide = (spot, s) => {
    const { side: _old, ...rest } = spot;
    return s === rosterSide ? rest : { ...rest, side: s };
  };
  const place = e => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const spot = { x: Math.round(clamp(x / S, -2, 2) * 1000) / 1000, y: Math.round(clamp(-y / S, -0.5, 2) * 1000) / 1000 };
    onChange(withSide(spot, side));
  };
  const pickSide = s => { if (value) onChange(withSide(value, s)); else setPending(s === rosterSide ? null : s); };
  return (
    <div className="w-full max-w-[300px]" data-testid={testId}>
      <svg ref={svgRef} viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} className="block w-full cursor-crosshair touch-none select-none rounded-lg"
        onPointerDown={place} role="img" aria-label={zone ? `Landing spot: ${ZONE_LABEL[zone]}` : 'Tap where the ball landed'}>
        <FieldBackdrop>{value && <SpotDot spot={value} zone={zone} r={4.2} />}</FieldBackdrop>
      </svg>
      <div className="flex items-center gap-2 mt-1.5 text-[11px] font-bold">
        {zone
          ? <span className="px-2 py-0.5 rounded-full" style={{ backgroundColor: ZONE_COLOR[zone], color: '#06122b' }} data-testid={`${testId}-zone`}>{ZONE_LABEL[zone]}</span>
          : <span style={{ color: '#64748b' }}>Tap the landing spot</span>}
        {value && <button type="button" onClick={() => onChange(null)} className="cursor-pointer" style={{ color: '#94a3b8' }} title="Remove the landing spot">clear</button>}
        <span className="ml-auto flex rounded-md overflow-hidden border" style={{ borderColor: '#334155' }} title="The side the batter hit from">
          {['L', 'R'].map(s => (
            <button key={s} type="button" onClick={() => pickSide(s)} className="px-2 py-0.5 cursor-pointer" data-testid={`${testId}-side-${s}`}
              style={side === s ? { backgroundColor: '#38bdf8', color: '#06122b' } : { color: '#94a3b8' }}>{s}</button>
          ))}
        </span>
      </div>
    </div>
  );
}
