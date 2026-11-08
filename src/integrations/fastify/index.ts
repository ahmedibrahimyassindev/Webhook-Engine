// ---------------------------------------------------------------------------
// Fastify integration – plugin factory.
// ---------------------------------------------------------------------------

import type { WebhookEngine } from '../../core/engine.js';
import type { IngestRequest } from '../../core/types.js';

/** Options for {@link createFastifyPlugin}. */
export interface FastifyPluginOptions {
  /** Provider identifier passed to the engine. */
  provider: string;
  /** Route path (default `"/webhooks"`). */
  path?: string;
}

// Minimal Fastify-compatible types – avoids a hard dependency on `fastify`.
interface FastifyRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}
interface FastifyReply {
  status(code: number): FastifyReply;
  send(payload: unknown): FastifyReply;
}
interface FastifyInstance {
  post(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: string },
    handler: (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => void,
  ): void;
}

/**
 * Create a Fastify plugin that registers a POST route for webhook ingestion.
 *
 * ```ts
 * import Fastify from "fastify";
 * import { createFastifyPlugin } from "node-webhook-engine/integrations/fastify";
 *
 * const app = Fastify();
 * app.register(createFastifyPlugin(engine, { provider: "github", path: "/hooks" }));
 * ```
 */
export function createFastifyPlugin(
  engine: WebhookEngine,
  options: FastifyPluginOptions,
): (fastify: FastifyInstance) => void {
  const path = options.path ?? '/webhooks';

  return (fastify: FastifyInstance) => {
    // Ensure the raw buffer is available for signature verification.
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    fastify.post(path, async (req, reply) => {
      try {
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(JSON.stringify(req.body), 'utf-8');

        const ingestRequest: IngestRequest = {
          headers: req.headers,
          rawBody,
          provider: options.provider,
        };

        const result = await engine.ingest(ingestRequest);
        await reply.status(result.status).send(result.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        await reply.status(500).send({ message, error: 'INTERNAL_ERROR' });
      }
    });
  };
}

