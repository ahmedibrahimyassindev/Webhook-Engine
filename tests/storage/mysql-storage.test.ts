// ---------------------------------------------------------------------------
// Tests – MysqlStorageAdapter
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MysqlStorageAdapter, type MysqlQueryable } from '../../src/storage/mysql-storage.js';
import { DuplicateEventError } from '../../src/core/errors.js';
import type { WebhookEvent } from '../../src/core/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: 'mysql_evt_1',
    provider: 'shopify',
    type: 'orders.create',
    data: { id: 123 },
    headers: { 'x-shopify-topic': 'orders/create' },
    rawBody: Buffer.from('{"id":123}'),
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'PENDING',
    attempts: 0,
    metadata: {},
    ...overrides,
  };
}

describe('MysqlStorageAdapter', () => {
  let mockPool: MysqlQueryable;
  let adapter: MysqlStorageAdapter;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(async () => [[], null]),
    };
    adapter = new MysqlStorageAdapter({ pool: mockPool });
  });

  it('runs migrations on initialize', async () => {
    await adapter.initialize();
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
  });

  it('stores an event into MySQL', async () => {
    const event = makeEvent();
    (mockPool.query as any).mockResolvedValueOnce([{ affectedRows: 1 }, null]);

    await adapter.storeEvent(event);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_events'),
      expect.arrayContaining([event.eventId, event.provider, event.type]),
    );
  });

  it('throws DuplicateEventError on duplicate entry error (code ER_DUP_ENTRY)', async () => {
    const event = makeEvent();
    const dupErr: any = new Error('Duplicate entry');
    dupErr.code = 'ER_DUP_ENTRY';
    dupErr.errno = 1062;
    (mockPool.query as any).mockRejectedValueOnce(dupErr);

    await expect(adapter.storeEvent(event)).rejects.toThrow(DuplicateEventError);
  });

  it('finds an event and returns parsed model', async () => {
    const event = makeEvent();
    (mockPool.query as any).mockResolvedValueOnce([
      [
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
      null,
    ]);

    const found = await adapter.findEvent('mysql_evt_1', 'shopify');
    expect(found).not.toBeNull();
    expect(found?.eventId).toBe('mysql_evt_1');
    expect(found?.data).toEqual({ id: 123 });
  });

  it('claims an event when available', async () => {
    (mockPool.query as any).mockResolvedValueOnce([{ affectedRows: 1 }, null]);

    const claimed = await adapter.claimEvent('mysql_evt_1', 'shopify');
    expect(claimed).toBe(true);
  });

  it('fails to claim when already locked', async () => {
    (mockPool.query as any).mockResolvedValueOnce([{ affectedRows: 0 }, null]);

    const claimed = await adapter.claimEvent('mysql_evt_1', 'shopify');
    expect(claimed).toBe(false);
  });

  it('releases an event', async () => {
    await adapter.releaseEvent('mysql_evt_1', 'shopify');
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('locked_by = NULL'),
      ['mysql_evt_1', 'shopify'],
    );
  });
});
