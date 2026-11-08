// ---------------------------------------------------------------------------
// Tests – Replay Protection
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayProtection } from '../../src/security/replay-protection.js';

describe('ReplayProtection', () => {
  let guard: ReplayProtection;

  beforeEach(() => {
    guard = new ReplayProtection({ maxTimestampAge: 60_000 });
  });

  describe('isTimestampValid', () => {
    it('accepts a current timestamp', () => {
      expect(guard.isTimestampValid(Date.now())).toBe(true);
    });

    it('accepts a timestamp within the window', () => {
      expect(guard.isTimestampValid(Date.now() - 30_000)).toBe(true);
    });

    it('rejects a timestamp beyond the window', () => {
      expect(guard.isTimestampValid(Date.now() - 120_000)).toBe(false);
    });

    it('rejects a future timestamp', () => {
      expect(guard.isTimestampValid(Date.now() + 10_000)).toBe(false);
    });
  });

  describe('checkNonce', () => {
    it('accepts a new nonce', () => {
      expect(guard.checkNonce('nonce-1')).toBe(true);
    });

    it('rejects a repeated nonce', () => {
      guard.checkNonce('nonce-1');
      expect(guard.checkNonce('nonce-1')).toBe(false);
    });

    it('accepts different nonces', () => {
      expect(guard.checkNonce('a')).toBe(true);
      expect(guard.checkNonce('b')).toBe(true);
      expect(guard.checkNonce('c')).toBe(true);
    });
  });

  describe('eviction', () => {
    it('evicts old entries when cache is full', () => {
      const smallGuard = new ReplayProtection({
        maxTimestampAge: 1,   // 1 ms – everything is immediately "old"
        maxNonceCache: 5,
      });

      // Fill up the cache.
      for (let i = 0; i < 5; i++) {
        smallGuard.checkNonce(`n-${i}`);
      }

      // Adding one more should succeed after eviction.
      expect(smallGuard.checkNonce('n-new')).toBe(true);
    });
  });

  describe('clear', () => {
    it('allows previously seen nonces after clear', () => {
      guard.checkNonce('x');
      expect(guard.checkNonce('x')).toBe(false);

      guard.clear();
      expect(guard.checkNonce('x')).toBe(true);
    });
  });
});

