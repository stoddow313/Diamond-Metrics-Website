// Small building blocks for the tournament editor.
import { Tooltip } from '../../../components/Tooltip';
import { cardStyle } from '../../../components/admin/theme';

// An icon-only action; its name shows on hover and is read by screen readers.
export function IconButton({ icon, label, onClick, tone = 'default', active = false, disabled = false, testId }) {
  const Icon = icon;
  const color = tone === 'danger' ? '#f87171' : active ? '#38bdf8' : '#94a3b8';
  return (
    <Tooltip content={label} asChild>
      <button type="button" aria-label={label} aria-pressed={active || undefined} onClick={onClick} disabled={disabled} data-testid={testId}
        className="p-1.5 rounded-md cursor-pointer transition-colors hover:bg-slate-800 disabled:opacity-40 disabled:cursor-default outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        style={{ color }}>
        <Icon size={15} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const TONES = {
  neutral: { bg: 'rgba(148, 163, 184, 0.12)', fg: '#cbd5e1' },
  accent: { bg: 'rgba(56, 189, 248, 0.12)', fg: '#38bdf8' },
  gold: { bg: 'rgba(251, 191, 36, 0.14)', fg: '#fbbf24' },
  silver: { bg: 'rgba(203, 213, 225, 0.14)', fg: '#e2e8f0' },
  warn: { bg: 'rgba(251, 146, 60, 0.14)', fg: '#fb923c' },
  muted: { bg: 'rgba(71, 85, 105, 0.25)', fg: '#94a3b8' },
  good: { bg: 'rgba(74, 222, 128, 0.12)', fg: '#4ade80' },
};

export function Chip({ children, tone = 'neutral', tip, testId }) {
  const t = TONES[tone] || TONES.neutral;
  const chip = (
    <span data-testid={testId} className="text-[11px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ backgroundColor: t.bg, color: t.fg }}>
      {children}
    </span>
  );
  return tip ? <Tooltip content={tip}>{chip}</Tooltip> : chip;
}

export function Section({ title, aside, children, testId }) {
  return (
    <section className="rounded-2xl border p-5 mb-6" style={cardStyle} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// An inline editing tray under a row.
export function Tray({ children, onSubmit }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap gap-3 items-end px-3 py-3 mt-1 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
      {children}
    </form>
  );
}

export function Toggle({ checked, onChange, children, testId }) {
  return (
    <label className="flex items-center gap-2 text-xs font-bold cursor-pointer select-none" style={{ color: '#94a3b8' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-sky-400" data-testid={testId} />
      {children}
    </label>
  );
}
