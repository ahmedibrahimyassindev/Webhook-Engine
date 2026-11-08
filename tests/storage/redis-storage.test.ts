// ---------------------------------------------------------------------------
// Tests – RedisStorageAdapter and RedisLockManager
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStorageAdapter, RedisLockManager, type RedisClient } from '../../src/storage/redis-storage.js';
import { DuplicateEventError } from '../../src/core/errors.js';
import type { WebhookEvent } from '../../src/core/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: 'redis_evt_1',
    provider: 'github',
    type: 'push',
    data: { ref: 'main' },
    headers: { 'x-github-event': 'push' },
    rawBody: Buffer.from('{"ref":"main"}'),
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'PENDING',
    attempts: 0,
    metadata: {},
    ...overrides,
  };
}

describe('RedisLockManager', () => {
  let mockClient: RedisClient;
  let lockManager: RedisLockManager;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      eval: vi.fn(async () => 1),
    };
    lockManager = new RedisLockManager(mockClient);
  });

  it('acquires a distributed lock', async () => {
    const token = await lockManager.acquire('res_1', 10_000);
    expect(token).not.toBeNull();
    expect(mockClient.set).toHaveBeenCalledWith(
      'webhook:lock:res_1',
      token,
      'PX',
      10_000,
      'NX',
    );
  });

  it('fails to acquire when lock is already held', async () => {
    (mockClient.set as any).mockResolvedValueOnce(null);
    const token = await lockManager.acquire('res_1');
    expect(token).toBeNull();
  });

  it('releases lock using Lua script', async () => {
    const released = await lockManager.release('res_1', 'my-token');
    expect(released).toBe(true);
    expect(mockClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1])'),
      1,
      'webhook:lock:res_1',
      'my-token',
    );
  });
});

describe('RedisStorageAdapter', () => {
  let mockClient: RedisClient;
  let adapter: RedisStorageAdapter;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      eval: vi.fn(async () => 1),
      keys: vi.fn(async () => []),
    };
    adapter = new RedisStorageAdapter({ client: mockClient });
  });

  it('stores an event with atomic SET NX', async () => {
    const event = makeEvent();
    await adapter.storeEvent(event);
    expect(mockClient.set).toHaveBeenCalledWith(
      'webhook:event:github:redis_evt_1',
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('throws DuplicateEventError when SET NX returns null', async () => {
    const event = makeEvent();
    (mockClient.set as any).mockResolvedValueOnce(null);
    await expect(adapter.storeEvent(event)).rejects.toThrow(DuplicateEventError);
  });

  it('finds and deserializes an event', async () => {
    const event = makeEvent();
    (mockClient.get as any).mockResolvedValueOnce(
      JSON.stringify({
        ...event,
        rawBody: event.rawBody.toString('base64'),
        receivedAt: event.receivedAt.toISOString(),
      }),
    );

    const found = await adapter.findEvent('redis_evt_1', 'github');
    expect(found).not.toBeNull();
    expect(found?.eventId).toBe('redis_evt_1');
    expect(found?.data).toEqual({ ref: 'main' });
  });

  it('claims an event via distributed lock', async () => {
    (mockClient.set as any).mockResolvedValueOnce('OK');
    const claimed = await adapter.claimEvent('redis_evt_1', 'github');
    expect(claimed).toBe(true);
  });

  it('releases claimed event', async () => {
    (mockClient.set as any).mockResolvedValueOnce('OK');
    await adapter.claimEvent('redis_evt_1', 'github');
    await adapter.releaseEvent('redis_evt_1', 'github');
    expect(mockClient.eval).toHaveBeenCalled();
  });
});

