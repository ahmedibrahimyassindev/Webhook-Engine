// ---------------------------------------------------------------------------
// Event lifecycle state machine.
// ---------------------------------------------------------------------------

import type { EventStatus } from './types.js';
import { InvalidStateTransitionError } from './errors.js';

/**
 * Adjacency list defining the legal state transitions.
 *
 * ```text
 * RECEIVED ──► VERIFIED ──► PENDING ──► PROCESSING ──► COMPLETED
 *                                           │
 *                                           ▼
 *                                         FAILED
 *                                         │    │
 *                                         ▼    ▼
 *                                    RETRYING  DEAD_LETTER
 *                                       │
 *                                       ▼
 *                                   PROCESSING  (loop)
 * ```
 */
const VALID_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  RECEIVED:    ['VERIFIED'],
  VERIFIED:    ['PENDING'],
  PENDING:     ['PROCESSING'],
  PROCESSING:  ['COMPLETED', 'FAILED'],
  COMPLETED:   [],
  FAILED:      ['RETRYING', 'DEAD_LETTER'],
  RETRYING:    ['PROCESSING', 'DEAD_LETTER'],
  DEAD_LETTER: ['RETRYING'],               // allow manual retry of dead letters
};

/**
 * Assert that transitioning from `from` to `to` is legal.
 * Throws {@link InvalidStateTransitionError} if not.
 */
export function validateTransition(from: EventStatus, to: EventStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Check (without throwing) whether transitioning from `from` to `to` is legal.
 */
export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Returns `true` for terminal states where no further processing will occur.
 */
export function isTerminalState(status: EventStatus): boolean {
  return status === 'COMPLETED' || status === 'DEAD_LETTER';
}

