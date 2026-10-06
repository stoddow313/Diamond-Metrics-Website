// POST /api/create-checkout-session — the "Continue to secure checkout"
// button on Will's Find Your Player page (handoff §3-§4). The browser sends a
// package key; the server alone decides the Stripe Price.
import { readStripeConfig } from './stripeConfig.js';
import { log } from './observability.js';

export const CHECKOUT_FAILED = 'We could not start secure checkout. Please try again.';

export function mountTournamentCheckoutRoutes(app) {
  app.post('/api/create-checkout-session', (_req, res) => {
    // Without a usable key nothing is saved and nothing reaches Stripe (R7).
    if (!readStripeConfig().mode) {
      log('warn', 'stripe_not_configured', { missing: 'STRIPE_SECRET_KEY' });
      return res.status(503).json({ error: CHECKOUT_FAILED });
    }
    // T4 creates the pending order and the Checkout Session here.
    return res.status(501).json({ error: CHECKOUT_FAILED });
  });
}
