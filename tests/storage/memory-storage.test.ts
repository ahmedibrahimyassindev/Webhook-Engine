// ---------------------------------------------------------------------------
// Tests – Memory Storage
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { DuplicateEventError } from '../../src/core/errors.js';
import type { WebhookEvent } from '../../src/core/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: 'evt_001',
    provider: 'test-provider',
    type: 'test.event',
    data: { key: 'value' },
    headers: {},
    rawBody: Buffer.from('{}'),
    receivedAt: new Date(),
    status: 'PENDING',
    attempts: 0,
    ...overrides,
  };
}

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.initialize();
  });

  describe('storeEvent / findEvent', () => {
    it('stores and retrieves an event', async () => {
      const event = makeEvent();
      await storage.storeEvent(event);

      const found = await storage.findEvent('evt_001', 'test-provider');
      expect(found).not.toBeNull();
      expect(found!.eventId).toBe('evt_001');
      expect(found!.data).toEqual({ key: 'value' });
    });

    it('returns null for a non-existent event', async () => {
      const found = await storage.findEvent('missing', 'test-provider');
      expect(found).toBeNull();
    });

    it('throws DuplicateEventError on duplicate eventId+provider', async () => {
      await storage.storeEvent(makeEvent());
      await expect(storage.storeEvent(makeEvent())).rejects.toThrow(DuplicateEventError);
    });

    it('allows same eventId with different providers', async () => {
      await storage.storeEvent(makeEvent({ provider: 'provider-a' }));
      await expect(
        storage.storeEvent(makeEvent({ provider: 'provider-b' })),
      ).resolves.not.toThrow();
    });

    it('returns a defensive copy (mutations do not affect storage)', async () => {
      await storage.storeEvent(makeEvent());
      const found = await storage.findEvent('evt_001', 'test-provider');
      found!.eventId = 'mutated';

      const fresh = await storage.findEvent('evt_001', 'test-provider');
      expect(fresh!.eventId).toBe('evt_001');
    });
  });

  describe('updateEventStatus', () => {
    it('updates the status', async () => {
      await storage.storeEvent(makeEvent());
      await storage.updateEventStatus('evt_001', 'test-provider', 'PROCESSING');

      const found = await storage.findEvent('evt_001', 'test-provider');
      expect(found!.status).toBe('PROCESSING');
    });

    it('updates the error message', async () => {
      await storage.storeEvent(makeEvent());
      await storage.updateEventStatus('evt_001', 'test-provider', 'FAILED', 'boom');

      const found = await storage.findEvent('evt_001', 'test-provider');
      expect(found!.lastError).toBe('boom');
    });

    it('throws for a non-existent event', async () => {
      await expect(
        storage.updateEventStatus('missing', 'test-provider', 'FAILED'),
      ).rejects.toThrow('Event not found');
    });
  });

  describe('claimEvent / releaseEvent', () => {
    it('claims an unclaimed event', async () => {
      await storage.storeEvent(makeEvent());
      const claimed = await storage.claimEvent('evt_001', 'test-provider');
      expect(claimed).toBe(true);
    });

    it('rejects a second claim', async () => {
      await storage.storeEvent(makeEvent());
      await storage.claimEvent('evt_001', 'test-provider');
      expect(await storage.claimEvent('evt_001', 'test-provider')).toBe(false);
    });

    it('allows reclaiming after release', async () => {
      await storage.storeEvent(makeEvent());
      await storage.claimEvent('evt_001', 'test-provider');
      await storage.releaseEvent('evt_001', 'test-provider');
      expect(await storage.claimEvent('evt_001', 'test-provider')).toBe(true);
    });

    it('returns false for a non-existent event', async () => {
      expect(await storage.claimEvent('missing', 'x')).toBe(false);
    });
  });

  describe('getRetryableEvents', () => {
    it('returns FAILED and RETRYING events', async () => {
      await storage.storeEvent(makeEvent({ eventId: 'e1', status: 'FAILED' }));
      await storage.storeEvent(makeEvent({ eventId: 'e2', status: 'RETRYING' }));
      await storage.storeEvent(makeEvent({ eventId: 'e3', status: 'COMPLETED' }));

      const retryable = await storage.getRetryableEvents();
      const ids = retryable.map((e) => e.eventId).sort();
      expect(ids).toEqual(['e1', 'e2']);
    });
  });

  describe('getDeadLetterEvents', () => {
    it('returns only DEAD_LETTER events', async () => {
      await storage.storeEvent(makeEvent({ eventId: 'e1', status: 'DEAD_LETTER' }));
      await storage.storeEvent(makeEvent({ eventId: 'e2', status: 'COMPLETED' }));

      const dead = await storage.getDeadLetterEvents();
      expect(dead).toHaveLength(1);
      expect(dead[0]!.eventId).toBe('e1');
    });

    it('filters by provider', async () => {
      await storage.storeEvent(makeEvent({ eventId: 'e1', status: 'DEAD_LETTER', provider: 'a' }));
      await storage.storeEvent(makeEvent({ eventId: 'e2', status: 'DEAD_LETTER', provider: 'b' }));

      const dead = await storage.getDeadLetterEvents({ provider: 'a' });
      expect(dead).toHaveLength(1);
      expect(dead[0]!.provider).toBe('a');
    });

    it('respects the limit', async () => {
      await storage.storeEvent(makeEvent({ eventId: 'e1', status: 'DEAD_LETTER' }));
      await storage.storeEvent(makeEvent({ eventId: 'e2', status: 'DEAD_LETTER' }));
      await storage.storeEvent(makeEvent({ eventId: 'e3', status: 'DEAD_LETTER' }));

      const dead = await storage.getDeadLetterEvents({ limit: 2 });
      expect(dead).toHaveLength(2);
    });
  });

  describe('clear / shutdown', () => {
    it('removes all data on clear', async () => {
      await storage.storeEvent(makeEvent());
      storage.clear();
      expect(await storage.findEvent('evt_001', 'test-provider')).toBeNull();
    });

    it('removes all data on shutdown', async () => {
      await storage.storeEvent(makeEvent());
      await storage.shutdown();
      expect(storage.getAllEvents()).toHaveLength(0);
    });
  });
});

