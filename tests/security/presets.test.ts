// ---------------------------------------------------------------------------
// Tests – GitHub and Stripe Verifier Presets
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { GitHubVerifier, StripeVerifier } from '../../src/security/presets.js';
import { computeHmac } from '../../src/security/signature.js';

describe('GitHubVerifier', () => {
  const secret = 'gh-secret-123';
  const verifier = new GitHubVerifier(secret);

  it('accepts valid GitHub webhook signature', async () => {
    const rawBody = Buffer.from('{"action":"opened"}');
    const signature = 'sha256=' + computeHmac('sha256', secret, rawBody);

    const result = await verifier.verify({
      headers: { 'x-hub-signature-256': signature },
      rawBody,
    });

    expect(result.verified).toBe(true);
  });

  it('rejects invalid GitHub webhook signature', async () => {
    const rawBody = Buffer.from('{"action":"opened"}');

    const result = await verifier.verify({
      headers: { 'x-hub-signature-256': 'sha256=invalid' },
      rawBody,
    });

    expect(result.verified).toBe(false);
  });
});

describe('StripeVerifier', () => {
  const secret = 'whsec_test_secret';
  const verifier = new StripeVerifier({ secret, tolerance: 300_000 });

  it('accepts a valid stripe signature', async () => {
    const rawBody = Buffer.from('{"id":"evt_stripe_1"}');
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    const sig = computeHmac('sha256', secret, payload);

    const result = await verifier.verify({
      headers: {
        'stripe-signature': `t=${timestamp},v1=${sig}`,
      },
      rawBody,
    });

    expect(result.verified).toBe(true);
  });

  it('rejects when stripe-signature header is missing', async () => {
    const result = await verifier.verify({
      headers: {},
      rawBody: Buffer.from('{}'),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Missing stripe-signature header');
  });

  it('rejects malformed header', async () => {
    const result = await verifier.verify({
      headers: { 'stripe-signature': 'not-a-valid-stripe-header' },
      rawBody: Buffer.from('{}'),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Malformed stripe-signature header');
  });

  it('rejects timestamp outside tolerance window', async () => {
    const rawBody = Buffer.from('{}');
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s ago (> 300s)
    const payload = Buffer.concat([Buffer.from(`${oldTimestamp}.`), rawBody]);
    const sig = computeHmac('sha256', secret, payload);

    const result = await verifier.verify({
      headers: {
        'stripe-signature': `t=${oldTimestamp},v1=${sig}`,
      },
      rawBody,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('tolerance');
  });

  it('rejects signature mismatch', async () => {
    const rawBody = Buffer.from('{}');
    const timestamp = Math.floor(Date.now() / 1000);

    const result = await verifier.verify({
      headers: {
        'stripe-signature': `t=${timestamp},v1=bad_sig`,
      },
      rawBody,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('Signature mismatch');
  });
});

