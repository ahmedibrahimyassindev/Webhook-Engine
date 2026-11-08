// ---------------------------------------------------------------------------
// Testing utilities for consumers of node-webhook-engine.
// ---------------------------------------------------------------------------

import type { WebhookEvent, IngestRequest, IngestResult } from '../core/types.js';
import type { WebhookEngine } from '../core/engine.js';

/**
 * Creates a mock WebhookEvent object with sensible default fields.
 */
export function createMockWebhookEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  const eventId = overrides.eventId ?? `evt_${Math.random().toString(36).substring(2, 9)}`;
  const provider = overrides.provider ?? 'mock-provider';
  const type = overrides.type ?? 'test.event';
  const rawBody = overrides.rawBody ?? Buffer.from(JSON.stringify(overrides.data ?? { ok: true }));

  return {
    eventId,
    provider,
    type,
    data: overrides.data ?? { ok: true },
    headers: overrides.headers ?? { 'content-type': 'application/json' },
    rawBody,
    receivedAt: overrides.receivedAt ?? new Date(),
    status: overrides.status ?? 'PENDING',
    attempts: overrides.attempts ?? 0,
    metadata: overrides.metadata ?? {},
    lastAttemptAt: overrides.lastAttemptAt,
    lastError: overrides.lastError,
  };
}

/**
 * Helper to simulate an incoming webhook request through a WebhookEngine instance.
 */
export async function simulateWebhook(
  engine: WebhookEngine,
  options: {
    provider: string;
    type: string;
    id?: string;
    data?: unknown;
    headers?: Record<string, string>;
  },
): Promise<IngestResult> {
  const eventId = options.id ?? `evt_sim_${Date.now()}`;
  const payload = {
    id: eventId,
    type: options.type,
    data: options.data ?? {},
  };

  const rawBody = Buffer.from(JSON.stringify(payload), 'utf-8');

  const request: IngestRequest = {
    provider: options.provider,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
    rawBody,
  };

  return engine.ingest(request);
}
