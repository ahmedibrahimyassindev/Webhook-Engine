// ---------------------------------------------------------------------------
// Redis distributed lock coordinator and storage adapter.
// ---------------------------------------------------------------------------

import type {
  StorageAdapter,
  WebhookEvent,
  EventStatus,
  DeadLetterFilter,
  EventQueryFilter,
} from '../core/types.js';
import { DuplicateEventError } from '../core/errors.js';

/**
 * Minimal interface compatible with `ioredis` or `node-redis`.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number, flag?: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  hgetall?(key: string): Promise<Record<string, string>>;
  hset?(key: string, ...args: unknown[]): Promise<unknown>;
  keys?(pattern: string): Promise<string[]>;
}

/**
 * Safe Lua script for atomic distributed lock release.
 * Releases the lock only if the token stored matches the caller's token.
 */
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Distributed lock manager using Redis `SET key token PX ttl NX`
 * with safe atomic Lua release.
 */
export class RedisLockManager {
  private readonly client: RedisClient;
  private readonly prefix: string;

  constructor(client: RedisClient, prefix = 'webhook:lock:') {
    this.client = client;
    this.prefix = prefix;
  }

  /**
   * Attempt to acquire a distributed lock.
   * Returns a secret token if acquired, or `null` if the lock is held.
   */
  async acquire(resourceKey: string, ttlMs = 30_000): Promise<string | null> {
    const token = `${Math.random().toString(36).substring(2)}_${Date.now()}`;
    const fullKey = `${this.prefix}${resourceKey}`;

    // SET key value PX ttl NX
    const result = await this.client.set(fullKey, token, 'PX', ttlMs, 'NX');
    const acquired = result === 'OK' || result === true;
    return acquired ? token : null;
  }

  /**
   * Atomically release a held distributed lock.
   */
  async release(resourceKey: string, token: string): Promise<boolean> {
    const fullKey = `${this.prefix}${resourceKey}`;
    const res = await this.client.eval(RELEASE_LOCK_LUA, 1, fullKey, token);
    return Number(res) === 1;
  }
}

/**
 * Options for {@link RedisStorageAdapter}.
 */
export interface RedisStorageOptions {
  client: RedisClient;
  /** Key prefix (default `"webhook:"`). */
  keyPrefix?: string;
  /** Default TTL in milliseconds for deduplication keys (default 7 days). */
  dedupTtlMs?: number;
  /** Distributed claim lock timeout in ms (default 60 000 = 60s). */
  lockTimeoutMs?: number;
}

/**
 * Storage adapter backed by Redis for high-throughput, low-latency webhook ingestion
 * and distributed lock coordination.
 */
export class RedisStorageAdapter implements StorageAdapter {
  private readonly client: RedisClient;
  private readonly prefix: string;
  private readonly lockManager: RedisLockManager;
  private readonly lockTimeoutMs: number;
  private readonly heldLocks = new Map<string, string>(); // resource -> token

  constructor(options: RedisStorageOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'webhook:';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.lockManager = new RedisLockManager(this.client, `${this.prefix}lock:`);
  }

  async initialize(): Promise<void> {
    // Redis connection is typically pre-managed
  }

  async shutdown(): Promise<void> {
    // Release any remaining locks held by this process
    for (const [key, token] of this.heldLocks.entries()) {
      await this.lockManager.release(key, token).catch(() => {});
    }
    this.heldLocks.clear();
  }

  async storeEvent(event: WebhookEvent): Promise<void> {
    const eventKey = this.eventKey(event.eventId, event.provider);
    const serialized = JSON.stringify({
      ...event,
      rawBody: event.rawBody.toString('base64'),
      receivedAt: event.receivedAt.toISOString(),
      lastAttemptAt: event.lastAttemptAt?.toISOString(),
    });

    // Atomic SET NX: returns OK only if key didn't exist before
    const res = await this.client.set(eventKey, serialized, 'PX', 7 * 86_400_000, 'NX');
    const inserted = res === 'OK' || res === true;

    if (!inserted) {
      throw new DuplicateEventError(event.eventId);
    }
  }

