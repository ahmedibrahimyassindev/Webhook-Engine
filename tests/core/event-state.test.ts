// ---------------------------------------------------------------------------
// Tests – Event state machine
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { validateTransition, canTransition, isTerminalState } from '../../src/core/event-state.js';
import { InvalidStateTransitionError } from '../../src/core/errors.js';
import type { EventStatus } from '../../src/core/types.js';

describe('Event State Machine', () => {
  describe('validateTransition', () => {
    const validPaths: [EventStatus, EventStatus][] = [
      ['RECEIVED', 'VERIFIED'],
      ['VERIFIED', 'PENDING'],
      ['PENDING', 'PROCESSING'],
      ['PROCESSING', 'COMPLETED'],
      ['PROCESSING', 'FAILED'],
      ['FAILED', 'RETRYING'],
      ['FAILED', 'DEAD_LETTER'],
      ['RETRYING', 'PROCESSING'],
      ['RETRYING', 'DEAD_LETTER'],
      ['DEAD_LETTER', 'RETRYING'],
    ];

    it.each(validPaths)('allows %s → %s', (from, to) => {
      expect(() => validateTransition(from, to)).not.toThrow();
    });

    const invalidPaths: [EventStatus, EventStatus][] = [
      ['RECEIVED', 'PROCESSING'],
      ['RECEIVED', 'COMPLETED'],
      ['VERIFIED', 'COMPLETED'],
      ['PENDING', 'FAILED'],
      ['PROCESSING', 'RETRYING'],
      ['COMPLETED', 'FAILED'],
      ['COMPLETED', 'RETRYING'],
      ['COMPLETED', 'PROCESSING'],
    ];

    it.each(invalidPaths)('rejects %s → %s', (from, to) => {
      expect(() => validateTransition(from, to)).toThrow(InvalidStateTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition('RECEIVED', 'VERIFIED')).toBe(true);
      expect(canTransition('FAILED', 'RETRYING')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition('COMPLETED', 'PROCESSING')).toBe(false);
      expect(canTransition('RECEIVED', 'COMPLETED')).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('identifies COMPLETED as terminal', () => {
      expect(isTerminalState('COMPLETED')).toBe(true);
    });

    it('identifies DEAD_LETTER as terminal', () => {
      expect(isTerminalState('DEAD_LETTER')).toBe(true);
    });

    it('does not treat intermediate states as terminal', () => {
      expect(isTerminalState('PROCESSING')).toBe(false);
      expect(isTerminalState('FAILED')).toBe(false);
      expect(isTerminalState('RETRYING')).toBe(false);
      expect(isTerminalState('PENDING')).toBe(false);
    });
  });
});

