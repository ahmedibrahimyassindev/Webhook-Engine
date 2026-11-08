// ---------------------------------------------------------------------------
// Tests – HMAC Verifier
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { HmacVerifier } from '../../src/security/hmac-verifier.js';
import { computeHmac } from '../../src/security/signature.js';

const SECRET = 'test-secret-key';

function makeVerifier(overrides: Partial<ConstructorParameters<typeof HmacVerifier>[0]> = {}) {
  return new HmacVerifier({
    secret: SECRET,
    algorithm: 'sha256',
    signatureHeader: 'x-signature',
    ...overrides,
  });
}

function sign(body: string, secret = SECRET, algorithm = 'sha256'): string {
  return computeHmac(algorithm, secret, Buffer.from(body));
}

describe('HmacVerifier', () => {
  it('accepts a valid signature', async () => {
    const verifier = makeVerifier();
    const body = '{"event":"test"}';
    const signature = sign(body);

    const result = await verifier.verify({
      headers: { 'x-signature': signature },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(true);
  });

  it('rejects a missing signature header', async () => {
    const verifier = makeVerifier();

    const result = await verifier.verify({
      headers: {},
      rawBody: Buffer.from('{}'),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Missing signature header');
  });

  it('rejects an invalid signature', async () => {
    const verifier = makeVerifier();

    const result = await verifier.verify({
      headers: { 'x-signature': 'deadbeef' },
      rawBody: Buffer.from('{"event":"test"}'),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('Signature mismatch');
  });

  it('handles signature prefix (e.g. "sha256=")', async () => {
    const verifier = makeVerifier({ signaturePrefix: 'sha256=' });
    const body = '{"event":"test"}';
    const signature = 'sha256=' + sign(body);

    const result = await verifier.verify({
      headers: { 'x-signature': signature },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(true);
  });

  it('rejects when timestamp is too old', async () => {
    const verifier = makeVerifier({
      timestampHeader: 'x-timestamp',
      maxTimestampAge: 5_000,
    });
    const body = '{"event":"test"}';

    // Timestamp 1 hour ago
    const oldTimestamp = String(Math.floor((Date.now() - 3_600_000) / 1000));

    const result = await verifier.verify({
      headers: {
        'x-signature': sign(body),
        'x-timestamp': oldTimestamp,
      },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Timestamp too old');
  });

  it('accepts a valid timestamp', async () => {
    const verifier = makeVerifier({
      timestampHeader: 'x-timestamp',
      maxTimestampAge: 60_000,
    });
    const body = '{"event":"test"}';
    const now = String(Math.floor(Date.now() / 1000));

    const result = await verifier.verify({
      headers: {
        'x-signature': sign(body),
        'x-timestamp': now,
      },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(true);
  });

  it('rejects a future timestamp beyond the tolerance', async () => {
    const verifier = makeVerifier({
      timestampHeader: 'x-timestamp',
      maxTimestampAge: 5_000,
    });
    const body = '{"event":"test"}';
    const futureTimestamp = String(Math.floor((Date.now() + 60_000) / 1000));

    const result = await verifier.verify({
      headers: {
        'x-signature': sign(body),
        'x-timestamp': futureTimestamp,
      },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('future');
  });

  it('rejects a missing timestamp header when configured', async () => {
    const verifier = makeVerifier({ timestampHeader: 'x-timestamp' });
    const body = '{"event":"test"}';

    const result = await verifier.verify({
      headers: { 'x-signature': sign(body) },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Missing timestamp header');
  });

  it('supports SHA-512 algorithm', async () => {
    const verifier = makeVerifier({ algorithm: 'sha512' });
    const body = '{"event":"test"}';
    const signature = computeHmac('sha512', SECRET, Buffer.from(body));

    const result = await verifier.verify({
      headers: { 'x-signature': signature },
      rawBody: Buffer.from(body),
    });

    expect(result.verified).toBe(true);
  });
});

