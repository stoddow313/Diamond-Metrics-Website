import { useEffect, useRef, useState } from 'react';
import { X, Download, Star, Share2 } from 'lucide-react';

// Two-sided collectible Pro Day card ("prestige" treatment): prismatic chrome
// frame, holographic foil ground, rating medallion, embossed nameplate.
// Opens front-first and flips on tap. Exports to PNG via a dependency-free
// SVG rasterizer, so every style below must be plain CSS paint (gradients,
// shadows) — no external assets, no filters.

const CARD_W = 360;
const CARD_H = 600;
const FRAME = 7;
const OUTER_W = CARD_W + FRAME * 2;
const OUTER_H = CARD_H + FRAME * 2;

const ACCENT = '#4da3ff';
const GOLD = '#fbbf24';

const CHROME = 'conic-gradient(from 210deg, #8fd0ff, #eef1ff, #b7a6ff, #ffd7f2, #9be1ff, #f3f6ff, #8fd0ff)';
const FOIL_BG = [
  'radial-gradient(120% 90% at 15% 8%, rgba(125,211,252,0.18) 0%, transparent 52%)',
  'radial-gradient(120% 90% at 88% 14%, rgba(196,181,253,0.16) 0%, transparent 55%)',
  'radial-gradient(110% 80% at 82% 92%, rgba(240,171,252,0.12) 0%, transparent 52%)',
  'radial-gradient(90% 70% at 10% 90%, rgba(103,232,249,0.10) 0%, transparent 50%)',
  'repeating-linear-gradient(115deg, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 2px, transparent 2px, transparent 7px)',
  'linear-gradient(160deg, #0e2044 0%, #081226 55%, #060d1d 100%)',
].join(', ');

const label9 = { fontSize: 8, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8fa5cd' };
const glassPanel = {
  backgroundColor: 'rgba(148, 197, 255, 0.07)',
  border: '1px solid rgba(148, 197, 255, 0.22)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
  borderRadius: 10,
};

function fmtVal(v, decimals) {
  return Number(v).toFixed(decimals);
}

// Prismatic chrome frame with the rarity gem set into the top edge.
function ChromeFrame({ children }) {
  return (
    <div style={{
      width: OUTER_W, height: OUTER_H, padding: FRAME, borderRadius: 26, position: 'relative',
      background: CHROME,
      boxShadow: '0 0 0 1px rgba(125,211,252,0.35), 0 24px 60px rgba(0,0,0,0.6), 0 0 34px rgba(77,163,255,0.28)',
    }}>
      {children}
      <div style={{
        position: 'absolute', top: -1, left: '50%', marginLeft: -17, width: 34, height: 20,
        borderRadius: '0 0 12px 12px', background: 'linear-gradient(180deg, #12264d, #081226)',
        border: '1px solid rgba(125,211,252,0.5)', borderTop: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="13" height="11" viewBox="0 0 24 20">
          <path d="M6 1 h12 l5 6 -11 12 L1 7 Z" fill="#38bdf8" stroke="#bfe6ff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

function Face({ children }) {
  return (
    <div style={{
      width: CARD_W, height: CARD_H, borderRadius: 20, padding: 16,
      color: '#fff', background: FOIL_BG,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      boxShadow: 'inset 0 0 0 1px rgba(148,197,255,0.18)',
    }}>
      {children}
    </div>
  );
}

function BrandMini() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg width="18" height="18" viewBox="0 0 120 120">
        <path d="M60 10 C82 10, 100 20, 110 36 L90 56 L60 88 L30 56 L10 36 C20 20, 38 10, 60 10 Z" fill="none" stroke={ACCENT} strokeWidth="7" />
        <polygon points="60,34 82,56 60,78 38,56" fill="none" stroke={ACCENT} strokeWidth="6" />
      </svg>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.16em' }}>DIAMOND<span style={{ color: ACCENT }}> METRICS</span></span>
    </div>
  );
}

function Stars({ rating, size = 12 }) {
  if (rating == null) return null;
  const n = Math.round(rating / 20);
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={size} fill={i <= n ? GOLD : 'none'} stroke={GOLD} />
      ))}
    </div>
  );
}

