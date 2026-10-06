// POST /api/post-purchase-intake — the "Help us identify your player" step on
// Will's success page (handoff §3, §6). Details are kept only for a payment
// Stripe has confirmed; this endpoint never marks an order paid.
export const SAVE_FAILED = 'We could not save your details. Please try again.';

export function mountPostPurchaseRoutes(app) {
  app.post('/api/post-purchase-intake', (_req, res) => {
    // T6 verifies the payment and saves the details here.
    return res.status(503).json({ error: SAVE_FAILED });
  });
}
