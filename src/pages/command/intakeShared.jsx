// Small pieces shared by Will's intake queue and record pages.
import { useEffect, useRef } from 'react';
import { Clock, DollarSign, FlaskConical, MailWarning, MessageSquare, ShieldX, Star, Trash2, TriangleAlert } from 'lucide-react';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { STAGES } from './intakeStages';

const FLAGS = {
  escalated: { Icon: TriangleAlert, tip: 'Escalated to an admin', color: '#f87171' },
  no_consent: { Icon: ShieldX, tip: 'No footage consent — the terms are missing or were revoked', color: '#f87171' },
  overdue: { Icon: Clock, tip: 'Overdue', color: '#f87171' },
  deletion_requested: { Icon: Trash2, tip: 'Deletion requested', color: '#f87171' },
  customer_replied: { Icon: MessageSquare, tip: 'Customer replied', color: '#38bdf8' },
  payment_unconfirmed: { Icon: DollarSign, tip: 'Payment unconfirmed', color: '#fbbf24' },
  email_unverified: { Icon: MailWarning, tip: 'Email unverified', color: '#fbbf24' },
  hall_of_fame: { Icon: Star, tip: 'Hall of Fame request', color: '#c4b5fd' },
  synthetic: { Icon: FlaskConical, tip: 'Test submission — kept out of real jobs and notifications', color: '#fbbf24' },
};

export function StageChip({ stage, focusable = true }) {
  const st = STAGES[stage] || { label: String(stage).replace(/_/g, ' '), tone: '#94a3b8' };
  return (
    <Tooltip content={st.tip} focusable={focusable}>
      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
        style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: st.tone }} data-stage={stage}>
        {st.label}
      </span>
    </Tooltip>
  );
}

export function Tag({ children, color = '#94a3b8', title }) {
  const tag = (
    <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color }}>
      {children}
    </span>
  );
  return title ? <Tooltip content={title}>{tag}</Tooltip> : tag;
}

// Row and record flags as small icons; each says what it is on hover.
export function FlagTags({ flags = [], synthetic = false, focusable = true }) {
  const keys = [...(synthetic ? ['synthetic'] : []), ...flags.filter(f => FLAGS[f])];
  if (!keys.length) return null;
  return (
    <span className="inline-flex gap-1 flex-wrap items-center" data-flags={keys.join(' ')}>
      {keys.map(k => {
        const { Icon, tip, color } = FLAGS[k];
        return (
          <Tooltip key={k} content={tip} focusable={focusable} className="rounded-md">
            <span className="w-6 h-6 rounded-md inline-flex items-center justify-center" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color }} data-flag={k}>
              <Icon size={13} strokeWidth={2.4} aria-hidden="true" />
              <span className="sr-only">{tip}</span>
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

export function Panel({ title, aside, hint, children, className = '', testId }) {
  return (
    <div className={`rounded-2xl border p-5 ${className}`} style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }} data-testid={testId}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-1.5 min-w-0">
            {title && <h2 className="font-bold uppercase tracking-wider" style={{ color: '#cfe8ff', fontSize: '0.875rem', lineHeight: '1.25rem', margin: 0 }}>{title}</h2>}
            {hint && <InfoTip label={typeof title === 'string' ? `Help: ${title}` : 'Help'}>{hint}</InfoTip>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

// Fixed bottom-right confirmation / error, visible wherever the page is scrolled.
// Confirmations fade on their own; an error stays until it is dismissed.
export function Toast({ message, tone = 'ok', onClose }) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!message || tone === 'error') return undefined;
    const t = setTimeout(() => close.current?.(), 4000);
    return () => clearTimeout(t);
  }, [message, tone]);
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
