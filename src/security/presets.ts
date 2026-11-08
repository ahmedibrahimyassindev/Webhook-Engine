// ---------------------------------------------------------------------------
// Provider-specific signature verifiers (GitHub, Stripe, Shopify, Svix/Standard Webhooks)
// ---------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
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

/**
 * Pre-configured verifier for Shopify webhooks.
 * Uses Base64-encoded HMAC-SHA256 signature from the `x-shopify-hmac-sha256` header.
 */
export class ShopifyVerifier implements SignatureVerifier {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const headerValue = context.headers['x-shopify-hmac-sha256'];
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!signature) {
      return { verified: false, reason: 'Missing x-shopify-hmac-sha256 header' };
    }

    const expectedSignature = createHmac('sha256', this.secret)
      .update(context.rawBody)
      .digest('base64');

    if (!timingSafeCompare(expectedSignature, signature)) {
      return { verified: false, reason: 'Signature mismatch' };
    }

    return { verified: true };
  }
}

/**
 * Options for {@link SvixVerifier}.
 */
export interface SvixVerifierOptions {
  /** Svix secret key (typically starts with "whsec_"). */
  secret: string;
  /** Maximum timestamp tolerance in ms (default 300 000 = 5 minutes). */
  tolerance?: number;
}

/**
 * Pre-configured verifier for Svix and Standard Webhooks specification
 * (used by Clerk, Brex, Resend, Supabase, etc.).
 *
 * Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`
 * Signed payload: `${webhook-id}.${webhook-timestamp}.${rawBody}`
 */
export class SvixVerifier implements SignatureVerifier {
  private readonly secretKey: Buffer;
  private readonly tolerance: number;

  constructor(options: SvixVerifierOptions) {
    let secret = options.secret;
    if (secret.startsWith('whsec_')) {
      secret = secret.substring(6);
    }
    this.secretKey = Buffer.from(secret, 'base64');
    this.tolerance = options.tolerance ?? 300_000;
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const id = this.getHeader(context.headers, 'webhook-id');
    const timestamp = this.getHeader(context.headers, 'webhook-timestamp');
    const signatureHeader = this.getHeader(context.headers, 'webhook-signature');

    if (!id || !timestamp || !signatureHeader) {
      return { verified: false, reason: 'Missing required Svix webhook headers' };
    }

    // Timestamp check
    const timestampSec = Number(timestamp);
    if (Number.isNaN(timestampSec)) {
      return { verified: false, reason: 'Invalid webhook-timestamp header' };
    }
    const age = Date.now() - timestampSec * 1000;
    if (age > this.tolerance) {
      return { verified: false, reason: `Timestamp outside tolerance window (${age}ms)` };
    }
    if (age < -this.tolerance) {
      return { verified: false, reason: 'Timestamp is in the future' };
    }

    // Payload: ${id}.${timestamp}.${rawBody}
    const toSign = Buffer.concat([
      Buffer.from(`${id}.${timestamp}.`, 'utf-8'),
      context.rawBody,
    ]);

    const expectedSignature = createHmac('sha256', this.secretKey)
      .update(toSign)
      .digest('base64');

    // Signatures are space-separated: "v1,signature1 v1,signature2"
    const passedSignatures = signatureHeader.split(' ').map((sig) => {
      const [, val] = sig.split(',');
      return val ?? sig;
    });

    const matches = passedSignatures.some((sig) => timingSafeCompare(sig, expectedSignature));
    if (!matches) {
      return { verified: false, reason: 'Signature mismatch' };
    }

    return { verified: true };
  }

  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const val = headers[name];
    return Array.isArray(val) ? val[0] : val;
  }
}
