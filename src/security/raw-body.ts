// ---------------------------------------------------------------------------
// Raw body collection and streaming utilities.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from 'node:http';

/**
 * Options for capturing the raw request body.
 */
export interface RawBodyOptions {
  /** Maximum allowed size in bytes (default 1 MB = 1 048 576 bytes). */
  maxBytes?: number;
}

/**
 * Read the complete raw body from an HTTP readable stream into a Buffer.
 * Rejects with an error if the payload exceeds `maxBytes`.
 */
export function captureRawBody(
  stream: NodeJS.ReadableStream,
  options?: RawBodyOptions,
): Promise<Buffer> {
  const maxBytes = options?.maxBytes ?? 1_048_576; // 1 MB default

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesReceived += buf.length;

      if (bytesReceived > maxBytes) {
        cleanup();
        reject(new Error(`Payload size exceeded maximum allowed limit of ${maxBytes} bytes`));
        return;
      }

      chunks.push(buf);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * Helper to extract or read the raw body from a Node.js IncomingMessage.
 */
export async function getOrReadRawBody(
  req: IncomingMessage & { body?: unknown; rawBody?: Buffer },
  options?: RawBodyOptions,
): Promise<Buffer> {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf-8');
  }
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }
  return captureRawBody(req, options);
}

