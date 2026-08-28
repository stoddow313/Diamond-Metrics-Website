// Timecode formatting and seek parsing for the full-game video workspace.
// Pure and unit-tested: a wrong conversion sends an analyst to the wrong
// moment in a two-hour recording, and nothing about that looks like an error.

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00:00.00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  let s = Math.floor(seconds % 60);
  let cs = Math.round((seconds - Math.floor(seconds)) * 100);
  if (cs === 100) { cs = 0; s += 1; }        // carry, never print ".100"
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// Accepts "1:23:45.6", "23:45", "845.5" (seconds) or "#12345" (frame).
export function parseSeek(input, fps) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) {
    const f = Number(raw.slice(1));
    return Number.isFinite(f) && f >= 0 ? { frame: Math.floor(f) } : null;
  }
  if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length > 3 || parts.some(p => p === '' || !Number.isFinite(Number(p)) || Number(p) < 0)) return null;
    const secs = parts.map(Number).reduce((acc, p) => acc * 60 + p, 0);
    return { frame: Math.max(0, Math.floor(secs * fps)) };
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? { frame: Math.floor(n * fps) } : null;
}
