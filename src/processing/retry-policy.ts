// ---------------------------------------------------------------------------
// Retry policy helpers.
// ---------------------------------------------------------------------------

import type { RetryPolicy } from '../core/types.js';

/** Sensible defaults – decorrelated jitter, 5 attempts, up to 30 s. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelay: 1_000,
  maxDelay: 30_000,
  backoffMultiplier: 2,
  jitter: 'decorrelated',
};

/** Merge a partial policy with the defaults. */
export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...partial };
}

/**
 * Calculate the delay before the next retry attempt.
 *
 * @param attempt - 1-based attempt number.
 * @param policy  - Retry policy configuration.
 * @returns Delay in milliseconds.
 */
export function calculateDelay(attempt: number, policy: RetryPolicy): number {
  const baseDelay = policy.initialDelay * Math.pow(policy.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(baseDelay, policy.maxDelay);

  switch (policy.jitter) {
    case 'none':
      return cappedDelay;

    case 'full':
      // Uniform random in [0, cappedDelay).
      return Math.floor(Math.random() * cappedDelay);

    case 'decorrelated': {
      // See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
      // sleep = min(cap, random_between(base, sleep * 3))
      const lower = policy.initialDelay;
      const upper = cappedDelay * 3;
      const jittered = lower + Math.random() * (upper - lower);
      return Math.min(Math.floor(jittered), policy.maxDelay);
    }

    default:
      return cappedDelay;
  }
}

/**
 * Returns `true` if the event has not yet exhausted all allowed attempts.
 */
export function shouldRetry(attempts: number, policy: RetryPolicy): boolean {
  return attempts < policy.maxAttempts;
}

