// POST /api/create-checkout-session — the "Continue to secure checkout"
// button on Will's Find Your Player page (handoff §3-§4). The browser sends a
// package key; the server alone decides the Stripe Price, saves the pending
// order first, and hands Stripe nothing but ids and the email for the receipt.
import { readStripeConfig, priceForPackage, stripeClient } from './stripeConfig.js';
import { validateCheckout } from './tournamentOrderLogic.js';
import { createPendingOrder, attachSession } from './tournamentOrderStore.js';
import { publicBaseUrl } from './notifications.js';
import { ENV, captureError, log } from './observability.js';
import { makeLimiter, rateLimit, clientIp } from './rateLimit.js';

export const CHECKOUT_FAILED = 'We could not start secure checkout. Please try again.';

// Where Stripe sends the parent back. A configured DM_PUBLIC_BASE_URL wins;
// production sets it to https://diamondmetrics.ai, the handoff's addresses.
// Outside production with nothing configured, the page the parent started on
// (the request's Origin), so a phone on the studio's http://<mac>.local link
// comes back to that link instead of to its own localhost. Spike S1: Stripe
// test mode accepts .local, LAN and localhost return addresses. Production
// never reads Origin.
export function returnBase(origin, { configured = Boolean(process.env.DM_PUBLIC_BASE_URL), production = ENV === 'production' } = {}) {
  if (configured || production || !/^https?:\/\/[^\s/?#@]+$/i.test(String(origin || ''))) return publicBaseUrl();
  return origin;
}

export function mountTournamentCheckoutRoutes(app, { db }) {
  // Generous on purpose: many parents at one field can share a mobile
  // carrier's address (A26). Checked before anything is saved or sent to
  // Stripe; the limiter adds "Try again in …" itself.
  const byNetwork = makeLimiter({ limit: 60, windowMs: 10 * 60 * 1000 });
  const byEmail = makeLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
  const limits = rateLimit([
    { limiter: byNetwork, key: clientIp, message: 'Too many checkout attempts from this network.' },
    { limiter: byEmail, key: req => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '') || null, message: 'Too many checkout attempts for this email.' },
  ]);

  app.post('/api/create-checkout-session', limits, async (req, res) => {
    try {
      return await startCheckout(db, req, res);
    } catch (err) {
      // Anything unexpected (the database, say): logged, and the parent sees
      // Will's sentence rather than a system message.
      captureError(err, { event: 'tournament_checkout_error' });
      return res.status(500).json({ error: CHECKOUT_FAILED });
    }
  });
}

async function startCheckout(db, req, res) {
  const checked = validateCheckout(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const input = checked.value;

  // No usable key or no Price for this package: refuse before anything is
  // saved or sent (R7). The reason is logged by name in priceForPackage.
  const config = readStripeConfig();
  const priceId = priceForPackage(config, input.packageKey);
  const stripe = priceId ? stripeClient(config) : null;
  if (!stripe) return res.status(503).json({ error: CHECKOUT_FAILED });

  const order = createPendingOrder(db, { ...input, priceId });
  const base = returnBase(req.get('origin'));
  const ids = { order_id: order.order_id, package_key: input.packageKey };
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: input.email,
      client_reference_id: order.order_id,
      metadata: ids,
      // On the payment too, so a refund in the dashboard leads back to the
      // order. receipt_email has Stripe email the parent a receipt for this
      // payment: in live mode whatever the account's email settings, so the
      // receipt does not hang on a dashboard switch (ship gate, 2026-10-06).
      // It is the email Stripe already holds for the checkout.
      payment_intent_data: { metadata: ids, receipt_email: input.email },
      success_url: `${base}/find-your-player/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/find-your-player?checkout=cancelled`,
    });
  } catch (err) {
    // Stripe's message can echo the email, so only its type and code are
    // logged. The order stays pending and never reaches Command.
    log('warn', 'tournament_checkout_failed', { order_id: order.order_id, type: err?.type, code: err?.code });
    if (err?.param === 'customer_email') return res.status(400).json({ error: 'Enter a valid email address.' });
    return res.status(502).json({ error: CHECKOUT_FAILED });
  }
  attachSession(db, order.id, session.id);
  log('info', 'tournament_checkout_started', { ...ids, session_id: session.id });
  return res.json({ url: session.url, orderId: order.order_id });
}
