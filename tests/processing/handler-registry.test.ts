// ---------------------------------------------------------------------------
// Tests – Handler Registry
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandlerRegistry } from '../../src/processing/handler-registry.js';
import type { EventHandler } from '../../src/core/types.js';

describe('HandlerRegistry', () => {
  let registry: HandlerRegistry;

  beforeEach(() => {
    registry = new HandlerRegistry();
  });

  it('registers and retrieves a handler for a specific type', () => {
    const handler: EventHandler = vi.fn();
    registry.register('payment.completed', handler);

    const handlers = registry.getHandlers('payment.completed');
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toBe(handler);
  });

  it('returns an empty array for an unregistered type', () => {
    expect(registry.getHandlers('unregistered')).toHaveLength(0);
  });

  it('supports multiple handlers per type', () => {
    const h1: EventHandler = vi.fn();
    const h2: EventHandler = vi.fn();
    registry.register('order.created', h1);
    registry.register('order.created', h2);

    expect(registry.getHandlers('order.created')).toHaveLength(2);
  });

  it('wildcard handler fires for all event types', () => {
    const wildcard: EventHandler = vi.fn();
    registry.register('*', wildcard);

    const forPayment = registry.getHandlers('payment.completed');
    const forOrder = registry.getHandlers('order.created');

    expect(forPayment).toContain(wildcard);
    expect(forOrder).toContain(wildcard);
  });

  it('type-specific handlers come before wildcard handlers', () => {
    const specific: EventHandler = vi.fn();
    const wildcard: EventHandler = vi.fn();
    registry.register('test.event', specific);
    registry.register('*', wildcard);

    const handlers = registry.getHandlers('test.event');
    expect(handlers[0]).toBe(specific);
    expect(handlers[1]).toBe(wildcard);
  });

  it('unregister removes handlers for a type', () => {
    registry.register('x', vi.fn());
    registry.unregister('x');
    expect(registry.getHandlers('x')).toHaveLength(0);
  });

  it('unregister("*") clears wildcard handlers', () => {
    registry.register('*', vi.fn());
    registry.unregister('*');
    expect(registry.getHandlers('anything')).toHaveLength(0);
  });

  it('hasHandler returns true when a handler exists', () => {
    registry.register('a', vi.fn());
    expect(registry.hasHandler('a')).toBe(true);
  });

  it('hasHandler returns true for wildcard coverage', () => {
    registry.register('*', vi.fn());
    expect(registry.hasHandler('any-type')).toBe(true);
  });

  it('hasHandler returns false with no handlers', () => {
    expect(registry.hasHandler('x')).toBe(false);
  });

  it('getRegisteredTypes returns explicit types', () => {
    registry.register('a', vi.fn());
    registry.register('b', vi.fn());
    registry.register('*', vi.fn());

    const types = registry.getRegisteredTypes().sort();
    expect(types).toEqual(['a', 'b']);
  });

  it('clear removes everything', () => {
    registry.register('a', vi.fn());
    registry.register('*', vi.fn());
    registry.clear();

    expect(registry.getHandlers('a')).toHaveLength(0);
    expect(registry.getRegisteredTypes()).toHaveLength(0);
  });
});

