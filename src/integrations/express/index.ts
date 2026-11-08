// ---------------------------------------------------------------------------
// Express integration – middleware factory.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebhookEngine } from '../../core/engine.js';
import type { IngestRequest } from '../../core/types.js';

/** Options for {@link createExpressMiddleware}. */
export interface ExpressMiddlewareOptions {
  /** Provider identifier passed to the engine (e.g. `"stripe"`). */
  provider: string;
}

// Minimal Express-compatible types so we don't depend on `@types/express`.
type ExpressRequest = IncomingMessage & {
  body?: Buffer | string | Record<string, unknown>;
};
type ExpressResponse = ServerResponse & {
  status(code: number): ExpressResponse;
  json(body: unknown): ExpressResponse;
};
type NextFunction = (err?: unknown) => void;

/**
 * Create an Express middleware that ingests webhooks into the engine.
 *
 * **Important:** Use `express.raw({ type: "application/json" })` before this
 * middleware so the raw body is available for signature verification.
 *
 * ```ts
 * app.post(
 *   "/webhooks/stripe",
 *   express.raw({ type: "application/json" }),
 *   createExpressMiddleware(engine, { provider: "stripe" }),
 * );
 * ```
 */
export function createExpressMiddleware(
  engine: WebhookEngine,
  options: ExpressMiddlewareOptions,
): (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => void {
  return (req, res, _next) => {
    getRawBody(req)
      .then((rawBody) => {
        const ingestRequest: IngestRequest = {
          headers: req.headers as Record<string, string | string[] | undefined>,
          rawBody,
          provider: options.provider,
        };
        return engine.ingest(ingestRequest);
      })
      .then((result) => {
        res.status(result.status).json(result.body);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Internal server error';
        res.status(500).json({ message, error: 'INTERNAL_ERROR' });
      });
  };
}

// ---------------------------------------------------------------------------

async function getRawBody(req: ExpressRequest): Promise<Buffer> {
  // Body already buffered (express.raw()).
  if (Buffer.isBuffer(req.body)) return req.body;
  // Body available as a string.
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf-8');
  // Body already parsed as JSON – less ideal for signatures but usable.
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body), 'utf-8');

  // Fallback: read from stream.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

