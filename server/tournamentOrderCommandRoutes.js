// Will's list of paid QR checkouts in Command, beside Intake (prd.md R4).
// Paid orders only, newest paid first, with everything staff need to fulfil
// each one; pending, abandoned and failed checkouts never appear here. Any
// internal role (admin, analyst, reviewer, fulfillment) may look.
//
//   GET /api/command/tournament-orders                      the list
//   PUT /api/command/tournament-orders/:orderId/delivered   { delivered: true | false }
//   GET /api/command/tournament-orders/team-entries         tournament teams a team order can match
//   PUT /api/command/tournament-orders/:orderId/team-match  { entry_id: number | null }
//
// The delivered mark (ship gate, 2026-10-06) keeps progress through a
// tournament's orders in Command rather than a spreadsheet. A team order
// (2026-10-22) first waits as "roster match needed" until it is matched to
// the team's tournament entry, whose event roster gets the included
// analytics; it can't be marked delivered before that.
// As with acting on intake, it needs the admin or fulfillment role; each
// change writes a history row naming who made it. Nothing here touches
// payment: only Stripe's signed webhook marks an order paid.
import { getOrderByOrderId, getPaidOrderView, listPaidOrders, setDelivered, setTeamMatch, teamEntriesForMatching } from './tournamentOrderStore.js';
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
    if (delivered && order.order_kind === 'team' && !order.entry_id) return res.status(409).json({ error: 'Match the team to its tournament roster first.' });
    if (setDelivered(db, order.id, delivered, req.internal.id)) {
      log('info', delivered ? 'tournament_order_delivered' : 'tournament_order_delivery_undone', { order_id: order.order_id, by: req.internal.id });
    }
    res.json({ order: getPaidOrderView(db, order.order_id) });
  });

  app.get('/api/command/tournament-orders/team-entries', requireInternal, (_req, res) => {
    res.json({ entries: teamEntriesForMatching(db) });
  });

  app.put('/api/command/tournament-orders/:orderId/team-match', canAct, (req, res) => {
    const raw = req.body?.entry_id;
    const entryId = raw === null ? null : Number(raw);
    if (entryId !== null && (!Number.isInteger(entryId) || entryId < 1)) return res.status(400).json({ error: 'entry_id is a tournament team, or null to unmatch.' });
    const order = getOrderByOrderId(db, req.params.orderId);
    if (!order || order.status !== 'paid' || order.order_kind !== 'team') return res.status(404).json({ error: 'Paid team order not found.' });
    if (entryId === null && order.delivered_at) return res.status(409).json({ error: 'Undo Delivered before unmatching the team.' });
    const r = setTeamMatch(db, order.id, entryId, req.internal.id);
    if (r.error) return res.status(400).json({ error: r.error });
    if (r.changed) log('info', entryId ? 'tournament_team_order_matched' : 'tournament_team_order_unmatched', { order_id: order.order_id, entry_id: entryId, by: req.internal.id });
    res.json({ order: getPaidOrderView(db, order.order_id) });
  });
}
