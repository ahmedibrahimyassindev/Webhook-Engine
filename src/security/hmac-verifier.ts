// ---------------------------------------------------------------------------
// HMAC-based webhook signature verifier.
// ---------------------------------------------------------------------------

import type { SignatureVerifier, VerificationContext, VerificationResult } from '../core/types.js';
import { computeHmac, timingSafeCompare } from './signature.js';

/**
 * Options for the built-in {@link HmacVerifier}.
 */
export interface HmacVerifierOptions {
  /** Shared secret between the provider and your application. */
  secret: string;
  /** Hash algorithm – `"sha256"` or `"sha512"`. */
  algorithm: 'sha256' | 'sha512';
  /** HTTP header that contains the provider's signature. */
  signatureHeader: string;
  /** Optional HTTP header that contains a Unix or ISO-8601 timestamp. */
  timestampHeader?: string;
  /** Maximum age of the timestamp in milliseconds (default 300 000 = 5 min). */
  maxTimestampAge?: number;
  /** Prefix the provider prepends to the signature (e.g. `"sha256="` for GitHub). */
  signaturePrefix?: string;
}

/**
 * Verifier that validates HMAC signatures – the most common webhook signing
 * scheme used by providers such as Stripe, GitHub, Shopify, and others.
 */
export class HmacVerifier implements SignatureVerifier {
  private readonly secret: string;
  private readonly algorithm: string;
  private readonly signatureHeader: string;
  private readonly timestampHeader?: string;
  private readonly maxTimestampAge: number;
  private readonly signaturePrefix: string;

  constructor(options: HmacVerifierOptions) {
    this.secret = options.secret;
    this.algorithm = options.algorithm;
    this.signatureHeader = options.signatureHeader.toLowerCase();
    this.timestampHeader = options.timestampHeader?.toLowerCase();
    this.maxTimestampAge = options.maxTimestampAge ?? 300_000;
    this.signaturePrefix = options.signaturePrefix ?? '';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const { headers, rawBody } = context;

    // ---- Retrieve the provider signature ----
    const signatureValue = this.getHeader(headers, this.signatureHeader);
    if (!signatureValue) {
      return { verified: false, reason: `Missing signature header: ${this.signatureHeader}` };
    }

    // ---- Optional timestamp validation ----
    if (this.timestampHeader) {
      const timestampValue = this.getHeader(headers, this.timestampHeader);
      if (!timestampValue) {
        return { verified: false, reason: `Missing timestamp header: ${this.timestampHeader}` };
      }

      const timestamp = this.parseTimestamp(timestampValue);
      if (timestamp === null) {
        return { verified: false, reason: 'Invalid timestamp format' };
      }

      const age = Date.now() - timestamp;
      if (age > this.maxTimestampAge) {
        return { verified: false, reason: `Timestamp too old: ${age}ms (max: ${this.maxTimestampAge}ms)` };
      }
      if (age < -this.maxTimestampAge) {
        return { verified: false, reason: 'Timestamp is in the future' };
      }
    }

    // ---- Compute and compare signatures ----
    const expectedSignature = this.signaturePrefix + computeHmac(this.algorithm, this.secret, rawBody);

    // Normalise the received value so both sides carry the same prefix.
    const receivedSignature = signatureValue.startsWith(this.signaturePrefix)
      ? signatureValue
      : this.signaturePrefix + signatureValue;

    if (!timingSafeCompare(expectedSignature, receivedSignature)) {
      return { verified: false, reason: 'Signature mismatch' };
    }

    return { verified: true };
  }

  // ---- Helpers ----

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Parse a timestamp value that may be:
   * - A Unix timestamp in seconds (e.g. `"1700000000"`)
   * - A Unix timestamp in milliseconds (e.g. `"1700000000000"`)
   * - An ISO-8601 string
   *
   * Returns epoch milliseconds or `null` if unparseable.
   */
  private parseTimestamp(value: string): number | null {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
      // Heuristic: values below 1e12 are seconds; above are milliseconds.
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const asDate = Date.parse(value);
    return Number.isNaN(asDate) ? null : asDate;
  }
}

