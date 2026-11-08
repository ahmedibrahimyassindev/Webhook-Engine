// ---------------------------------------------------------------------------
// Tests – Event Processor
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventProcessor } from '../../src/processing/processor.js';
import { HandlerRegistry } from '../../src/processing/handler-registry.js';
import { RetryableError, PermanentError } from '../../src/core/errors.js';
import type { WebhookEvent } from '../../src/core/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: 'evt_001',
    provider: 'test',
    type: 'test.event',
    data: {},
    headers: {},
    rawBody: Buffer.from('{}'),
    receivedAt: new Date(),
    status: 'PROCESSING',
    attempts: 1,
    ...overrides,
  };
}

describe('EventProcessor', () => {
  let registry: HandlerRegistry;
  let processor: EventProcessor;

  beforeEach(() => {
    registry = new HandlerRegistry();
    processor = new EventProcessor(registry, {
      retryPolicy: { maxAttempts: 3 },
      processingTimeout: 5_000,
    });
  });

  it('returns success when handler completes', async () => {
    registry.register('test.event', async () => {});
    const result = await processor.process(makeEvent());
    expect(result.success).toBe(true);
  });

  it('returns success when no handlers are registered', async () => {
    const result = await processor.process(makeEvent());
    expect(result.success).toBe(true);
  });

  it('classifies RetryableError as retryable', async () => {
    registry.register('test.event', async () => {
      throw new RetryableError('transient');
    });

    const result = await processor.process(makeEvent({ attempts: 1 }));
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.nextRetryDelay).toBeGreaterThan(0);
  });

  it('classifies PermanentError as non-retryable', async () => {
    registry.register('test.event', async () => {
      throw new PermanentError('bad data');
    });

    const result = await processor.process(makeEvent());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.nextRetryDelay).toBeUndefined();
  });

  it('treats unknown errors as retryable', async () => {
    registry.register('test.event', async () => {
      throw new Error('unexpected');
    });

    const result = await processor.process(makeEvent({ attempts: 1 }));
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('stops retrying when maxAttempts is reached', async () => {
    registry.register('test.event', async () => {
      throw new RetryableError('still failing');
    });

    const result = await processor.process(makeEvent({ attempts: 3 }));
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('times out a slow handler', async () => {
    const shortTimeout = new EventProcessor(registry, { processingTimeout: 50 });

    registry.register('test.event', async () => {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const result = await shortTimeout.process(makeEvent({ attempts: 1 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.retryable).toBe(true);
  });

  it('runs multiple handlers sequentially', async () => {
    const order: number[] = [];
    registry.register('test.event', async () => { order.push(1); });
    registry.register('test.event', async () => { order.push(2); });

    await processor.process(makeEvent());
    expect(order).toEqual([1, 2]);
  });

  describe('getRetryInfo', () => {
    it('shouldRetry is true when under maxAttempts', () => {
      expect(processor.getRetryInfo(1).shouldRetry).toBe(true);
    });

    it('shouldRetry is false when at maxAttempts', () => {
      expect(processor.getRetryInfo(3).shouldRetry).toBe(false);
    });
  });
});

