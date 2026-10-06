// POST /api/post-purchase-intake — the "Help us identify your player" step on
// Will's success page (handoff §3, §6). The details are kept only for a
// payment Stripe has confirmed: the order the webhook marked paid or, when the
// parent is faster than the webhook, a session Stripe itself reports paid for
// that order (A19). This endpoint never marks an order paid, and its replies
// never echo what was saved.
import { validateDetails } from './tournamentOrderLogic.js';
import { getOrderBySessionId, saveDetails } from './tournamentOrderStore.js';
import { readStripeConfig, stripeClient } from './stripeConfig.js';
import { captureError, log } from './observability.js';

export const SAVE_FAILED = 'We could not save your details. Please try again.';
// One refusal for an unknown link and an unpaid one, so the reply never says
// whether an order exists.
export const NOT_CONFIRMED = 'We could not confirm a payment for this order. If you were charged, email info@diamondmetrics.ai.';

export function mountPostPurchaseRoutes(app, { db }) {
  app.post('/api/post-purchase-intake', async (req, res) => {
    try {
      return await savePlayerDetails(db, req, res);
    } catch (err) {
      captureError(err, { event: 'post_purchase_error' });
      return res.status(500).json({ error: SAVE_FAILED });
    }
  });
}

async function savePlayerDetails(db, req, res) {
  const checked = validateDetails(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });

  // Only a session id this server stored is ever looked up, here or at Stripe.
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  const order = getOrderBySessionId(db, sessionId);
  if (!order) {
    log('info', 'post_purchase_refused', { reason: 'unknown_session' });
    return res.status(402).json({ error: NOT_CONFIRMED });
  }
  let verifiedBy = 'webhook';
  if (order.status !== 'paid') {
    const verdict = await paidAtStripe(order);
    if (verdict === 'unreachable') return res.status(503).json({ error: SAVE_FAILED });
    if (verdict !== 'paid') {
      log('info', 'post_purchase_refused', { reason: 'not_paid', order_id: order.order_id });
      return res.status(402).json({ error: NOT_CONFIRMED });
    }
    verifiedBy = 'stripe';   // saved now; the order turns paid when the webhook lands
  }
  const how = saveDetails(db, order.id, checked.value);
  log('info', `tournament_details_${how}`, { order_id: order.order_id, verified_by: verifiedBy });
  return res.json({ ok: true });
}

// 'paid' only when Stripe reports this very session paid for this very order.
async function paidAtStripe(order) {
  const stripe = stripeClient(readStripeConfig());
  if (!stripe) return 'unreachable';
  try {
    const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
    return session.payment_status === 'paid' && session.client_reference_id === order.order_id ? 'paid' : 'unpaid';
  } catch (err) {
    log('warn', 'post_purchase_stripe_check_failed', { order_id: order.order_id, type: err?.type, code: err?.code });
    // Stripe answered and does not know the session: that is a refusal, not an outage.
    return err?.type === 'StripeInvalidRequestError' ? 'unpaid' : 'unreachable';
  }
}
