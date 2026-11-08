// ---------------------------------------------------------------------------
// Error hierarchy for the Node Webhook Engine.
// ---------------------------------------------------------------------------

/**
 * Base error class for all webhook engine errors.
 */
export class WebhookError extends Error {
  public readonly isRetryable: boolean;

  constructor(message: string, options?: { cause?: Error; isRetryable?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = 'WebhookError';
    this.isRetryable = options?.isRetryable ?? false;
  }
}

/**
 * Thrown when a handler encounters a transient failure that should be retried.
 *
 * @example
 * ```ts
 * throw new RetryableError("Database temporarily unavailable", { cause: err });
 * ```
 */
export class RetryableError extends WebhookError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, { cause: options?.cause, isRetryable: true });
    this.name = 'RetryableError';
  }
}

/**
 * Thrown when a handler encounters a permanent failure that should not be retried.
 * The event is moved directly to the dead-letter queue.
 *
 * @example
 * ```ts
 * throw new PermanentError("Invalid payment data", { cause: err });
 * ```
 */
export class PermanentError extends WebhookError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, { cause: options?.cause, isRetryable: false });
    this.name = 'PermanentError';
  }
}

/**
 * Thrown when signature verification fails.
 */
export class VerificationError extends WebhookError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, { cause: options?.cause, isRetryable: false });
    this.name = 'VerificationError';
  }
}

/**
 * Thrown when an event with the same `eventId + provider` already exists in storage.
 */
export class DuplicateEventError extends WebhookError {
  public readonly eventId: string;

  constructor(eventId: string, message?: string) {
    super(message ?? `Duplicate event: ${eventId}`, { isRetryable: false });
    this.name = 'DuplicateEventError';
    this.eventId = eventId;
  }
}

/**
 * Thrown when an event lifecycle state transition is invalid.
 */
export class InvalidStateTransitionError extends WebhookError {
  public readonly from: string;
  public readonly to: string;

  constructor(from: string, to: string) {
    super(`Invalid state transition: ${from} -> ${to}`, { isRetryable: false });
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

