import { useEffect, useRef, useState } from 'react';
import { X, Download, Star } from 'lucide-react';

// Two-sided Pro Day player card (video-game style), rendered in a modal on
// the public profile and exportable as a single PNG for sharing.
// The card is deliberately fixed-size and always dark — it's a collectible,
// not a responsive page; small screens scale it down with a transform.

const CARD_W = 360;
const ACCENT = '#4da3ff';
const GOLD = '#fbbf24';
const cardShell = {
  width: CARD_W,
  borderRadius: 18,
  padding: 18,
  color: '#fff',
  background: 'linear-gradient(160deg, #0e2044 0%, #081226 55%, #060d1d 100%)',
  border: '1px solid #2b4a7a',
  boxShadow: '0 0 0 1px rgba(77,163,255,0.15), 0 18px 50px rgba(0,0,0,0.55)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  display: 'flex',
  flexDirection: 'column',
};
const label9 = { fontSize: 8, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#7d92b8' };

function fmtVal(v, decimals) {
  return Number(v).toFixed(decimals);
}

function BrandMini() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg width="20" height="20" viewBox="0 0 120 120">
        <path d="M60 10 C82 10, 100 20, 110 36 L90 56 L60 88 L30 56 L10 36 C20 20, 38 10, 60 10 Z" fill="none" stroke={ACCENT} strokeWidth="7" />
        <polygon points="60,34 82,56 60,78 38,56" fill="none" stroke={ACCENT} strokeWidth="6" />
      </svg>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.14em' }}>DIAMOND<span style={{ color: ACCENT }}> METRICS</span></span>
    </div>
  );
}

function Stars({ rating }) {
  if (rating == null) return null;
  const n = Math.round(rating / 20);
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={13} fill={i <= n ? GOLD : 'none'} stroke={GOLD} />
      ))}
    </div>
  );
}

function MiniRing({ label, value }) {
  const r = 17, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#1b2c4f" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={ACCENT} strokeWidth="4"
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 22 22)" />
        <text x="22" y="26" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">{value ?? '—'}</text>
      </svg>
      <span style={{ ...label9, fontSize: 7 }}>{label}</span>
    </div>
  );
}

const ATTRS = ['power', 'contact', 'speed', 'arm', 'defense', 'athleticism'];

export function CardFront({ data }) {
  const { player, chips, event } = data;
  const classYear = player.grad_year;
  return (
    <div style={cardShell}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <BrandMini />
        {classYear && (
          <div style={{ border: `1px solid ${ACCENT}`, borderRadius: 8, padding: '3px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1 }}>{classYear}</div>
            <div style={{ ...label9, color: ACCENT, fontSize: 7 }}>Class</div>
          </div>
        )}
      </div>

      {/* rating + photo */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <div style={{ width: 108, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div style={{ fontSize: 46, fontWeight: 900, lineHeight: 0.95 }}>{player.overall_rating ?? '—'}</div>
            <div style={{ ...label9, color: ACCENT }}>Overall</div>
          </div>
          <Stars rating={player.overall_rating} />
          {player.college_projection && (
            <div>
              <div style={label9}>College Projection</div>
              <div style={{ fontSize: 11, fontWeight: 800, color: GOLD, textTransform: 'uppercase' }}>{player.college_projection}</div>
            </div>
          )}
          {player.committed_to && (
            <div>
              <div style={label9}>Committed to</div>
              <div style={{ fontSize: 11, fontWeight: 800 }}>{player.committed_to}</div>
            </div>
          )}
        </div>
        <div style={{
          flex: 1, borderRadius: 12, minHeight: 170, position: 'relative', overflow: 'hidden',
          background: player.photo_url
            ? `url(${player.photo_url}) center/cover`
            : 'radial-gradient(circle at 50% 35%, #16305e 0%, #0a1730 75%)',
          border: '1px solid #1e3a5f',
        }}>
          {!player.photo_url && (
            <span style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 44, fontWeight: 900, color: '#1e3a5f',
            }}>
              {(player.first_name[0] || '') + (player.last_name[0] || '')}
            </span>
          )}
        </div>
      </div>

      {/* name */}
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1 }}>
          {player.first_name}
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.05, color: ACCENT }}>
          {player.last_name}
        </div>
      </div>

      {/* identity strip */}
      <div style={{
        display: 'flex', justifyContent: 'center', gap: 14, marginTop: 10, paddingTop: 8,
        borderTop: '1px solid #1b2c4f', textAlign: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800 }}>{player.primary_position}{player.secondary_position ? ` / ${player.secondary_position.split(',')[0].trim()}` : ''}</div>
          <div style={label9}>Positions</div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800 }}>{player.bats || '?'} / {player.throws || '?'}</div>
          <div style={label9}>Bats / Throws</div>
        </div>
        <div style={{ maxWidth: 130 }}>
          <div style={{ fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{player.school}</div>
          <div style={label9}>{[player.city, player.state].filter(Boolean).join(', ') || 'School'}</div>
        </div>
      </div>

      {/* headline chips from the pro day */}
      {chips.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: `repeat(${chips.length}, 1fr)`, gap: 6, marginTop: 10,
          backgroundColor: 'rgba(77,163,255,0.06)', border: '1px solid #1b2c4f', borderRadius: 10, padding: 8,
        }}>
          {chips.map(c => (
            <div key={c.key} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 900 }}>{fmtVal(c.value, c.decimals)}</div>
              <div style={{ ...label9, fontSize: 6.5 }}>{c.unit ? `${c.unit} · ` : ''}{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* attribute rings */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 2, marginTop: 10 }}>
        {ATTRS.map(a => <MiniRing key={a} label={a} value={player[`attr_${a}`]} />)}
      </div>

      <div style={{ textAlign: 'center', marginTop: 10, paddingTop: 6, borderTop: '1px solid #1b2c4f', ...label9, color: ACCENT }}>
        {event.name} · Diamond Metrics
      </div>
    </div>
  );
}

