// ---------------------------------------------------------------------------
// Tests – Raw Body capture and streaming utilities
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { captureRawBody, getOrReadRawBody } from '../../src/security/raw-body.js';

describe('Raw Body utilities', () => {
  it('reads a readable stream into a single Buffer', async () => {
    const stream = Readable.from(['hello ', 'world!']);
    const result = await captureRawBody(stream);
    expect(result.toString('utf-8')).toBe('hello world!');
  });

  it('rejects when payload size exceeds maxBytes', async () => {
    const stream = Readable.from(['1234567890']);
    await expect(captureRawBody(stream, { maxBytes: 5 })).rejects.toThrow(
      'Payload size exceeded maximum allowed limit of 5 bytes',
    );
  });

  describe('getOrReadRawBody', () => {
    it('returns req.rawBody if present', async () => {
      const dummyReq = {
        rawBody: Buffer.from('existing-raw'),
      } as any;

      const result = await getOrReadRawBody(dummyReq);
      expect(result.toString('utf-8')).toBe('existing-raw');
    });

    it('returns req.body if it is a Buffer', async () => {
      const dummyReq = {
        body: Buffer.from('from-body-buffer'),
      } as any;

      const result = await getOrReadRawBody(dummyReq);
      expect(result.toString('utf-8')).toBe('from-body-buffer');
    });

    it('converts string body to Buffer', async () => {
      const dummyReq = {
        body: 'string-payload',
      } as any;

      const result = await getOrReadRawBody(dummyReq);
      expect(result.toString('utf-8')).toBe('string-payload');
    });

    it('converts object body to Buffer', async () => {
      const dummyReq = {
        body: { foo: 'bar' },
      } as any;

      const result = await getOrReadRawBody(dummyReq);
      expect(JSON.parse(result.toString('utf-8'))).toEqual({ foo: 'bar' });
    });
  });
});

