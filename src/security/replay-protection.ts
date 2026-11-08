// ---------------------------------------------------------------------------
// Replay protection – timestamp window + nonce cache.
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link ReplayProtection} guard.
 */
export interface ReplayProtectionOptions {
  /** Maximum acceptable age of a webhook timestamp in milliseconds. */
  maxTimestampAge: number;
  /** Maximum number of nonces to hold in the in-memory cache (default 10 000). */
  maxNonceCache?: number;
}

/**
 * In-memory replay protection that combines timestamp bounds with an
 * optional nonce (event-ID) cache.
 *
 * 1. **Timestamp validation** – requests whose timestamp falls outside the
 *    `±maxTimestampAge` window are rejected.
 * 2. **Nonce tracking** – seen event identifiers are recorded so that an
 *    exact replay within the window is detected.
 */
export class ReplayProtection {
  private readonly maxTimestampAge: number;
  private readonly maxNonceCache: number;
  private readonly seenNonces: Map<string, number> = new Map(); // nonce → seen-at timestamp

  constructor(options: ReplayProtectionOptions) {
    this.maxTimestampAge = options.maxTimestampAge;
    this.maxNonceCache = options.maxNonceCache ?? 10_000;
  }

  /**
   * Returns `true` if the given timestamp is within the acceptable window.
   */
  isTimestampValid(timestamp: number): boolean {
    const age = Date.now() - timestamp;
    return age >= 0 && age <= this.maxTimestampAge;
  }

  /**
   * Record and check a nonce (typically the event ID).
   *
   * @returns `true` if the nonce has **not** been seen before (i.e. not a replay).
   */
  checkNonce(nonce: string): boolean {
    if (this.seenNonces.has(nonce)) {
      return false;
    }

    // Evict expired entries before adding a new one.
    if (this.seenNonces.size >= this.maxNonceCache) {
      this.evictOldEntries();
    }

    this.seenNonces.set(nonce, Date.now());
    return true;
  }

  /** Clear all tracked nonces. */
  clear(): void {
    this.seenNonces.clear();
  }

  // ---- Private helpers ----

  private evictOldEntries(): void {
    const cutoff = Date.now() - this.maxTimestampAge;

    for (const [nonce, timestamp] of this.seenNonces) {
      if (timestamp < cutoff) {
        this.seenNonces.delete(nonce);
      }
    }

    // If still at capacity, drop the oldest 20%.
    if (this.seenNonces.size >= this.maxNonceCache) {
      const sorted = [...this.seenNonces.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = Math.ceil(this.maxNonceCache * 0.2);
      for (let i = 0; i < toRemove && i < sorted.length; i++) {
        this.seenNonces.delete(sorted[i]![0]);
      }
    }
  }
}