function Medallion({ rating }) {
  return (
    <div style={{
      width: 92, height: 92, borderRadius: '50%',
      background: 'radial-gradient(circle at 35% 28%, #1d3f7d 0%, #0a1730 70%)',
      border: '2px solid rgba(148,207,255,0.85)',
      boxShadow: '0 0 20px rgba(77,163,255,0.5), inset 0 2px 6px rgba(255,255,255,0.18), inset 0 -4px 10px rgba(0,0,0,0.45)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: 36, fontWeight: 900, lineHeight: 1, textShadow: '0 2px 8px rgba(77,163,255,0.6)' }}>{rating ?? '—'}</span>
      <span style={{ ...label9, fontSize: 7, color: ACCENT }}>Overall</span>
    </div>
  );
}

function MiniRing({ label, value }) {
  const r = 17, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div style={{ borderRadius: '50%', boxShadow: '0 0 10px rgba(77,163,255,0.35)' }}>
        <svg width="44" height="44" viewBox="0 0 44 44" style={{ display: 'block' }}>
          <circle cx="22" cy="22" r={r} fill="rgba(8,18,38,0.85)" stroke="#1b2c4f" strokeWidth="4" />
          <circle cx="22" cy="22" r={r} fill="none" stroke={ACCENT} strokeWidth="4"
            strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 22 22)" />
          <text x="22" y="26" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">{value ?? '—'}</text>
        </svg>
      </div>
      <span style={{ ...label9, fontSize: 6.5 }}>{label}</span>
    </div>
  );
}

const ATTRS = ['power', 'contact', 'speed', 'arm', 'defense', 'athleticism'];

const TIER_COLORS = {
  Diamond: '#7dd3fc', Gold: '#fbbf24', Silver: '#cbd5e1', Bronze: '#e8965a', Development: '#94a3b8',
};

const SKILL_LABELS = {
  power: 'Power', contact: 'Contact', speed: 'Speed', arm: 'Arm',
  defense: 'Defense', athleticism: 'Athleticism',
  pitch_velocity: 'Pitch Velo', command: 'Command', catching: 'Catching',
};

// Engine-calculated ratings when a Pro Day exists; legacy stored values otherwise.
function displayRatings(data) {
  const r = data.ratings || null;
  const overall = r?.overall?.value ?? data.player.overall_rating ?? null;
  const ring = a => r?.skills?.[a]?.rating ?? data.player[`attr_${a}`] ?? null;
  return { r, overall, ring };
}

