// Small pieces shared by Will's intake queue and record pages.

const STAGE_TONE = {
  new: '#38bdf8', needs_identity_review: '#fbbf24', needs_customer_action: '#fbbf24', ready_for_job: '#4ade80',
  in_analysis: '#c4b5fd', metrics_released: '#4ade80', game_record_pending: '#38bdf8', complete: '#4ade80',
  closed: '#64748b', draft: '#64748b',
};

const FLAGS = {
  escalated: ['Escalated', '#f87171'],
  overdue: ['Overdue', '#f87171'],
  deletion_requested: ['Deletion requested', '#f87171'],
  customer_replied: ['Customer replied', '#38bdf8'],
  payment_unconfirmed: ['Payment unconfirmed', '#fbbf24'],
  email_unverified: ['Email unverified', '#fbbf24'],
  hall_of_fame: ['Hall of Fame', '#c4b5fd'],
};

export function StageChip({ stage, label }) {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: STAGE_TONE[stage] || '#94a3b8' }} data-stage={stage}>
      {label || String(stage).replace(/_/g, ' ')}
    </span>
  );
}

export function Tag({ children, color = '#94a3b8', title }) {
  return (
    <span title={title} className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color }}>
      {children}
    </span>
  );
}

export function FlagTags({ flags = [], synthetic = false }) {
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {synthetic && <Tag color="#fbbf24">test</Tag>}
      {flags.map(f => FLAGS[f] && <Tag key={f} color={FLAGS[f][1]}>{FLAGS[f][0]}</Tag>)}
    </span>
  );
}

export function Panel({ title, aside, children, className = '', testId }) {
  return (
    <div className={`rounded-2xl border p-5 ${className}`} style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }} data-testid={testId}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          {title && <h2 className="font-bold uppercase tracking-wider" style={{ color: '#cfe8ff', fontSize: '0.875rem', lineHeight: '1.25rem', margin: 0 }}>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

// Fixed bottom-right confirmation / error, visible wherever the page is scrolled.
export function Toast({ message, tone = 'ok', onClose }) {
  if (!message) return null;
  const err = tone === 'error';
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md rounded-xl border px-4 py-3 shadow-lg flex items-start gap-3" role={err ? 'alert' : 'status'}
      style={{ backgroundColor: err ? '#2a0f14' : '#0b2a1c', borderColor: err ? '#f87171' : '#4ade80' }} data-testid="toast">
      <p className="text-sm" style={{ color: err ? '#fecaca' : '#bbf7d0' }}>{message}</p>
      <button type="button" onClick={onClose} className="text-xs cursor-pointer" style={{ color: '#94a3b8' }} aria-label="Dismiss">✕</button>
    </div>
  );
}
