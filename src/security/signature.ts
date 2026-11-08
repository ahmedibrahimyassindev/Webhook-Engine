// ---------------------------------------------------------------------------
// Low-level signature utilities.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute an HMAC digest for the given data.
 *
 * @returns Hex-encoded HMAC string.
 */
export function computeHmac(
  algorithm: string,
  secret: string,
  data: Buffer,
): string {
  return createHmac(algorithm, secret).update(data).digest('hex');
}

/**
 * Timing-safe string comparison.
 *
 * Returns `false` immediately when lengths differ (the length itself is not
 * secret), then delegates to `crypto.timingSafeEqual` for constant-time
 * byte comparison.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

