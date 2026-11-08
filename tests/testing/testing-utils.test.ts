// ---------------------------------------------------------------------------
// Tests – Testing Utilities
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createMockWebhookEvent, simulateWebhook } from '../../src/testing/index.js';
import { WebhookEngine } from '../../src/core/engine.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { NoOpVerifier } from '../../src/security/verifier.js';

describe('Testing Utilities', () => {
  it('creates a mock webhook event with defaults', () => {
    const event = createMockWebhookEvent();
    expect(event.eventId).toMatch(/^evt_/);
    expect(event.provider).toBe('mock-provider');
    expect(event.status).toBe('PENDING');
  });

  it('allows overriding mock event fields', () => {
    const event = createMockWebhookEvent({
      eventId: 'custom_123',
      provider: 'stripe',
      data: { amount: 5000 },
    });
    expect(event.eventId).toBe('custom_123');
    expect(event.provider).toBe('stripe');
    expect(event.data).toEqual({ amount: 5000 });
  });

  it('simulates a webhook through an engine instance', async () => {
    const engine = new WebhookEngine({
      storage: new MemoryStorage(),
      verifier: new NoOpVerifier(),
    });
    await engine.initialize();

    const handler = vi.fn(async () => {});
    engine.register('test.simulation', handler);

    const result = await simulateWebhook(engine, {
      provider: 'test-suite',
      type: 'test.simulation',
      data: { hello: 'world' },
    });

    expect(result.status).toBe(200);
    expect(result.body.message).toBe('Event accepted');

    await new Promise((r) => setTimeout(r, 40));
    expect(handler).toHaveBeenCalled();

    await engine.shutdown();
  });
});

