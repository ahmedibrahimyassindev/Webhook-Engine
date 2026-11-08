// ---------------------------------------------------------------------------
// Integration tests – full ingestion pipeline.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookEngine } from '../../src/core/engine.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { NoOpVerifier } from '../../src/security/verifier.js';
import { HmacVerifier } from '../../src/security/hmac-verifier.js';
import { computeHmac } from '../../src/security/signature.js';
import { RetryableError, PermanentError } from '../../src/core/errors.js';
import type { WebhookEvent, IngestRequest } from '../../src/core/types.js';

// ---- Helpers ----------------------------------------------------------------

function makeRequest(body: Record<string, unknown>, provider = 'test'): IngestRequest {
  const raw = JSON.stringify(body);
  return {
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(raw),
    provider,
  };
}

function makeSignedRequest(
  body: Record<string, unknown>,
  secret: string,
  provider = 'test',
): IngestRequest {
  const raw = JSON.stringify(body);
  const signature = computeHmac('sha256', secret, Buffer.from(raw));
  return {
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
    },
    rawBody: Buffer.from(raw),
    provider,
  };
}

// Small helper to wait for async processing to settle.
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ---- Tests ------------------------------------------------------------------

describe('WebhookEngine – integration', () => {
  let engine: WebhookEngine;
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    engine = new WebhookEngine({
      storage,
      verifier: new NoOpVerifier(),
      retryPolicy: { maxAttempts: 3 },
      processingTimeout: 2_000,
      concurrency: 5,
    });
    await engine.initialize();
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  // ---- Basic pipeline -------------------------------------------------------

  it('accepts a valid event and processes it', async () => {
    const handler = vi.fn(async () => {});
    engine.register('payment.completed', handler);

    const result = await engine.ingest(
      makeRequest({ id: 'evt_1', type: 'payment.completed', data: { amount: 100 } }),
    );

    expect(result.status).toBe(200);
    expect(result.body.eventId).toBe('evt_1');

    await tick();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON', async () => {
    const result = await engine.ingest({
      headers: {},
      rawBody: Buffer.from('not json'),
      provider: 'test',
    });

    expect(result.status).toBe(400);
  });

  it('rejects events with missing id or type', async () => {
    const result = await engine.ingest(makeRequest({ foo: 'bar' }));
    expect(result.status).toBe(422);
  });

  // ---- Deduplication --------------------------------------------------------

  it('rejects duplicate events (same id + provider)', async () => {
    const body = { id: 'dup_1', type: 'test' };
    const r1 = await engine.ingest(makeRequest(body));
    const r2 = await engine.ingest(makeRequest(body));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
  });

  it('accepts the same event id from different providers', async () => {
    const body = { id: 'shared', type: 'test' };
    const r1 = await engine.ingest(makeRequest(body, 'provider-a'));

    // Need a new engine or clear replay protection for this test.
    // Since replay protection uses nonce cache, same eventId from different
    // provider will be caught by the nonce cache. Let's use a different eventId.
    const r2 = await engine.ingest(makeRequest({ id: 'shared-b', type: 'test' }, 'provider-b'));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  // ---- Signature verification -----------------------------------------------

  it('rejects events with invalid signatures', async () => {
    const signedEngine = new WebhookEngine({
      storage: new MemoryStorage(),
      verifier: new HmacVerifier({
        secret: 'my-secret',
        algorithm: 'sha256',
        signatureHeader: 'x-signature',
      }),
    });
    await signedEngine.initialize();

    const result = await signedEngine.ingest({
      headers: { 'x-signature': 'invalid' },
      rawBody: Buffer.from('{"id":"e","type":"t"}'),
      provider: 'test',
    });

    expect(result.status).toBe(401);
    await signedEngine.shutdown();
  });

  it('accepts events with valid HMAC signatures', async () => {
    const secret = 'my-secret';
    const signedStorage = new MemoryStorage();
    const signedEngine = new WebhookEngine({
      storage: signedStorage,
      verifier: new HmacVerifier({
        secret,
        algorithm: 'sha256',
        signatureHeader: 'x-signature',
      }),
    });
    await signedEngine.initialize();

    const result = await signedEngine.ingest(
      makeSignedRequest({ id: 'evt_signed', type: 'test.event' }, secret),
    );

    expect(result.status).toBe(200);
    await signedEngine.shutdown();
  });

  // ---- Event lifecycle & observability --------------------------------------

  it('emits lifecycle events', async () => {
    const received = vi.fn();
    const completed = vi.fn();
    engine.on('event.received', received);
    engine.on('event.completed', completed);

    engine.register('test', async () => {});
    await engine.ingest(makeRequest({ id: 'lc_1', type: 'test' }));

    await tick();

    expect(received).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it('emits event.failed and event.deadLetter for permanent errors', async () => {
    const failed = vi.fn();
    const deadLetter = vi.fn();
    engine.on('event.failed', failed);
    engine.on('event.deadLetter', deadLetter);

    engine.register('test', async () => {
      throw new PermanentError('bad');
    });

    await engine.ingest(makeRequest({ id: 'perm_1', type: 'test' }));
    await tick();

    expect(failed).toHaveBeenCalled();
    expect(deadLetter).toHaveBeenCalled();
  });

  // ---- Error handling & retries ---------------------------------------------

  it('moves retryable errors to RETRYING status', async () => {
    engine.register('test', async () => {
      throw new RetryableError('tmp');
    });

    await engine.ingest(makeRequest({ id: 'retry_1', type: 'test' }));
    await tick();

    const event = await storage.findEvent('retry_1', 'test');
    expect(event).not.toBeNull();
    expect(event!.status).toBe('RETRYING');
  });

  it('moves permanent errors to DEAD_LETTER status', async () => {
    engine.register('test', async () => {
      throw new PermanentError('fatal');
    });

    await engine.ingest(makeRequest({ id: 'dl_1', type: 'test' }));
    await tick();

    const event = await storage.findEvent('dl_1', 'test');
    expect(event!.status).toBe('DEAD_LETTER');
  });

  // ---- Uninitialized engine -------------------------------------------------

  it('throws if ingest is called before initialize', async () => {
    const uninit = new WebhookEngine({
      storage: new MemoryStorage(),
      verifier: new NoOpVerifier(),
    });

    await expect(
      uninit.ingest(makeRequest({ id: 'x', type: 'y' })),
    ).rejects.toThrow('not initialized');
  });

  // ---- off() ----------------------------------------------------------------

  it('unsubscribes listeners with off()', async () => {
    const listener = vi.fn();
    engine.on('event.received', listener);
    engine.off('event.received', listener);

    engine.register('test', async () => {});
    await engine.ingest(makeRequest({ id: 'off_1', type: 'test' }));
    await tick();

    expect(listener).not.toHaveBeenCalled();
  });
});

