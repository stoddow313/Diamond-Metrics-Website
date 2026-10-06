// POST /api/stripe/webhook — Stripe's signed word that a checkout was paid,
// the only thing that marks a tournament order paid (handoff §5). Mounted
// ahead of the global JSON parser so the signature is checked over the exact
// bytes Stripe sent.
import express from 'express';
import { readStripeConfig } from './stripeConfig.js';
import { log } from './observability.js';

export function mountStripeWebhookRoutes(app) {
  app.post('/api/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), (_req, res) => {
    const config = readStripeConfig();
    if (!config.secretKey || !config.webhookSecret) {
      log('warn', 'stripe_webhook_not_configured', { missing: [!config.secretKey && 'STRIPE_SECRET_KEY', !config.webhookSecret && 'STRIPE_WEBHOOK_SECRET'].filter(Boolean) });
      return res.status(400).json({ error: 'Stripe webhooks are not configured on this server.' });
    }
    // T5 verifies the signature and records the payment here.
    return res.status(400).json({ error: 'Stripe webhooks are not handled yet.' });
  });
}
