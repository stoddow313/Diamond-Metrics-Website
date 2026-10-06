// POST /api/stripe/webhook — Stripe's signed word that a checkout was paid,
// the only thing that marks a tournament order paid (handoff §5). Mounted
// ahead of the global JSON parser so the signature is checked over the exact
// bytes Stripe sent. Every delivery that passes the signature check is
// acknowledged with a 2xx, except a database failure, which answers 500 so
// Stripe retries.
import express from 'express';
import { readStripeConfig, stripeWebhooks } from './stripeConfig.js';
import { PACKAGES } from './tournamentOrderLogic.js';
import { getOrderByOrderId, getOrder, attachSession, recordStripeEvent, markPaid } from './tournamentOrderStore.js';
import { captureError, log } from './observability.js';

// checkout.session.completed, in one transaction. The event id is recorded
// first, so a redelivered event stops there; then the order — found by the id
// we gave Stripe, never by a name or an email — must be the one this session
// was made for, and it turns paid only while it is still pending.
export function recordCheckoutCompleted(db, event) {
  const session = event.data?.object || {};
  return db.transaction(() => {
    const order = getOrderByOrderId(db, session.client_reference_id);
    if (!order) return { outcome: 'foreign' };
    if (order.stripe_session_id && order.stripe_session_id !== session.id) return { outcome: 'session_mismatch', order };
    if (!recordStripeEvent(db, { eventId: event.id, type: event.type, orderPk: order.id })) return { outcome: 'duplicate', order };
    // The session id is normally stored at checkout; if saving it failed, the
    // paid event supplies it rather than a paid order being dropped.
    if (!order.stripe_session_id) attachSession(db, order.id, session.id);
    let outcome = 'not_paid';
    if (session.payment_status === 'paid') {
      outcome = markPaid(db, order.id, {
        sessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        paymentStatus: session.payment_status,
        eventId: event.id,
      }) ? 'paid' : 'already_paid';
    }
    db.prepare('UPDATE stripe_events SET outcome = ? WHERE event_id = ?').run(outcome, event.id);
    return { outcome, order: getOrder(db, order.id) };
  })();
}

export function mountStripeWebhookRoutes(app, { db }) {
  app.post('/api/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const config = readStripeConfig();
    if (!config.secretKey || !config.webhookSecret) {
      log('warn', 'stripe_webhook_not_configured', { missing: [!config.secretKey && 'STRIPE_SECRET_KEY', !config.webhookSecret && 'STRIPE_WEBHOOK_SECRET'].filter(Boolean) });
      return res.status(400).json({ error: 'Stripe webhooks are not configured on this server.' });
    }
    const signature = req.get('stripe-signature');
    if (!signature || !Buffer.isBuffer(req.body)) {
      log('warn', 'stripe_webhook_rejected', { reason: 'unsigned' });
      return res.status(400).json({ error: 'Missing Stripe signature.' });
    }
    let event;
    try {
      // Stripe's library, with its default five-minute tolerance.
      event = stripeWebhooks.constructEvent(req.body, signature, config.webhookSecret);
    } catch {
      // The body is never logged: it is not ours until the signature says so.
      log('warn', 'stripe_webhook_rejected', { reason: 'invalid_signature' });
      return res.status(400).json({ error: 'Invalid Stripe signature.' });
    }
    if (event.type !== 'checkout.session.completed') return res.json({ received: true });

    let result;
    try {
      result = recordCheckoutCompleted(db, event);
    } catch (err) {
      captureError(err, { event: 'stripe_webhook_failed', event_id: event.id });
      return res.status(500).json({ error: 'Could not record this event; Stripe will retry it.' });
    }
    const session = event.data.object;
    const ids = { event_id: event.id, session_id: session.id, order_id: result.order?.order_id };
    if (result.outcome === 'foreign') {
      // A /pricing Payment Link, `stripe trigger`, another copy of the site.
      log('info', 'stripe_webhook_ignored', { event_id: event.id, session_id: session.id });
    } else if (result.outcome === 'session_mismatch') {
      log('warn', 'stripe_webhook_session_mismatch', ids);
    } else if (result.outcome === 'not_paid') {
      // A payment method that settles later (A30): the order stays pending.
      log('warn', 'stripe_webhook_not_paid', { ...ids, payment_status: session.payment_status });
    } else {
      log('info', `stripe_webhook_${result.outcome}`, ids);
      const listed = PACKAGES[result.order.package_key]?.amount;
      if (result.outcome === 'paid' && listed !== session.amount_total) {
        log('warn', 'tournament_order_amount_differs', { ...ids, amount_total: session.amount_total, list_amount: listed });
      }
    }
    return res.json({ received: true });
  });
}
