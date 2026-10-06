// Will's list of paid QR checkouts in Command, beside Intake (prd.md R4).
// Paid orders only, newest paid first, with everything staff need to fulfil
// each one; pending, abandoned and failed checkouts never appear here. Any
// internal role (admin, analyst, reviewer, fulfillment) may look.
//
//   GET /api/command/tournament-orders                      the list
//   PUT /api/command/tournament-orders/:orderId/delivered   { delivered: true | false }
//
// The one action (ship gate, 2026-10-06) is the delivered mark, so progress
// through a tournament's orders stays in Command rather than a spreadsheet.
// As with acting on intake, it needs the admin or fulfillment role; each
// change writes a history row naming who made it. Nothing here touches
// payment: only Stripe's signed webhook marks an order paid.
import { getOrderByOrderId, getPaidOrderView, listPaidOrders, setDelivered } from './tournamentOrderStore.js';
import { log } from './observability.js';

export function mountTournamentOrderCommandRoutes(app, { db, requireInternal, requireInternalRole }) {
  const canAct = requireInternalRole('admin', 'fulfillment');

  app.get('/api/command/tournament-orders', requireInternal, (_req, res) => {
    res.json({ orders: listPaidOrders(db) });
  });

  app.put('/api/command/tournament-orders/:orderId/delivered', canAct, (req, res) => {
    const delivered = req.body?.delivered;
    if (typeof delivered !== 'boolean') return res.status(400).json({ error: 'delivered must be true or false.' });
    const order = getOrderByOrderId(db, req.params.orderId);
    // An unpaid order is not on the list, so it cannot be delivered either.
    if (!order || order.status !== 'paid') return res.status(404).json({ error: 'Paid order not found.' });
    if (setDelivered(db, order.id, delivered, req.internal.id)) {
      log('info', delivered ? 'tournament_order_delivered' : 'tournament_order_delivery_undone', { order_id: order.order_id, by: req.internal.id });
    }
    res.json({ order: getPaidOrderView(db, order.order_id) });
  });
}