export function CardFront({ data }) {
  const { player, chips, event } = data;
  const { r, overall, ring } = displayRatings(data);
  const metallicText = {
    background: 'linear-gradient(180deg, #f4f8ff 12%, #c3d2ec 42%, #8298bf 55%, #eef4ff 92%)',
    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  };
  return (
    <Face>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <BrandMini />
        {player.grad_year && (
          <div style={{ ...glassPanel, padding: '3px 9px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1 }}>{player.grad_year}</div>
            <div style={{ ...label9, color: ACCENT, fontSize: 6.5 }}>Class</div>
          </div>
        )}
      </div>

      {/* medallion column + photo */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, flex: 1, minHeight: 0 }}>
        <div style={{ width: 112, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
          <Medallion rating={overall} />
          <Stars rating={overall} />
          {r?.tier && (
            <div style={{ ...label9, fontSize: 8, color: TIER_COLORS[r.tier] || ACCENT, textShadow: `0 0 10px ${TIER_COLORS[r.tier] || ACCENT}55` }}>
              ◆ {r.tier} Tier
            </div>
          )}
          {player.college_projection && (
            <div style={{ textAlign: 'center' }}>
              <div style={label9}>College Projection</div>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: GOLD, textTransform: 'uppercase' }}>{player.college_projection}</div>
            </div>
          )}
          {player.committed_to && (
            <div style={{ textAlign: 'center' }}>
              <div style={label9}>Committed to</div>
              <div style={{ fontSize: 10.5, fontWeight: 800 }}>{player.committed_to}</div>
            </div>
          )}
        </div>
        <div style={{
          flex: 1, borderRadius: 14, position: 'relative', overflow: 'hidden',
          background: player.photo_url
            ? `url(${player.photo_url}) center/cover`
            : 'radial-gradient(circle at 50% 35%, #16305e 0%, #0a1730 75%)',
          border: '1px solid rgba(148,207,255,0.45)',
          boxShadow: '0 0 18px rgba(77,163,255,0.3), inset 0 0 24px rgba(77,163,255,0.12)',
        }}>
          {!player.photo_url && (
            <span style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 46, fontWeight: 900, color: '#1e3a5f',
            }}>
              {(player.first_name[0] || '') + (player.last_name[0] || '')}
            </span>
          )}
        </div>
      </div>

      {/* embossed nameplate */}
      <div style={{
        marginTop: 10, borderRadius: 12, padding: '7px 12px 9px', textAlign: 'center',
        background: 'linear-gradient(180deg, #33456b 0%, #16223e 60%, #0d1830 100%)',
        border: '1px solid rgba(148,207,255,0.55)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -2px 6px rgba(0,0,0,0.5), 0 3px 10px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#cfe0f8' }}>
          {player.first_name}
        </div>
        <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: '0.06em', textTransform: 'uppercase', lineHeight: 1.02, ...metallicText }}>
          {player.last_name}
        </div>
      </div>

      {/* identity strip */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 8, textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800 }}>{player.primary_position}{player.secondary_position ? ` / ${player.secondary_position.split(',')[0].trim()}` : ''}</div>
          <div style={{ ...label9, fontSize: 6.5 }}>Positions</div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800 }}>{player.bats || '?'} / {player.throws || '?'}</div>
          <div style={{ ...label9, fontSize: 6.5 }}>Bats / Throws</div>
        </div>
        <div style={{ maxWidth: 140 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{player.school}</div>
          <div style={{ ...label9, fontSize: 6.5 }}>{[player.city, player.state].filter(Boolean).join(', ') || 'School'}</div>
        </div>
      </div>

      {/* headline chips */}
      {chips.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${chips.length}, 1fr)`, gap: 6, marginTop: 9 }}>
          {chips.map(c => (
            <div key={c.key} style={{ ...glassPanel, padding: '6px 3px', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 900 }}>{fmtVal(c.value, c.decimals)}</div>
              <div style={{ ...label9, fontSize: 6 }}>{c.unit ? `${c.unit} · ` : ''}{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* attribute rings */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 2, marginTop: 9 }}>
        {ATTRS.map(a => <MiniRing key={a} label={a} value={ring(a)} />)}
      </div>

      <div style={{ textAlign: 'center', marginTop: 8, ...label9, color: ACCENT }}>
        {r ? `${r.label} · ` : ''}{event.name}
      </div>
    </Face>
  );
}

export function CardBack({ data, qrDataUrl, profileUrl }) {
  const { player, event, results, rankings, cardId, positionGroup } = data;
  const { r } = displayRatings(data);
  const rankTiles = rankings
    ? [
        rankings.overall && { label: `Overall ${rankings.overall.group} Rank`, rank: rankings.overall.rank, of: rankings.overall.of },
        ...rankings.metrics.slice(0, 3).map(m => ({ label: `${m.label} Rank`, rank: m.rank, of: m.of })),
      ].filter(Boolean)
    : [];

  return (
    <Face>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <BrandMini />
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 900, textTransform: 'uppercase' }}>
            {player.first_name} <span style={{ color: ACCENT }}>{player.last_name}</span>
          </div>
          <div style={{ ...label9, fontSize: 6.5 }}>{cardId} · {positionGroup}</div>
        </div>
      </div>

      <div style={{ ...glassPanel, marginTop: 12, padding: '8px 10px' }}>
        <div style={{ ...label9, color: ACCENT, marginBottom: 4 }}>{event.name} Snapshot</div>
        <div style={{ display: 'flex', gap: 10, fontSize: 9.5, fontWeight: 700, color: '#cfe8ff', flexWrap: 'wrap' }}>
          <span>{new Date(event.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
          {event.location && <span>· {event.location}</span>}
          <span>· {cardId}</span>
        </div>
        {r && (
          <div style={{ display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {r.archetype && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff' }}>{r.archetype}</span>}
            {r.tier && <span style={{ ...label9, fontSize: 7.5, color: TIER_COLORS[r.tier] || ACCENT }}>◆ {r.tier} Tier</span>}
            <span style={{ ...label9, fontSize: 7.5 }}>{r.label}</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ ...label9, color: ACCENT, marginBottom: 5 }}>Event Results</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
          {results.slice(0, 12).map(r => (
            <div key={r.key} style={{ ...glassPanel, padding: '6px 4px', textAlign: 'center' }}>
              <div style={{ ...label9, fontSize: 6, marginBottom: 2 }}>{r.label}</div>
              <div style={{ fontSize: 14.5, fontWeight: 900, lineHeight: 1 }}>
                {fmtVal(r.value, r.decimals)}
                {r.unit && <span style={{ fontSize: 8, fontWeight: 700, color: '#8fa5cd' }}> {r.unit}</span>}
              </div>
            </div>
          ))}
        </div>

        {rankTiles.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ ...label9, color: ACCENT, marginBottom: 5 }}>
              Event Rankings · {rankings.participantCount} athletes
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rankTiles.length, 4)}, 1fr)`, gap: 5 }}>
              {rankTiles.map(t => (
                <div key={t.label} style={{ ...glassPanel, padding: '6px 4px', textAlign: 'center' }}>
                  <div style={{ ...label9, fontSize: 6, marginBottom: 2 }}>{t.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: GOLD, textShadow: '0 0 12px rgba(251,191,36,0.45)' }}>#{t.rank}</div>
                  <div style={{ ...label9, fontSize: 6 }}>of {t.of}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* strengths / development areas from the rating engine */}
        {r && (r.strengths.length > 0 || r.developmentAreas.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 10 }}>
            <div style={{ ...glassPanel, padding: '6px 8px' }}>
              <div style={{ ...label9, fontSize: 6.5, color: '#4ade80', marginBottom: 3 }}>Strengths</div>
              {r.strengths.map(s => (
                <div key={s} style={{ fontSize: 10, fontWeight: 800, color: '#fff', lineHeight: 1.5 }}>
                  ⚡ {SKILL_LABELS[s] || s}{r.skills[s] ? ` · ${r.skills[s].rating}` : ''}
                </div>
              ))}
            </div>
            <div style={{ ...glassPanel, padding: '6px 8px' }}>
              <div style={{ ...label9, fontSize: 6.5, color: GOLD, marginBottom: 3 }}>Development Focus</div>
              {r.developmentAreas.length === 0
                ? <div style={{ fontSize: 10, color: '#8fa5cd' }}>—</div>
                : r.developmentAreas.map(s => (
                  <div key={s} style={{ fontSize: 10, fontWeight: 800, color: '#fff', lineHeight: 1.5 }}>
                    ◎ {SKILL_LABELS[s] || s}{r.skills[s] ? ` · ${r.skills[s].rating}` : ''}
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ ...glassPanel, display: 'flex', alignItems: 'center', gap: 10, padding: 8, marginTop: 10 }}>
        {qrDataUrl
          ? <img src={qrDataUrl} alt="QR to full profile" width="52" height="52" style={{ borderRadius: 6, backgroundColor: '#fff' }} />
          : <div style={{ width: 52, height: 52, borderRadius: 6, backgroundColor: '#122448' }} />}
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Scan to view full profile</div>
          <div style={{ fontSize: 8.5, color: '#8fa5cd', marginTop: 2 }}>{profileUrl.replace(/^https?:\/\//, '')}</div>
        </div>
      </div>
    </Face>
  );
}

export function ProDayCardShowcase({ data }) {
  const [flipped, setFlipped] = useState(false);
  const [scale, setScale] = useState(1);
  const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const profileUrl = `${window.location.origin}/p/${data.player.slug}`;

  useEffect(() => {
    const resize = () => setScale(Math.min(1, (window.innerWidth - 64) / OUTER_W));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  return (
    <div className="pro-day-showcase-card">
      <div style={{ width: OUTER_W * scale, height: OUTER_H * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: OUTER_W, height: OUTER_H }}>
          <button
            type="button"
            className="pro-day-card-button"
            onClick={() => setFlipped(value => !value)}
            aria-label={flipped ? 'Show Joe Larsen card front' : 'Show Joe Larsen card back'}
            style={{ width: OUTER_W, height: OUTER_H }}
          >
            <div style={{
              position: 'relative', width: '100%', height: '100%',
              transformStyle: 'preserve-3d',
              transition: reducedMotion ? 'none' : 'transform 0.65s cubic-bezier(0.35, 0.1, 0.3, 1)',
              transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            }}>
              <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
                <ChromeFrame><CardFront data={data} /></ChromeFrame>
              </div>
              <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                <ChromeFrame><CardBack data={data} profileUrl={profileUrl} /></ChromeFrame>
              </div>
            </div>
          </button>
        </div>
      </div>
      <p>Click the card to view the back</p>
    </div>
  );
}

export default function ProDayCardModal({ data, onClose, autoShare = false }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scale, setScale] = useState(1);
  const frontRef = useRef(null);
  const backRef = useRef(null);
  const autoRan = useRef(false);

  const profileUrl = `${window.location.origin}/p/${data.player.slug}`;
  const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    let alive = true;
    import('qrcode').then(QRCode =>
      QRCode.toDataURL(profileUrl, { margin: 1, width: 104, color: { dark: '#0a1424', light: '#ffffff' } })
    ).then(url => { if (alive) setQrDataUrl(url); }).catch(() => {});
    return () => { alive = false; };
  }, [profileUrl]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    function onResize() { setScale(Math.min(1, (window.innerWidth - 36) / OUTER_W)); }
    onResize();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [onClose]);

  // ── PNG export (dependency-free SVG rasterizer; card is inline-styled) ──
  async function fetchAsDataUrl(url) {
    const blob = await (await fetch(url, { mode: 'cors' })).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function renderCardNode(node, exportScale = 3) {
    // offsetWidth/Height ignore the flip/scale transforms applied on screen.
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const clone = node.cloneNode(true);
    clone.style.transform = 'none';
    clone.style.backfaceVisibility = 'visible';
    clone.style.position = 'static';

    for (const img of clone.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (src && !src.startsWith('data:')) img.setAttribute('src', await fetchAsDataUrl(src));
    }
    for (const el of clone.querySelectorAll('*')) {
      const bg = el.style?.backgroundImage || el.style?.background || '';
      const match = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (match) {
        const dataUrl = await fetchAsDataUrl(match[1]);
        el.style.background = bg.replace(match[1], dataUrl);
      }
    }

    const markup = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">` +
      `<style>*{box-sizing:border-box;margin:0;padding:0}</style>${markup}</div></foreignObject></svg>`;
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('SVG rasterization failed'));
      i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });

    const canvas = document.createElement('canvas');
    canvas.width = w * exportScale;
    canvas.height = h * exportScale;
    const ctx = canvas.getContext('2d');
    ctx.scale(exportScale, exportScale);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  async function composeCanvas() {
    const [front, back] = await Promise.all([
      renderCardNode(frontRef.current),
      renderCardNode(backRef.current),
    ]);
    const gap = 120, pad = 120;
    const h = Math.max(front.height, back.height);
    const canvas = document.createElement('canvas');
    canvas.width = front.width + back.width + gap + pad * 2;
    canvas.height = h + pad * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#060d1d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(front, pad, pad + (h - front.height) / 2);
    ctx.drawImage(back, pad + front.width + gap, pad + (h - back.height) / 2);
    return canvas;
  }

  function downloadCanvas(canvas) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${data.player.slug}-pro-day-card.png`;
    a.click();
  }

  async function share() {
    setBusy(true);
    setError('');
    try {
      const canvas = await composeCanvas();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const file = new File([blob], `${data.player.slug}-pro-day-card.png`, { type: 'image/png' });
      // Native share sheet (mobile) when the platform supports sharing files.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: `${data.player.first_name} ${data.player.last_name} — Pro Day Card`,
            text: `${data.event.name} · full profile: ${profileUrl}`,
          });
        } catch (err) {
          // AbortError = user closed the sheet; anything else, fall back to download.
          if (err?.name !== 'AbortError') downloadCanvas(canvas);
        }
      } else {
        downloadCanvas(canvas);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError('Could not render the image — a player photo hosted on another site may be blocking export.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setError('');
    try {
      downloadCanvas(await composeCanvas());
    } catch {
      setError('Could not render the image — a player photo hosted on another site may be blocking export.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoShare && qrDataUrl && !autoRan.current) {
      autoRan.current = true;
      share();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShare, qrDataUrl]);

  const btnStyle = {
    display: 'flex', alignItems: 'center', gap: 6, color: '#fff', border: 'none',
    borderRadius: 10, padding: '8px 13px', fontWeight: 700, fontSize: 13,
    opacity: busy ? 0.6 : 1,
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, display: 'flex',
        backgroundColor: 'rgba(3, 8, 18, 0.85)', backdropFilter: 'blur(4px)',
        overflowY: 'auto', padding: 16,
      }}
    >
      {/* margin auto = centered when it fits, scrollable when it doesn't */}
      <div style={{ margin: 'auto', width: '100%', maxWidth: 560 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#fff', fontWeight: 800, fontSize: 16, margin: 0 }}>Pro Day Card</p>
            <p style={{ color: '#7d92b8', fontSize: 12, margin: 0 }}>{data.event.name} · {data.event.date}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={share} disabled={busy} className="cursor-pointer" style={{ ...btnStyle, backgroundColor: '#2563eb' }}>
              <Share2 size={14} /> {busy ? 'Rendering…' : 'Share'}
            </button>
            <button onClick={download} disabled={busy} className="cursor-pointer" style={{ ...btnStyle, backgroundColor: 'rgba(255,255,255,0.1)' }}>
              <Download size={14} />
            </button>
            <button onClick={onClose} className="cursor-pointer" aria-label="Close" style={{ ...btnStyle, backgroundColor: 'rgba(255,255,255,0.1)', padding: '8px 10px' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {error && <p style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>{error}</p>}

        {/* flip stage — front first, tap to flip */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: OUTER_W * scale, height: OUTER_H * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: OUTER_W, height: OUTER_H }}>
              <div
                onClick={() => setFlipped(f => !f)}
                role="button"
                aria-label={flipped ? 'Show card front' : 'Show card back'}
                style={{ width: OUTER_W, height: OUTER_H, perspective: 1400, cursor: 'pointer' }}
              >
                <div style={{
                  position: 'relative', width: '100%', height: '100%',
                  transformStyle: 'preserve-3d',
                  transition: reducedMotion ? 'none' : 'transform 0.65s cubic-bezier(0.35, 0.1, 0.3, 1)',
                  transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                }}>
                  <div ref={frontRef} style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
                    <ChromeFrame><CardFront data={data} /></ChromeFrame>
                  </div>
                  <div ref={backRef} style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                    <ChromeFrame><CardBack data={data} qrDataUrl={qrDataUrl} profileUrl={profileUrl} /></ChromeFrame>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p style={{ color: '#7d92b8', fontSize: 11.5, fontWeight: 700, marginTop: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Tap card to flip
          </p>
        </div>
      </div>
    </div>
  );
}
