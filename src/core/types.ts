// ---------------------------------------------------------------------------
// Core types and interfaces for the Node Webhook Engine.
// ---------------------------------------------------------------------------

/**
 * Possible states an event can occupy during its lifecycle.
 */
export type EventStatus =
  | 'RECEIVED'
  | 'VERIFIED'
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'DEAD_LETTER';

/**
 * Normalized representation of a webhook event.
 */
export interface WebhookEvent {
  /** Stable unique identifier assigned by the provider. */
  eventId: string;
  /** Identifier of the webhook provider (e.g. "stripe", "github"). */
  provider: string;
  /** Dot-delimited event type (e.g. "payment.completed"). */
  type: string;
  /** Arbitrary event payload. */
  data: unknown;
  /** Original HTTP headers. */
  headers: Record<string, string | string[] | undefined>;
  /** Original raw request body (needed for signature verification). */
  rawBody: Buffer;
  /** Timestamp when the event was received by the engine. */
  receivedAt: Date;
  /** Current lifecycle status. */
  status: EventStatus;
  /** Number of processing attempts made so far. */
  attempts: number;
  /** Timestamp of the most recent processing attempt. */
  lastAttemptAt?: Date;
  /** Error message from the most recent failed attempt. */
  lastError?: string;
  /** Arbitrary metadata attached to the event. */
  metadata?: Record<string, unknown>;
}

/**
 * A function that processes a single webhook event.
 */
export type EventHandler = (event: WebhookEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Input to {@link WebhookEngine.ingest}.
 */
export interface IngestRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  provider: string;
}

/**
 * Result returned by {@link WebhookEngine.ingest}.
 */
export interface IngestResult {
  status: number;
  body: {
    eventId?: string;
    message: string;
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Configuration for the retry mechanism.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts before dead-lettering. */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelay: number;
  /** Maximum delay cap in milliseconds. */
  maxDelay: number;
  /** Multiplier applied to the delay after each attempt. */
  backoffMultiplier: number;
  /** Jitter strategy applied to the calculated delay. */
  jitter: 'none' | 'full' | 'decorrelated';
}

// ---------------------------------------------------------------------------
// Security / Verification
// ---------------------------------------------------------------------------

/**
 * Context passed to a {@link SignatureVerifier}.
 */
export interface VerificationContext {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

/**
 * Result of a signature verification check.
 */
export interface VerificationResult {
  verified: boolean;
  reason?: string;
}

/**
 * Strategy interface for verifying webhook request signatures.
 */
export interface SignatureVerifier {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Filter for querying dead-lettered events.
 */
export interface DeadLetterFilter {
  provider?: string;
  eventType?: string;
  since?: Date;
  limit?: number;
}

/**
 * Filter for querying events in storage.
 */
export interface EventQueryFilter {
  provider?: string;
  status?: EventStatus;
  eventType?: string;
  limit?: number;
  offset?: number;
}

/**
 * Persistence layer abstraction.
 *
 * Implementations must provide atomic deduplication via {@link storeEvent} and
 * a compare-and-set style processing lock via {@link claimEvent}.
 */
export interface StorageAdapter {
  /** Perform any async initialisation (connect, migrate, etc.). */
  initialize(): Promise<void>;
  /** Gracefully release resources. */
  shutdown(): Promise<void>;

  /**
   * Persist a new event.
   * Must throw {@link DuplicateEventError} if `eventId + provider` already exists.
   */
  storeEvent(event: WebhookEvent): Promise<void>;
  /** Look up an event by its composite key. */
  findEvent(eventId: string, provider: string): Promise<WebhookEvent | null>;
  /** Update an event's status (and optionally its error message). */
  updateEventStatus(eventId: string, provider: string, status: EventStatus, error?: string): Promise<void>;

  /**
   * Atomically claim an event for processing.
   * Returns `true` if the claim succeeded, `false` if another consumer holds it.
   */
  claimEvent(eventId: string, provider: string): Promise<boolean>;
  /** Release a previously claimed event. */
  releaseEvent(eventId: string, provider: string): Promise<void>;

  /** Return all events eligible for retry (`FAILED` or `RETRYING`). */
  getRetryableEvents(): Promise<WebhookEvent[]>;
  /** Return dead-lettered events matching the optional filter. */
  getDeadLetterEvents(filter?: DeadLetterFilter): Promise<WebhookEvent[]>;
  /** Query events by status, provider, or type. */
  queryEvents?(filter: EventQueryFilter): Promise<WebhookEvent[]>;
}

// ---------------------------------------------------------------------------
// Engine events (observability)
// ---------------------------------------------------------------------------

/**
 * Lifecycle events emitted by the engine.
 */
export type EngineEvent =
  | 'event.received'
  | 'event.verified'
  | 'event.pending'
  | 'event.processing'
  | 'event.completed'
  | 'event.failed'
  | 'event.retrying'
  | 'event.deadLetter';

/** Callback signature for engine lifecycle listeners. */
export type EngineEventListener = (event: WebhookEvent) => void;

// ---------------------------------------------------------------------------
// Observability: Logger & Metrics
// ---------------------------------------------------------------------------

/**
 * Structured logger interface.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Metrics telemetry collector interface.
 */
export interface MetricsCollector {
  recordEventIngested?(provider: string, type: string): void;
  recordEventProcessed?(provider: string, type: string, durationMs: number, success: boolean): void;
  recordRetry?(provider: string, type: string, attempt: number): void;
  recordDeadLetter?(provider: string, type: string): void;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

/**
 * Options accepted by the {@link WebhookEngine} constructor.
 */
export interface WebhookEngineOptions {
  storage: StorageAdapter;
  verifier: SignatureVerifier;
  retryPolicy?: Partial<RetryPolicy>;
  /** Interval in ms to poll for retryable events. Default 5 000. */
  retryInterval?: number;
  /** Maximum age of a webhook timestamp in ms (replay protection). Default 300 000. */
  maxTimestampAge?: number;
  /** Handler execution timeout in ms. Default 30 000. */
  processingTimeout?: number;
  /** Maximum number of events processed concurrently. Default 10. */
  concurrency?: number;
  /** Optional structured logger. */
  logger?: Logger;
  /** Optional metrics collector. */
  metrics?: MetricsCollector;
}
