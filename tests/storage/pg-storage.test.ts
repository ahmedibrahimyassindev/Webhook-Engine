// ---------------------------------------------------------------------------
// Tests – PostgresStorageAdapter
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresStorageAdapter, type PgQueryable } from '../../src/storage/pg-storage.js';
import { DuplicateEventError } from '../../src/core/errors.js';
import type { WebhookEvent } from '../../src/core/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: 'pg_evt_1',
    provider: 'stripe',
    type: 'payment.success',
    data: { amount: 2000 },
    headers: { 'user-agent': 'stripe' },
    rawBody: Buffer.from('{"amount":2000}'),
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'PENDING',
    attempts: 0,
    metadata: { env: 'production' },
    ...overrides,
  };
}

describe('PostgresStorageAdapter', () => {
  let mockPool: PgQueryable;
  let adapter: PostgresStorageAdapter;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    };
    adapter = new PostgresStorageAdapter({ pool: mockPool });
  });

  it('runs migrations on initialize when autoMigrate is true', async () => {
    await adapter.initialize();
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
  });

  it('stores an event into postgres', async () => {
    const event = makeEvent();
    (mockPool.query as any).mockResolvedValueOnce({ rows: [{ event_id: event.eventId }], rowCount: 1 });

    await adapter.storeEvent(event);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_events'),
      expect.arrayContaining([event.eventId, event.provider, event.type]),
    );
  });

  it('throws DuplicateEventError when ON CONFLICT yields rowCount 0', async () => {
    const event = makeEvent();
    (mockPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(adapter.storeEvent(event)).rejects.toThrow(DuplicateEventError);
  });

  it('finds an event and deserializes fields correctly', async () => {
    const event = makeEvent();
    (mockPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          event_id: event.eventId,
          provider: event.provider,
          type: event.type,
          data: JSON.stringify(event.data),
          headers: JSON.stringify(event.headers),
          raw_body: event.rawBody,
          received_at: event.receivedAt.toISOString(),
          status: 'PENDING',
          attempts: 0,
          metadata: JSON.stringify(event.metadata),
        },
      ],
      rowCount: 1,
    });

    const found = await adapter.findEvent('pg_evt_1', 'stripe');
    expect(found).not.toBeNull();
    expect(found?.eventId).toBe('pg_evt_1');
    expect(found?.data).toEqual({ amount: 2000 });
  });

  it('returns null when event is not found', async () => {
    (mockPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const found = await adapter.findEvent('missing', 'stripe');
    expect(found).toBeNull();
  });

  it('claims an event with atomic row update', async () => {
    (mockPool.query as any).mockResolvedValueOnce({ rows: [{ event_id: 'pg_evt_1' }], rowCount: 1 });

    const claimed = await adapter.claimEvent('pg_evt_1', 'stripe');
    expect(claimed).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE event_id = $2'),
      expect.anything(),
    );
  });

  it('returns false if event is already claimed by another worker', async () => {
    (mockPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const claimed = await adapter.claimEvent('pg_evt_1', 'stripe');
    expect(claimed).toBe(false);
  });

  it('releases an event', async () => {
    await adapter.releaseEvent('pg_evt_1', 'stripe');
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('locked_by = NULL'),
      ['pg_evt_1', 'stripe'],
    );
  });

  it('updates event status and error', async () => {
    await adapter.updateEventStatus('pg_evt_1', 'stripe', 'FAILED', 'Connection error');
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $1'),
      ['FAILED', 'Connection error', 'pg_evt_1', 'stripe'],
    );
  });
});
