// GET /api/command/tournament-orders — Will's list of paid QR checkouts in
// Command, beside Intake (prd.md R4). Read-only in v1: paid orders only,
// newest paid first, with everything staff need to fulfil each one. Any
// internal role (admin, analyst, reviewer, fulfillment) may look; pending,
// abandoned and failed checkouts never appear here.
import { listPaidOrders } from './tournamentOrderStore.js';

export function mountTournamentOrderCommandRoutes(app, { db, requireInternal }) {
  app.get('/api/command/tournament-orders', requireInternal, (_req, res) => {
    res.json({ orders: listPaidOrders(db) });
  });
}
