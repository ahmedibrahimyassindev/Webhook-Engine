// ---------------------------------------------------------------------------
// Provider-specific signature verifiers (GitHub, Stripe, etc.)
// ---------------------------------------------------------------------------

import type { SignatureVerifier, VerificationContext, VerificationResult } from '../core/types.js';
import { HmacVerifier } from './hmac-verifier.js';
import { computeHmac, timingSafeCompare } from './signature.js';

/**
 * Pre-configured verifier for GitHub webhooks.
 * Uses HMAC-SHA256 with `x-hub-signature-256` header and `sha256=` prefix.
 */
export class GitHubVerifier extends HmacVerifier {
  constructor(secret: string) {
    super({
      secret,
      algorithm: 'sha256',
      signatureHeader: 'x-hub-signature-256',
      signaturePrefix: 'sha256=',
    });
  }
}

/**
 * Options for {@link StripeVerifier}.
 */
export interface StripeVerifierOptions {
  /** Stripe webhook endpoint secret (starts with "whsec_"). */
  secret: string;
  /** Maximum tolerance in ms (default 300 000 = 5 minutes). */
  tolerance?: number;
}

/**
 * Pre-configured verifier for Stripe webhooks.
 * Validates `stripe-signature` header containing `t=<timestamp>,v1=<signature>`.
 * The signed payload is `${timestamp}.${rawBody}`.
 */
export class StripeVerifier implements SignatureVerifier {
  private readonly secret: string;
  private readonly tolerance: number;

  constructor(options: StripeVerifierOptions) {
    this.secret = options.secret;
    this.tolerance = options.tolerance ?? 300_000;
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const headerValue = context.headers['stripe-signature'];
    const signatureHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!signatureHeader) {
      return { verified: false, reason: 'Missing stripe-signature header' };
    }

    const parsed = this.parseHeader(signatureHeader);
    if (!parsed.timestamp || parsed.signatures.length === 0) {
      return { verified: false, reason: 'Malformed stripe-signature header' };
    }

    // Validate timestamp tolerance
    const timestampMs = parsed.timestamp * 1000;
    const age = Date.now() - timestampMs;
    if (age > this.tolerance) {
      return { verified: false, reason: `Timestamp outside tolerance window (${age}ms)` };
    }
    if (age < -this.tolerance) {
      return { verified: false, reason: 'Timestamp is in the future' };
    }

    // The signature payload is `${timestamp}.${rawBody}`
    const payload = Buffer.concat([
      Buffer.from(`${parsed.timestamp}.`, 'utf-8'),
      context.rawBody,
    ]);

    const expectedSignature = computeHmac('sha256', this.secret, payload);

    const matches = parsed.signatures.some((sig) => timingSafeCompare(sig, expectedSignature));
    if (!matches) {
      return { verified: false, reason: 'Signature mismatch' };
    }

    return { verified: true };
  }

  private parseHeader(header: string): { timestamp?: number; signatures: string[] } {
    const parts = header.split(',');
    let timestamp: number | undefined;
    const signatures: string[] = [];

    for (const part of parts) {
      const [key, value] = part.trim().split('=');
      if (key === 't' && value) {
        const parsedNum = Number(value);
        if (!Number.isNaN(parsedNum)) {
          timestamp = parsedNum;
        }
      } else if (key === 'v1' && value) {
        signatures.push(value);
      }
    }

    return { timestamp, signatures };
  }
}

