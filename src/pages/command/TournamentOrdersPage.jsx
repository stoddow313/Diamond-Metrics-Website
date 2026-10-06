// Tournament orders (prd.md R4): every paid QR checkout, newest first, with
// what Will needs to fulfil it — package and amount, player, the parent's
// identification details or "Details missing", and the guardian's contact.
// Read-only in v1: no actions and no row links. An order appears only after
// Stripe's signed webhook marked it paid (docs/COMMAND_TDR.md).
import { useEffect, useState } from 'react';
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

function OrderRows({ order: o }) {
  return (
    <tbody data-testid={`order-${o.order_id}`}>
      <tr className="main">
        <td className="c-paid"><span className="v">{fmtDateTime(o.paid_at)}</span><span className="mono">{o.order_id}</span></td>
        <td className="c-pkg"><span className="v">{o.package_label}</span><span className="sub">{money(o.amount_total, o.currency)}</span></td>
        <td className="c-player"><span className="v strong">{o.player_name}</span></td>
        <td className="c-id"><Identification order={o} /></td>
        <td className="c-guard">
          <span className="v">{o.guardian_name}</span>
          <span className="sub">{o.email}{o.phone && <> · <span className="nw">{o.phone}</span></>}</span>
        </td>
      </tr>
      <tr className="meta">
        <td />
        <td colSpan={4}>
          <span>{o.tournament_label}{o.details_received_at && ` · Details received ${fmtDateTime(o.details_received_at)}`}</span>
          <span className="mono">Stripe {o.stripe_session_id} · {o.stripe_payment_intent_id}</span>
        </td>
      </tr>
    </tbody>
  );
}

export default function TournamentOrdersPage() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.commandTournamentOrders()
      .then(r => { if (live) { setOrders(r.orders); setError(''); } })
      .catch(err => live && setError(err.message));
    return () => { live = false; };
  }, []);

  const missing = orders ? orders.filter(o => !o.details_received_at).length : 0;

  return (
    <div className="tournament-orders" data-testid="tournament-orders">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-white">Tournament orders</h1>
        <InfoTip label="About tournament orders" size={16}>
          An order appears here only after Stripe confirms payment. Unpaid or abandoned checkouts never do. Refunds are handled in Stripe and do not show here.
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
            <p className="tournament-orders-count" data-testid="tournament-orders-count">
              <b>{orders.length}</b> paid order{orders.length === 1 ? '' : 's'}
              {missing > 0 && <> · <span className="amber"><b>{missing}</b> with details missing</span></>}
            </p>
            <div className="tournament-orders-card">
              <table className="tournament-orders-table">
                <colgroup><col className="w-paid" /><col className="w-pkg" /><col className="w-player" /><col className="w-id" /><col className="w-guard" /></colgroup>
                <thead>
                  <tr><th scope="col">Paid</th><th scope="col">Package</th><th scope="col">Player</th><th scope="col">Identification</th><th scope="col">Guardian</th></tr>
                </thead>
                {orders.map(o => <OrderRows key={o.order_id} order={o} />)}
              </table>
            </div>
          </>
        )}
    </div>
  );
}
