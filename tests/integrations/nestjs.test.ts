// ---------------------------------------------------------------------------
// Tests – NestJS Integration
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import {
  WebhookService,
  createWebhookProviders,
  WEBHOOK_ENGINE,
  WEBHOOK_ENGINE_OPTIONS,
} from '../../src/integrations/nestjs/index.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { NoOpVerifier } from '../../src/security/verifier.js';

describe('NestJS Integration', () => {
  it('creates provider definition array', () => {
    const options = {
      storage: new MemoryStorage(),
      verifier: new NoOpVerifier(),
    };

    const providers = createWebhookProviders(options);
    expect(providers).toHaveLength(3);

    const optionsProvider = providers.find((p) => p.provide === WEBHOOK_ENGINE_OPTIONS);
    expect(optionsProvider).toBeDefined();

    const engineProvider = providers.find((p) => p.provide === WEBHOOK_ENGINE);
    expect(engineProvider).toBeDefined();

    const serviceProvider = providers.find((p) => p.provide === WebhookService);
    expect(serviceProvider).toBeDefined();
  });

  it('WebhookService wraps engine register and ingest calls', async () => {
    const mockEngine = {
      register: vi.fn(),
      ingest: vi.fn(async () => ({ status: 200, body: { message: 'ok' } })),
    } as any;

    const service = new WebhookService(mockEngine);
    const handler = async () => {};

    service.register('user.created', handler);
    expect(mockEngine.register).toHaveBeenCalledWith('user.created', handler);

    const req = { headers: {}, rawBody: Buffer.from('{}'), provider: 'test' };
    const res = await service.ingest(req);
    expect(mockEngine.ingest).toHaveBeenCalledWith(req);
    expect(res.status).toBe(200);
  });
});

