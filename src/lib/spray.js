// Spray geometry, the same as server/scorebook.js: home plate at (0,0),
// straightaway center up the y axis, 1 = the outfield fence. Middle is within
// 15° of center; the pull side is the batter's (left field for a righty).
export const ZONES = ['pull', 'middle', 'oppo'];
export const ZONE_LABEL = { pull: 'Pull', middle: 'Middle', oppo: 'Oppo' };
export const ZONE_COLOR = { pull: '#ef4444', middle: '#3b82f6', oppo: '#f59e0b' };

export function sprayAngle({ x, y }) { return Math.atan2(x, y) * 180 / Math.PI; }

export function sprayZone(spot, side) {
  const a = sprayAngle(spot);
  if (Math.abs(a) <= 15) return 'middle';
  return (a < 0) === (side !== 'L') ? 'pull' : 'oppo';
}

// The side a batter hits from by the roster: a switch hitter bats opposite
// the pitcher's arm; unknown counts as a righty.
export function rosterSide(bats, pitcherThrows) {
  const b = String(bats || '').toUpperCase();
  if (b === 'L' || b === 'R') return b;
  if (b === 'S' || b === 'B') return String(pitcherThrows || '').toUpperCase() === 'L' ? 'R' : 'L';
  return 'R';
}

export function zoneShares(balls) {
  const n = balls.length;
  const counts = { pull: 0, middle: 0, oppo: 0 };
  for (const b of balls) counts[b.zone] += 1;
  return { n, counts, pct: Object.fromEntries(ZONES.map(z => [z, n ? Math.round(100 * counts[z] / n) : 0])) };
}
