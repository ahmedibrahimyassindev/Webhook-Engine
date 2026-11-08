/**
 * Example: Ingesting Stripe webhooks with Express
 *
 * Run with: npx tsx examples/express-stripe.ts
 */

import express from 'express';
import {
  WebhookEngine,
  MemoryStorage,
  StripeVerifier,
  createExpressMiddleware,
  RetryableError,
} from '../src/index.js';

async function main() {
  const engine = new WebhookEngine({
    storage: new MemoryStorage(),
    verifier: new StripeVerifier({
      secret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_secret_123',
      tolerance: 300_000, // 5 minutes
    }),
  });

  // Register handler
  engine.register('payment_intent.succeeded', async (event) => {
    console.log('Payment succeeded event received:', event.eventId);
    const data = event.data as Record<string, unknown>;

    try {
      // Simulate business logic (e.g., fulfill customer order)
      console.log('Fulfilling order for payment intent:', data['id']);
    } catch (err) {
      throw new RetryableError('Failed to contact order service', { cause: err as Error });
    }
  });

  // Lifecycle listeners
  engine.on('event.completed', (evt) => {
    console.log(`Event ${evt.eventId} completed successfully.`);
  });
  engine.on('event.deadLetter', (evt) => {
    console.error(`ALERT: Event ${evt.eventId} moved to dead-letter queue!`);
  });

  await engine.initialize();

  const app = express();

  // Webhook ingestion endpoint
  // Note: We use express.raw to preserve exact bytes for signature verification
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    createExpressMiddleware(engine, { provider: 'stripe' }),
  );

  const port = process.env.PORT ?? 3000;
  app.listen(port, () => {
    console.log(`Stripe webhook listener running on http://localhost:${port}/webhooks/stripe`);
  });
}

main().catch(console.error);

