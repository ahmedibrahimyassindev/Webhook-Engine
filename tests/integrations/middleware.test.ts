// ---------------------------------------------------------------------------
// Tests – Express and Fastify Integration Middlewares
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createExpressMiddleware } from '../../src/integrations/express/index.js';
import { createFastifyPlugin } from '../../src/integrations/fastify/index.js';

describe('createExpressMiddleware', () => {
  it('calls engine.ingest and sends JSON response with matching status code', async () => {
    const mockEngine = {
      ingest: vi.fn(async () => ({
        status: 200,
        body: { eventId: 'evt_exp_1', message: 'Event accepted' },
      })),
    } as any;

    const middleware = createExpressMiddleware(mockEngine, { provider: 'stripe' });

    const req: any = {
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id":"evt_exp_1","type":"payment.success"}'),
    };

    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    const next = vi.fn();

    middleware(req, res, next);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEngine.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'stripe' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ eventId: 'evt_exp_1', message: 'Event accepted' });
  });
});

describe('createFastifyPlugin', () => {
  it('registers content type parser and post route', async () => {
    const mockEngine = {
      ingest: vi.fn(async () => ({
        status: 200,
        body: { message: 'ok' },
      })),
    } as any;

    const plugin = createFastifyPlugin(mockEngine, { provider: 'github', path: '/webhook' });

    let routeHandler: any;
    const mockFastify: any = {
      addContentTypeParser: vi.fn((_type, _opts, handler) => {
        handler({}, Buffer.from(''), vi.fn());
      }),
      post: vi.fn((path, handler) => {
        routeHandler = handler;
      }),
    };

    plugin(mockFastify);

    expect(mockFastify.addContentTypeParser).toHaveBeenCalledWith(
      'application/json',
      { parseAs: 'buffer' },
      expect.any(Function),
    );
    expect(mockFastify.post).toHaveBeenCalledWith('/webhook', expect.any(Function));

    // Test route handler
    const req = {
      headers: {},
      body: Buffer.from('{"id":"gh_1","type":"push"}'),
    };
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await routeHandler(req, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
