// Confirms a withdraw, archive or delete after showing what it touches.
// The server decides (GET /api/event-records/:kind/:id/dependencies):
// blockers stop the action, warnings need a deliberate confirm.
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleX, Info } from 'lucide-react';
import { api } from '../../lib/api';
import { PrimaryButton, GhostButton, ErrorNote } from './ui';

const VERB = { withdraw: 'Withdraw', archive: 'Archive', delete: 'Delete' };
const BUSY = { withdraw: 'Withdrawing…', archive: 'Archiving…', delete: 'Deleting…' };

export default function RecordActionDialog({ kind, id, action, onConfirm, onClose }) {
  const [dep, setDep] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);

  useEffect(() => {
    api.recordDependencies(kind, id).then(setDep).catch(err => setError(err.message));
  }, [kind, id]);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const plan = dep?.actions?.[action];
  const verb = VERB[action];

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(2, 6, 23, 0.7)' }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="record-action-title" data-testid="record-action-dialog"
        className="w-full max-w-md rounded-2xl border p-5" style={{ backgroundColor: '#0f1a2e', borderColor: '#1e3a5f' }}>
        <h2 id="record-action-title" className="text-base font-bold text-white mb-3">
          {verb} {dep ? <span style={{ color: '#cfe8ff' }}>{dep.label}</span> : '…'}
        </h2>
        {!dep && !error && <p className="text-sm" style={{ color: '#94a3b8' }}>Checking what depends on it…</p>}
        {plan && (
          <ul className="flex flex-col gap-2 text-sm mb-4">
            {plan.blockers.map(b => <Line key={b} icon={CircleX} color="#f87171">{b}</Line>)}
            {plan.warnings.map(w => <Line key={w} icon={CircleAlert} color="#fbbf24">{w}</Line>)}
            {plan.effects.map(e => <Line key={e} icon={Info} color="#94a3b8">{e}</Line>)}
          </ul>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 mt-3">
          <GhostButton ref={cancelRef} type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="button" onClick={confirm} disabled={!plan?.allowed || busy} data-testid="record-action-confirm"
            style={action === 'delete' ? { backgroundColor: '#f87171', color: '#1f0a0a' } : undefined}>
            {busy ? BUSY[action] : plan && !plan.allowed ? `Can’t ${verb.toLowerCase()} yet` : verb}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function Line({ icon, color, children }) {
  const Icon = icon;
  return (
    <li className="flex items-start gap-2" style={{ color: color === '#94a3b8' ? '#cbd5e1' : color }}>
      <Icon size={15} className="shrink-0 mt-0.5" style={{ color }} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}
