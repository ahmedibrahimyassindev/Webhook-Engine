// ---------------------------------------------------------------------------
// Performance Benchmark – Ingestion & Deduplication Throughput
// ---------------------------------------------------------------------------

import { bench, describe } from 'vitest';
import { WebhookEngine } from '../src/core/engine.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import { NoOpVerifier } from '../src/security/verifier.js';
import { computeHmac } from '../src/security/signature.js';
import { HmacVerifier } from '../src/security/hmac-verifier.js';

describe('Webhook Engine Throughput', async () => {
  const engine = new WebhookEngine({
    storage: new MemoryStorage(),
    verifier: new NoOpVerifier(),
  });
  await engine.initialize();
  engine.register('benchmark.event', async () => {});

  let count = 0;

  bench('ingest throughput (no-op verifier)', async () => {
    count++;
    await engine.ingest({
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(`{"id":"bench_${count}","type":"benchmark.event","count":${count}}`),
      provider: 'benchmark',
    });
  });

  const secret = 'bench-secret-key-12345';
  const signedEngine = new WebhookEngine({
    storage: new MemoryStorage(),
    verifier: new HmacVerifier({
      secret,
      algorithm: 'sha256',
      signatureHeader: 'x-signature',
    }),
  });
  await signedEngine.initialize();
  signedEngine.register('benchmark.signed', async () => {});

  let signedCount = 0;

  bench('ingest throughput with HMAC verification', async () => {
    signedCount++;
    const rawBody = Buffer.from(`{"id":"signed_${signedCount}","type":"benchmark.signed"}`);
    const sig = computeHmac('sha256', secret, rawBody);
    await signedEngine.ingest({
      headers: {
        'content-type': 'application/json',
        'x-signature': sig,
      },
      rawBody,
      provider: 'benchmark',
    });
  });
});

