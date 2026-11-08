// ---------------------------------------------------------------------------
// Event handler registry.
// ---------------------------------------------------------------------------

import type { EventHandler } from '../core/types.js';

/**
 * Manages the mapping from event types to their handlers.
 *
 * - Register handlers for specific event types (`"payment.completed"`).
 * - Register wildcard handlers (`"*"`) that fire for every event.
 * - When an event is processed, type-specific handlers run first, followed by
 *   wildcard handlers.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly wildcardHandlers: EventHandler[] = [];

  /**
   * Register a handler for a specific event type.
   * Use `"*"` to register a wildcard handler that receives all events.
   */
  register(eventType: string, handler: EventHandler): void {
    if (eventType === '*') {
      this.wildcardHandlers.push(handler);
      return;
    }
    const existing = this.handlers.get(eventType);
    if (existing) {
      existing.push(handler);
    } else {
      this.handlers.set(eventType, [handler]);
    }
  }

  /**
   * Remove **all** handlers for a specific event type.
   * Pass `"*"` to remove all wildcard handlers.
   */
  unregister(eventType: string): void {
    if (eventType === '*') {
      this.wildcardHandlers.length = 0;
      return;
    }
    this.handlers.delete(eventType);
  }

  /**
   * Return all handlers that match the given event type, in execution order:
   * type-specific handlers first, then wildcard handlers.
   */
  getHandlers(eventType: string): EventHandler[] {
    const typed = this.handlers.get(eventType) ?? [];
    return [...typed, ...this.wildcardHandlers];
  }

  /** Check whether at least one handler would fire for the given event type. */
  hasHandler(eventType: string): boolean {
    return (this.handlers.get(eventType)?.length ?? 0) > 0 || this.wildcardHandlers.length > 0;
  }

  /** Return all explicitly registered event type strings (excluding `"*"`). */
  getRegisteredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.length = 0;
  }
}

