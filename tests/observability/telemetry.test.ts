// ---------------------------------------------------------------------------
// Tests – Observability (Logger, Metrics) & Event Querying
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookEngine } from '../../src/core/engine.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { NoOpVerifier } from '../../src/security/verifier.js';
import type { Logger, MetricsCollector } from '../../src/core/types.js';

describe('WebhookEngine Observability & Inspection', () => {
  let engine: WebhookEngine;
  let storage: MemoryStorage;
  let mockLogger: Logger;
  let mockMetrics: MetricsCollector;

  beforeEach(async () => {
    storage = new MemoryStorage();
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockMetrics = {
      recordEventIngested: vi.fn(),
      recordEventProcessed: vi.fn(),
      recordRetry: vi.fn(),
      recordDeadLetter: vi.fn(),
    };

    engine = new WebhookEngine({
      storage,
      verifier: new NoOpVerifier(),
      logger: mockLogger,
      metrics: mockMetrics,
      retryInterval: 100,
    });

    await engine.initialize();
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  it('records metrics and logs on successful ingest and processing', async () => {
    engine.register('order.created', async () => {});

    const result = await engine.ingest({
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify({ id: 'obs_1', type: 'order.created' })),
      provider: 'shopify',
    });

    expect(result.status).toBe(200);
    expect(mockMetrics.recordEventIngested).toHaveBeenCalledWith('shopify', 'order.created');

    await new Promise((r) => setTimeout(r, 60));
    expect(mockMetrics.recordEventProcessed).toHaveBeenCalledWith(
      'shopify',
      'order.created',
      expect.any(Number),
      true,
    );
  });

  it('queries events via getEvent and listEvents', async () => {
    await engine.ingest({
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ id: 'q_1', type: 'test.a' })),
      provider: 'github',
    });

    const event = await engine.getEvent('q_1', 'github');
    expect(event).not.toBeNull();
    expect(event?.eventId).toBe('q_1');

    const list = await engine.listEvents({ provider: 'github' });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.eventId).toBe('q_1');
  });
});

