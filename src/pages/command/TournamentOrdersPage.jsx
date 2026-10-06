// Tournament orders (prd.md R4): every paid QR checkout, newest first, with
// what Will needs to fulfil it — package and amount, player, the parent's
// identification details or "Details missing", and the guardian's contact.
// One action (ship gate, 2026-10-06): admin and fulfillment mark an order
// delivered once its analysis has gone to the parent, and "Hide delivered"
// leaves the work still to do. Rows open nothing. An order appears only after
// Stripe's signed webhook marked it paid (docs/COMMAND_TDR.md).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/intake';
import { ErrorNote } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import './TournamentOrdersPage.css';

const money = (cents, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format((Number(cents) || 0) / 100);

// "#12" whether the parent typed "12" or "#12".
const jersey = value => (value ? `#${String(value).replace(/^#+/, '')}` : '');

function Identification({ order: o }) {
  if (!o.details_received_at) return <span className="tournament-orders-chip">Details missing</span>;
  const line = [jersey(o.jersey_number), o.primary_position, o.bats_throws].filter(Boolean).join(' · ');
  return (
    <>
      <span className="v">{o.team_club}</span>
      {line && <span className="l2">{line}</span>}
      {o.game_context && <span className="sub">Game: {o.game_context}</span>}
      {o.notes && <span className="sub">Note: {o.notes}</span>}
    </>
  );
}

// Checked once the analysis has gone to the parent; analysts and reviewers
// see the mark but cannot change it. When and who sit on the reference line.
function Delivered({ order: o, canMark, saving, error, onMark }) {
  return (
    <>
      <label className="tournament-orders-deliver">
        <input type="checkbox" checked={Boolean(o.delivered_at)} disabled={!canMark || saving}
          onChange={e => onMark(o, e.target.checked)} aria-label={`Delivered: ${o.player_name}, ${o.order_id}`} />
        <span className="deliver-text">Delivered</span>
      </label>
      {error && <span className="deliver-error" role="alert">{error}</span>}
    </>
  );
}

function OrderRows({ order: o, deliver }) {
  return (
    <tbody data-testid={`order-${o.order_id}`} data-delivered={o.delivered_at ? 'yes' : 'no'}>
      <tr className="main">
        <td className="c-paid"><span className="v">{fmtDateTime(o.paid_at)}</span><span className="mono">{o.order_id}</span></td>
        <td className="c-pkg"><span className="v">{o.package_label}</span><span className="sub">{money(o.amount_total, o.currency)}</span></td>
        <td className="c-player"><span className="v strong">{o.player_name}</span></td>
        <td className="c-id"><Identification order={o} /></td>
        <td className="c-guard">
          <span className="v">{o.guardian_name}</span>
          <span className="sub">{o.email}{o.phone && <> · <span className="nw">{o.phone}</span></>}</span>
        </td>
        <td className="c-deliv"><Delivered order={o} {...deliver} /></td>
      </tr>
      <tr className="meta">
        <td />
        <td colSpan={5}>
          <span>
            {o.tournament_label}{o.details_received_at && ` · Details received ${fmtDateTime(o.details_received_at)}`}
            {o.delivered_at && <> · <span className="delivered">Delivered {fmtDateTime(o.delivered_at)}{o.delivered_by && ` by ${o.delivered_by}`}</span></>}
          </span>
          <span className="mono">Stripe {o.stripe_session_id} · {o.stripe_payment_intent_id}</span>
        </td>
      </tr>
    </tbody>
  );
}

export default function TournamentOrdersPage() {
  const { user } = useAuth();
  const canMark = ['admin', 'fulfillment'].includes(user?.role);
  const [params, setParams] = useSearchParams();
  const hideDelivered = params.get('hide') === 'delivered';
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [markError, setMarkError] = useState({ orderId: '', text: '' });
  // A row marked delivered while "Hide delivered" is on stays in view until
  // the filter changes or the page reloads, so a slip can be taken back.
  const [kept, setKept] = useState(() => new Set());

  useEffect(() => {
    let live = true;
    api.commandTournamentOrders()
      .then(r => { if (live) { setOrders(r.orders); setError(''); } })
      .catch(err => live && setError(err.message));
    return () => { live = false; };
  }, []);

  function setHide(on) {
    setKept(new Set());
    setParams(p => { const n = new URLSearchParams(p); if (on) n.set('hide', 'delivered'); else n.delete('hide'); return n; }, { replace: true });
  }

  async function mark(order, delivered) {
    setSaving(order.order_id);
    setMarkError({ orderId: '', text: '' });
    try {
      const r = await api.commandSetTournamentOrderDelivered(order.order_id, delivered);
      setOrders(list => list.map(o => (o.order_id === order.order_id ? r.order : o)));
      if (delivered) setKept(k => new Set(k).add(order.order_id));
    } catch (err) {
      setMarkError({ orderId: order.order_id, text: err.message });
    } finally {
      setSaving('');
    }
  }

  const missing = orders ? orders.filter(o => !o.details_received_at).length : 0;
  const delivered = orders ? orders.filter(o => o.delivered_at).length : 0;
  const shown = !orders ? [] : hideDelivered ? orders.filter(o => !o.delivered_at || kept.has(o.order_id)) : orders;

  return (
    <div className="tournament-orders" data-testid="tournament-orders">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-white">Tournament orders</h1>
        <InfoTip label="About tournament orders" size={16}>
          An order appears here only after Stripe confirms payment. Unpaid or abandoned checkouts never do. Refunds are handled in Stripe and do not show here. Admin and fulfillment mark an order delivered once its analysis has gone to the parent.
        </InfoTip>
      </div>
      <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Paid QR checkouts, newest first.</p>

      {error ? <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>
        : !orders ? <p className="mt-6" style={{ color: '#94a3b8' }}>Loading…</p>
        : orders.length === 0 ? (
          <div className="tournament-orders-card tournament-orders-empty">
            <p className="text-white font-bold mb-1">No paid tournament orders yet.</p>
            <p className="text-sm" style={{ color: '#94a3b8' }}>Orders appear here as soon as Stripe confirms payment.</p>
          </div>
        ) : (
          <>
            <div className="tournament-orders-bar">
              <p className="tournament-orders-count" data-testid="tournament-orders-count">
                <b>{orders.length}</b> paid order{orders.length === 1 ? '' : 's'}
                {missing > 0 && <> · <span className="amber"><b>{missing}</b> with details missing</span></>}
                {delivered > 0 && <> · <b>{delivered}</b> delivered</>}
              </p>
              <label className="tournament-orders-filter">
                <input type="checkbox" checked={hideDelivered} onChange={e => setHide(e.target.checked)} className="accent-sky-400" data-testid="hide-delivered" />
                Hide delivered
              </label>
            </div>
            {shown.length === 0 ? (
              <div className="tournament-orders-card tournament-orders-empty">
                <p className="text-white font-bold mb-1">Nothing left to deliver.</p>
                <p className="text-sm" style={{ color: '#94a3b8' }}>Delivered orders are hidden.</p>
              </div>
            ) : (
              <div className="tournament-orders-card">
                <table className="tournament-orders-table">
                  <colgroup><col className="w-paid" /><col className="w-pkg" /><col className="w-player" /><col className="w-id" /><col className="w-guard" /><col className="w-deliv" /></colgroup>
                  <thead>
                    <tr><th scope="col">Paid</th><th scope="col">Package</th><th scope="col">Player</th><th scope="col">Identification</th><th scope="col">Guardian</th><th scope="col">Delivered</th></tr>
                  </thead>
                  {shown.map(o => (
                    <OrderRows key={o.order_id} order={o} deliver={{
                      canMark, saving: saving === o.order_id, error: markError.orderId === o.order_id ? markError.text : '', onMark: mark,
                    }} />
                  ))}
                </table>
              </div>
            )}
          </>
        )}
    </div>
  );
}