export function CardBack({ data, qrDataUrl, profileUrl }) {
  const { player, event, results, rankings, cardId, positionGroup } = data;
  const rankTiles = rankings
    ? [
        rankings.overall && { label: `Overall ${rankings.overall.group} Rank`, rank: rankings.overall.rank, of: rankings.overall.of },
        ...rankings.metrics.slice(0, 3).map(m => ({ label: `${m.label} Rank`, rank: m.rank, of: m.of })),
      ].filter(Boolean)
    : [];

  return (
    <div style={cardShell}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <BrandMini />
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 900, textTransform: 'uppercase' }}>
            {player.first_name} <span style={{ color: ACCENT }}>{player.last_name}</span>
          </div>
          <div style={{ ...label9, fontSize: 7 }}>{cardId} · {positionGroup}</div>
        </div>
      </div>

      {/* event snapshot */}
      <div style={{
        marginTop: 12, border: '1px solid #1b2c4f', borderRadius: 10, padding: '8px 10px',
        backgroundColor: 'rgba(77,163,255,0.06)',
      }}>
        <div style={{ ...label9, color: ACCENT, marginBottom: 4 }}>{event.name} Snapshot</div>
        <div style={{ display: 'flex', gap: 10, fontSize: 9.5, fontWeight: 700, color: '#cfe8ff', flexWrap: 'wrap' }}>
          <span>{new Date(event.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
          {event.location && <span>· {event.location}</span>}
          <span>· {cardId}</span>
        </div>
      </div>

      {/* event results */}
      <div style={{ marginTop: 10 }}>
        <div style={{ ...label9, color: ACCENT, marginBottom: 5 }}>Event Results</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
          {results.map(r => (
            <div key={r.key} style={{ border: '1px solid #1b2c4f', borderRadius: 8, padding: '6px 4px', textAlign: 'center', backgroundColor: 'rgba(10,20,40,0.6)' }}>
              <div style={{ ...label9, fontSize: 6.5, marginBottom: 2 }}>{r.label}</div>
              <div style={{ fontSize: 15, fontWeight: 900, lineHeight: 1 }}>
                {fmtVal(r.value, r.decimals)}
                {r.unit && <span style={{ fontSize: 8, fontWeight: 700, color: '#7d92b8' }}> {r.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* rankings */}
      {rankTiles.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...label9, color: ACCENT, marginBottom: 5 }}>
            Event Rankings · {rankings.participantCount} athletes
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rankTiles.length, 4)}, 1fr)`, gap: 5 }}>
            {rankTiles.map(t => (
              <div key={t.label} style={{ border: '1px solid #1b2c4f', borderRadius: 8, padding: '6px 4px', textAlign: 'center', backgroundColor: 'rgba(10,20,40,0.6)' }}>
                <div style={{ ...label9, fontSize: 6.5, marginBottom: 2 }}>{t.label}</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: GOLD }}>#{t.rank}</div>
                <div style={{ ...label9, fontSize: 6.5 }}>of {t.of}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QR */}
      <div style={{
        marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1b2c4f',
        borderRadius: 10, padding: 8, backgroundColor: 'rgba(255,255,255,0.03)',
      }}>
        {qrDataUrl
          ? <img src={qrDataUrl} alt="QR to full profile" width="52" height="52" style={{ borderRadius: 6, backgroundColor: '#fff' }} />
          : <div style={{ width: 52, height: 52, borderRadius: 6, backgroundColor: '#122448' }} />}
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Scan to view full profile</div>
          <div style={{ fontSize: 8.5, color: '#7d92b8', marginTop: 2 }}>{profileUrl.replace(/^https?:\/\//, '')}</div>
        </div>
      </div>
    </div>
  );
}

export default function ProDayCardModal({ data, onClose, autoDownload = false }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const frontRef = useRef(null);
  const backRef = useRef(null);
  const autoRan = useRef(false);

  const profileUrl = `${window.location.origin}/p/${data.player.slug}`;

  useEffect(() => {
    let alive = true;
    import('qrcode').then(QRCode =>
      QRCode.toDataURL(profileUrl, { margin: 1, width: 104, color: { dark: '#0a1424', light: '#ffffff' } })
    ).then(url => { if (alive) setQrDataUrl(url); }).catch(() => {});
    return () => { alive = false; };
  }, [profileUrl]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The card is styled entirely with inline styles, so it can be rasterized
  // without a DOM-to-image library: clone the node, inline any remote images
  // as data URIs (external fetches are blocked inside SVG-as-image), wrap the
  // markup in <svg><foreignObject>, and draw it onto a canvas.
  async function fetchAsDataUrl(url) {
    const blob = await (await fetch(url, { mode: 'cors' })).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function renderCardNode(node, scale = 3) {
    const rect = node.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    const clone = node.cloneNode(true);

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
    // No page stylesheets exist inside the SVG, so restore the box-sizing
    // reset the card's fixed width depends on.
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
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  async function download() {
    setDownloading(true);
    setError('');
    try {
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
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${data.player.slug}-pro-day-card.png`;
      a.click();
    } catch {
      setError('Could not render the image — a player photo hosted on another site may be blocking export. Try a photo URL that allows cross-origin use, or screenshot the card.');
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    if (autoDownload && qrDataUrl && !autoRan.current) {
      autoRan.current = true;
      download();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDownload, qrDataUrl]);

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(3, 8, 18, 0.82)', backdropFilter: 'blur(4px)', padding: 16, overflowY: 'auto',
      }}
    >
      <div style={{ maxWidth: 820, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <p style={{ color: '#fff', fontWeight: 800, fontSize: 16, margin: 0 }}>Pro Day Card</p>
            <p style={{ color: '#7d92b8', fontSize: 12, margin: 0 }}>{data.event.name} · {data.event.date}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={download}
              disabled={downloading}
              className="cursor-pointer"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, backgroundColor: '#2563eb', color: '#fff',
                border: 'none', borderRadius: 10, padding: '8px 14px', fontWeight: 700, fontSize: 13,
                opacity: downloading ? 0.6 : 1,
              }}
            >
              <Download size={14} /> {downloading ? 'Rendering…' : 'Download PNG'}
            </button>
            <button
              onClick={onClose}
              className="cursor-pointer"
              aria-label="Close"
              style={{ backgroundColor: 'rgba(255,255,255,0.08)', color: '#fff', border: 'none', borderRadius: 10, padding: '8px 10px' }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {error && <p style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
          <div ref={frontRef}><CardFront data={data} /></div>
          <div ref={backRef}><CardBack data={data} qrDataUrl={qrDataUrl} profileUrl={profileUrl} /></div>
        </div>
      </div>
    </div>
  );
}
