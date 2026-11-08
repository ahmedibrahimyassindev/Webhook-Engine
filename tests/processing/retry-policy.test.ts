// ---------------------------------------------------------------------------
// Tests – Retry Policy
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  calculateDelay,
  shouldRetry,
  resolveRetryPolicy,
  DEFAULT_RETRY_POLICY,
} from '../../src/processing/retry-policy.js';
import type { RetryPolicy } from '../../src/core/types.js';

describe('Retry Policy', () => {
  describe('resolveRetryPolicy', () => {
    it('returns defaults when no overrides are given', () => {
      expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    });

    it('merges partial overrides with defaults', () => {
      const policy = resolveRetryPolicy({ maxAttempts: 10 });
      expect(policy.maxAttempts).toBe(10);
      expect(policy.initialDelay).toBe(DEFAULT_RETRY_POLICY.initialDelay);
    });
  });

  describe('shouldRetry', () => {
    it('returns true when attempts < maxAttempts', () => {
      expect(shouldRetry(2, { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 })).toBe(true);
    });

    it('returns false when attempts >= maxAttempts', () => {
      expect(shouldRetry(5, { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 })).toBe(false);
    });
  });

  describe('calculateDelay', () => {
    const noJitter: RetryPolicy = {
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 30_000,
      backoffMultiplier: 2,
      jitter: 'none',
    };

    it('returns initialDelay on first attempt (no jitter)', () => {
      expect(calculateDelay(1, noJitter)).toBe(1000);
    });

    it('doubles on second attempt (no jitter)', () => {
      expect(calculateDelay(2, noJitter)).toBe(2000);
    });

    it('caps at maxDelay (no jitter)', () => {
      expect(calculateDelay(100, noJitter)).toBe(30_000);
    });

    it('full jitter returns a value in [0, cappedDelay)', () => {
      const policy: RetryPolicy = { ...noJitter, jitter: 'full' };
      for (let i = 0; i < 50; i++) {
        const delay = calculateDelay(1, policy);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(policy.initialDelay);
      }
    });

    it('decorrelated jitter returns a value ≤ maxDelay', () => {
      const policy: RetryPolicy = { ...noJitter, jitter: 'decorrelated' };
      for (let i = 0; i < 50; i++) {
        const delay = calculateDelay(3, policy);
        expect(delay).toBeLessThanOrEqual(policy.maxDelay);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