  async findEvent(eventId: string, provider: string): Promise<WebhookEvent | null> {
    const data = await this.client.get(this.eventKey(eventId, provider));
    if (!data) return null;
    return this.deserializeEvent(data);
  }

  async updateEventStatus(
    eventId: string,
    provider: string,
    status: EventStatus,
    error?: string,
  ): Promise<void> {
    const event = await this.findEvent(eventId, provider);
    if (!event) return;

    event.status = status;
    if (error !== undefined) {
      event.lastError = error;
    }
    if (status === 'PROCESSING' || status === 'RETRYING') {
      event.lastAttemptAt = new Date();
    }

    const eventKey = this.eventKey(eventId, provider);
    const serialized = JSON.stringify({
      ...event,
      rawBody: event.rawBody.toString('base64'),
      receivedAt: event.receivedAt.toISOString(),
      lastAttemptAt: event.lastAttemptAt?.toISOString(),
    });

    await this.client.set(eventKey, serialized);
  }

  async claimEvent(eventId: string, provider: string): Promise<boolean> {
    const resource = `${provider}:${eventId}`;
    const token = await this.lockManager.acquire(resource, this.lockTimeoutMs);
    if (!token) return false;

    this.heldLocks.set(resource, token);
    return true;
  }

  async releaseEvent(eventId: string, provider: string): Promise<void> {
    const resource = `${provider}:${eventId}`;
    const token = this.heldLocks.get(resource);
    if (token) {
      await this.lockManager.release(resource, token);
      this.heldLocks.delete(resource);
    }
  }

  async getRetryableEvents(): Promise<WebhookEvent[]> {
    if (!this.client.keys) return [];
    const keys = await this.client.keys(`${this.prefix}event:*`);
    const results: WebhookEvent[] = [];

    for (const key of keys) {
      const data = await this.client.get(key);
      if (!data) continue;
      const event = this.deserializeEvent(data);
      if (event.status === 'FAILED' || event.status === 'RETRYING') {
        results.push(event);
      }
    }

    return results;
  }

  async getDeadLetterEvents(filter?: DeadLetterFilter): Promise<WebhookEvent[]> {
    if (!this.client.keys) return [];
    const keys = await this.client.keys(`${this.prefix}event:*`);
    const results: WebhookEvent[] = [];

    for (const key of keys) {
      const data = await this.client.get(key);
      if (!data) continue;
      const event = this.deserializeEvent(data);
      if (event.status !== 'DEAD_LETTER') continue;
      if (filter?.provider && event.provider !== filter.provider) continue;
      if (filter?.eventType && event.type !== filter.eventType) continue;
      if (filter?.since && event.receivedAt < filter.since) continue;
      results.push(event);
      if (filter?.limit && results.length >= filter.limit) break;
    }

    return results;
  }

  async queryEvents(filter: EventQueryFilter): Promise<WebhookEvent[]> {
    if (!this.client.keys) return [];
    const keys = await this.client.keys(`${this.prefix}event:*`);
    let results: WebhookEvent[] = [];

    for (const key of keys) {
      const data = await this.client.get(key);
      if (!data) continue;
      const event = this.deserializeEvent(data);
      if (filter.provider && event.provider !== filter.provider) continue;
      if (filter.status && event.status !== filter.status) continue;
      if (filter.eventType && event.type !== filter.eventType) continue;
      results.push(event);
    }

    if (filter.offset) {
      results = results.slice(filter.offset);
    }
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  private eventKey(eventId: string, provider: string): string {
    return `${this.prefix}event:${provider}:${eventId}`;
  }

  private deserializeEvent(json: string): WebhookEvent {
    const raw = JSON.parse(json);
    return {
      ...raw,
      rawBody: Buffer.from(raw.rawBody, 'base64'),
      receivedAt: new Date(raw.receivedAt),
      lastAttemptAt: raw.lastAttemptAt ? new Date(raw.lastAttemptAt) : undefined,
    };
  }
}

