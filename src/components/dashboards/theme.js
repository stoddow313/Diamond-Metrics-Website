// Dashboard theme tokens — the core Diamond Metrics dark system shared with
// the marketing site and admin (see src/index.css, components/admin/theme.js).
// Kept out of shared.jsx so react-refresh stays happy.

export const pageBg = { background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' };
export const headerBar = { borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.9)' };
export const cardStyle = { backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' };
export const inputStyle = { backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155', color: '#cfe8ff' };

export const text = {
  primary: '#f8fafc',      // headline values, player names
  body: '#cfe8ff',         // regular cell text
  secondary: '#94a3b8',    // muted blue-gray
  faint: '#64748b',        // table headers, footnotes
  accent: '#38bdf8',       // interactive / links
  good: '#4ade80',         // positive performance only
  bad: '#f87171',          // negative performance only
};

export const rowBorder = { borderColor: 'rgba(30, 58, 95, 0.45)' };
export const headBorder = { borderColor: 'rgba(30, 58, 95, 0.8)' };
// Solid card-tone for sticky cells that must occlude scrolling content.
export const stickyBg = { backgroundColor: '#0e1d3a' };
