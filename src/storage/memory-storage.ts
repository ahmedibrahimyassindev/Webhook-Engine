// ---------------------------------------------------------------------------
// In-memory storage adapter – for development and testing only.
// ---------------------------------------------------------------------------

import type { StorageAdapter, WebhookEvent, EventStatus, DeadLetterFilter, EventQueryFilter } from '../core/types.js';
import { DuplicateEventError } from '../core/errors.js';

/**
 * A non-persistent {@link StorageAdapter} that holds events in memory.
 *
 * > **Warning** – All data is lost when the process exits.
 * > Use a persistent adapter (PostgreSQL, MySQL, etc.) in production.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly events = new Map<string, WebhookEvent>();
  private readonly claimed = new Set<string>();

  async initialize(): Promise<void> {
    // No-op – nothing to connect to.
  }

  async shutdown(): Promise<void> {
    this.events.clear();
    this.claimed.clear();
  }

  async storeEvent(event: WebhookEvent): Promise<void> {
    const key = this.key(event.eventId, event.provider);
    if (this.events.has(key)) {
      throw new DuplicateEventError(event.eventId);
    }
    // Store a defensive copy.
    this.events.set(key, { ...event });
  }

  async findEvent(eventId: string, provider: string): Promise<WebhookEvent | null> {
    const event = this.events.get(this.key(eventId, provider));
    return event ? { ...event } : null;
  }

  async updateEventStatus(
    eventId: string,
    provider: string,
    status: EventStatus,
    error?: string,
  ): Promise<void> {
    const event = this.events.get(this.key(eventId, provider));
    if (!event) {
      throw new Error(`Event not found: ${eventId} (provider: ${provider})`);
    }
    event.status = status;
    if (error !== undefined) {
      event.lastError = error;
    }
    if (status === 'PROCESSING' || status === 'RETRYING') {
      event.lastAttemptAt = new Date();
    }
  }

  async claimEvent(eventId: string, provider: string): Promise<boolean> {
    const key = this.key(eventId, provider);
    if (this.claimed.has(key) || !this.events.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }

  async releaseEvent(eventId: string, provider: string): Promise<void> {
    this.claimed.delete(this.key(eventId, provider));
  }

  async getRetryableEvents(): Promise<WebhookEvent[]> {
    const results: WebhookEvent[] = [];
    for (const event of this.events.values()) {
      if (event.status === 'FAILED' || event.status === 'RETRYING') {
        results.push({ ...event });
      }
    }
    return results;
  }

  async getDeadLetterEvents(filter?: DeadLetterFilter): Promise<WebhookEvent[]> {
    const results: WebhookEvent[] = [];
    for (const event of this.events.values()) {
      if (event.status !== 'DEAD_LETTER') continue;
      if (filter?.provider && event.provider !== filter.provider) continue;
      if (filter?.eventType && event.type !== filter.eventType) continue;
      if (filter?.since && event.receivedAt < filter.since) continue;
      results.push({ ...event });
      if (filter?.limit && results.length >= filter.limit) break;
    }
    return results;
  }

  async queryEvents(filter: EventQueryFilter): Promise<WebhookEvent[]> {
    let results: WebhookEvent[] = [];
    for (const event of this.events.values()) {
      if (filter.provider && event.provider !== filter.provider) continue;
      if (filter.status && event.status !== filter.status) continue;
      if (filter.eventType && event.type !== filter.eventType) continue;
      results.push({ ...event });
    }

    if (filter.offset && filter.offset > 0) {
      results = results.slice(filter.offset);
    }
    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  // ---- Testing helpers ----

  /** Return all stored events (shallow copies). */
  getAllEvents(): WebhookEvent[] {
    return [...this.events.values()].map((e) => ({ ...e }));
  }

  /** Clear all data. */
  clear(): void {
    this.events.clear();
    this.claimed.clear();
  }

  // ---- Private ----

  private key(eventId: string, provider: string): string {
    return `${provider}:${eventId}`;
  }
}

