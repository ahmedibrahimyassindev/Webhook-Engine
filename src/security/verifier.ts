// ---------------------------------------------------------------------------
// No-op verifier – accepts all requests. For development and testing only.
// ---------------------------------------------------------------------------

import type { SignatureVerifier, VerificationContext, VerificationResult } from '../core/types.js';

/**
 * A verifier that accepts every request without checking signatures.
 *
 * > **Warning** – Do not use in production. All webhook endpoints must
 * > verify signatures to prevent spoofed requests.
 */
export class NoOpVerifier implements SignatureVerifier {
  async verify(_context: VerificationContext): Promise<VerificationResult> {
    return { verified: true };
  }
}

