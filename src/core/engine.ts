// ---------------------------------------------------------------------------
// WebhookEngine – the main entry point of the library.
// ---------------------------------------------------------------------------

import type {
  WebhookEngineOptions,
  WebhookEvent,
  EventHandler,
  IngestRequest,
  IngestResult,
  EventStatus,
  EngineEvent,
  EngineEventListener,
  DeadLetterFilter,
  EventQueryFilter,
  RetryPolicy,
  StorageAdapter,
  SignatureVerifier,
  Logger,
  MetricsCollector,
} from './types.js';
import { validateTransition, canTransition } from './event-state.js';
import { DuplicateEventError } from './errors.js';
import { HandlerRegistry } from '../processing/handler-registry.js';
import { EventProcessor } from '../processing/processor.js';
import { resolveRetryPolicy } from '../processing/retry-policy.js';
import { ReplayProtection } from '../security/replay-protection.js';

/**
 * Core webhook processing engine.
 *
 * ```ts
 * const engine = new WebhookEngine({ storage, verifier });
 * engine.register("payment.completed", async (event) => { ... });
 * await engine.initialize();
 * ```
 */
export class WebhookEngine {
  private readonly storage: StorageAdapter;
  private readonly verifier: SignatureVerifier;
  private readonly retryPolicy: RetryPolicy;
  private readonly retryInterval: number;
  private readonly maxTimestampAge: number;
  private readonly processingTimeout: number;
  private readonly concurrency: number;
  private readonly logger?: Logger;
  private readonly metrics?: MetricsCollector;

  private readonly registry: HandlerRegistry;
  private readonly processor: EventProcessor;
  private readonly replayProtection: ReplayProtection;

  private readonly listeners = new Map<EngineEvent, Set<EngineEventListener>>();

  private initialized = false;
  private processing = false;
  private activeProcessing = 0;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebhookEngineOptions) {
    this.storage = options.storage;
    this.verifier = options.verifier;
    this.retryPolicy = resolveRetryPolicy(options.retryPolicy);
    this.retryInterval = options.retryInterval ?? 5_000;
    this.maxTimestampAge = options.maxTimestampAge ?? 300_000;
    this.processingTimeout = options.processingTimeout ?? 30_000;
    this.concurrency = options.concurrency ?? 10;
    this.logger = options.logger;
    this.metrics = options.metrics;

    this.registry = new HandlerRegistry();
    this.processor = new EventProcessor(this.registry, {
      retryPolicy: this.retryPolicy,
      processingTimeout: this.processingTimeout,
    });
    this.replayProtection = new ReplayProtection({
      maxTimestampAge: this.maxTimestampAge,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Initialise the engine and its storage backend. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.logger?.info('Initializing WebhookEngine');
    await this.storage.initialize();
    this.initialized = true;
    this.startRetryLoop();
  }

  /** Gracefully shut down – waits for in-flight processing (up to 10 s). */
  async shutdown(): Promise<void> {
    this.logger?.info('Shutting down WebhookEngine');
    this.stopRetryLoop();
    this.processing = false;

    const deadline = Date.now() + 10_000;
    while (this.activeProcessing > 0 && Date.now() < deadline) {
      await this.sleep(100);
    }

    await this.storage.shutdown();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for a specific event type.
   * Use `"*"` to handle all events.
   */
  register(eventType: string, handler: EventHandler): void {
    this.registry.register(eventType, handler);
    this.logger?.debug('Registered handler for event type', { eventType });
  }

  /** Remove all handlers for the given event type. */
  unregister(eventType: string): void {
    this.registry.unregister(eventType);
    this.logger?.debug('Unregistered handler for event type', { eventType });
  }

  // ---------------------------------------------------------------------------
  // Ingestion pipeline
  // ---------------------------------------------------------------------------

  /**
   * Ingest an incoming webhook request.
   *
   * Pipeline: parse → verify → deduplicate → persist → process (async).
   */
  async ingest(request: IngestRequest): Promise<IngestResult> {
    this.ensureInitialized();

    // 1. Parse ------------------------------------------------------------------
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(request.rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      this.logger?.warn('Failed to parse webhook JSON payload');
      return this.result(400, 'Invalid JSON payload', 'INVALID_PAYLOAD');
    }

    // 2. Verify -----------------------------------------------------------------
    const verification = await this.verifier.verify({
      headers: request.headers,
      rawBody: request.rawBody,
    });
    if (!verification.verified) {
      this.logger?.warn('Webhook signature verification failed', { reason: verification.reason });
      return this.result(401, 'Signature verification failed', verification.reason ?? 'VERIFICATION_FAILED');
    }

    // 3. Extract metadata -------------------------------------------------------
    const eventId = this.extractField(parsedBody, ['id', 'eventId', 'event_id', 'webhookId', 'webhook_id']);
    const eventType = this.extractField(parsedBody, ['type', 'eventType', 'event_type', 'event', 'action']);

    if (!eventId || !eventType) {
      this.logger?.warn('Missing event id or type in webhook payload');
      return this.result(422, 'Missing event id or type', 'MISSING_FIELDS');
    }

    // 4. Replay / nonce check ---------------------------------------------------
    if (!this.replayProtection.checkNonce(eventId)) {
      this.logger?.warn('Duplicate event caught by replay protection', { eventId, provider: request.provider });
      return this.result(409, 'Duplicate event', 'DUPLICATE_EVENT', eventId);
    }

    // 5. Build event ------------------------------------------------------------
    const event: WebhookEvent = {
      eventId,
      provider: request.provider,
      type: eventType,
      data: parsedBody['data'] ?? parsedBody,
      headers: request.headers,
      rawBody: request.rawBody,
      receivedAt: new Date(),
      status: 'RECEIVED',
      attempts: 0,
      metadata: {},
    };

    this.metrics?.recordEventIngested?.(request.provider, eventType);
    this.emit('event.received', event);

    // 6. Verify → Pending -------------------------------------------------------
    this.transition(event, 'VERIFIED');
    this.emit('event.verified', event);

    // 7. Persist (atomic dedup) -------------------------------------------------
    this.transition(event, 'PENDING');
    try {
      await this.storage.storeEvent(event);
    } catch (error) {
      if (error instanceof DuplicateEventError) {
        this.logger?.warn('Duplicate event caught by storage layer', { eventId, provider: request.provider });
        return this.result(409, 'Duplicate event', 'DUPLICATE_EVENT', eventId);
      }
      throw error;
    }
    this.emit('event.pending', event);

    // 8. Process (fire-and-forget) ----------------------------------------------
    this.processEventAsync(event).catch(() => {
      // Errors are handled inside processEventAsync.
    });

    return this.result(200, 'Event accepted', undefined, eventId);
  }

  // ---------------------------------------------------------------------------
  // Dead-letter management & Event Inspection
  // ---------------------------------------------------------------------------

  /** Look up an event by its ID and provider. */
  async getEvent(eventId: string, provider: string): Promise<WebhookEvent | null> {
    this.ensureInitialized();
    return this.storage.findEvent(eventId, provider);
  }

  /** Query events with optional filter. */
  async listEvents(filter: EventQueryFilter): Promise<WebhookEvent[]> {
    this.ensureInitialized();
    if (this.storage.queryEvents) {
      return this.storage.queryEvents(filter);
    }
    return [];
  }

  /** Re-queue dead-lettered events for processing. Returns the count retried. */
  async retryDeadLetters(filter?: DeadLetterFilter): Promise<number> {
    this.ensureInitialized();
    const events = await this.storage.getDeadLetterEvents(filter);
    let retried = 0;

    for (const event of events) {
      try {
        event.attempts = 0;
        this.transition(event, 'RETRYING');
        await this.storage.updateEventStatus(event.eventId, event.provider, 'RETRYING');
        this.emit('event.retrying', event);
        this.processEventAsync(event).catch(() => {});
        retried++;
      } catch {
        // Skip events whose state doesn't allow the transition.
      }
    }
    return retried;
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  /** Subscribe to an engine lifecycle event. */
  on(engineEvent: EngineEvent, listener: EngineEventListener): void {
    let set = this.listeners.get(engineEvent);
    if (!set) {
      set = new Set();
      this.listeners.set(engineEvent, set);
    }
    set.add(listener);
  }

  /** Unsubscribe from an engine lifecycle event. */
  off(engineEvent: EngineEvent, listener: EngineEventListener): void {
    this.listeners.get(engineEvent)?.delete(listener);
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private async processEventAsync(event: WebhookEvent): Promise<void> {
    if (this.activeProcessing >= this.concurrency) {
      // Will be picked up by the retry loop.
      return;
    }

    this.activeProcessing++;
    const startTime = Date.now();
    try {
      const claimed = await this.storage.claimEvent(event.eventId, event.provider);
      if (!claimed) return;

      try {
        // PROCESSING
        this.transition(event, 'PROCESSING');
        event.attempts++;
        event.lastAttemptAt = new Date();
        await this.storage.updateEventStatus(event.eventId, event.provider, 'PROCESSING');
        this.emit('event.processing', event);

        const result = await this.processor.process(event);
        const durationMs = Date.now() - startTime;

        if (result.success) {
          // COMPLETED
          this.transition(event, 'COMPLETED');
          await this.storage.updateEventStatus(event.eventId, event.provider, 'COMPLETED');
          this.metrics?.recordEventProcessed?.(event.provider, event.type, durationMs, true);
          this.emit('event.completed', event);
        } else if (result.retryable) {
          // FAILED → RETRYING (retry loop will re-process after delay)
          this.transition(event, 'FAILED');
          event.lastError = result.error;
          await this.storage.updateEventStatus(event.eventId, event.provider, 'FAILED', result.error);
          this.emit('event.failed', event);

          this.transition(event, 'RETRYING');
          await this.storage.updateEventStatus(event.eventId, event.provider, 'RETRYING');
          this.metrics?.recordRetry?.(event.provider, event.type, event.attempts);
          this.emit('event.retrying', event);
        } else {
          // Permanent failure → FAILED → DEAD_LETTER
          this.transition(event, 'FAILED');
          event.lastError = result.error;
          await this.storage.updateEventStatus(event.eventId, event.provider, 'FAILED', result.error);
          this.emit('event.failed', event);

          this.transition(event, 'DEAD_LETTER');
          await this.storage.updateEventStatus(event.eventId, event.provider, 'DEAD_LETTER');
          this.metrics?.recordEventProcessed?.(event.provider, event.type, durationMs, false);
          this.metrics?.recordDeadLetter?.(event.provider, event.type);
          this.emit('event.deadLetter', event);
        }
      } finally {
        await this.storage.releaseEvent(event.eventId, event.provider);
      }
    } finally {
      this.activeProcessing--;
    }
  }

  // ---- Retry loop -----------------------------------------------------------

  private startRetryLoop(): void {
    this.processing = true;
    this.retryTimer = setInterval(() => {
      this.processRetryableEvents().catch(() => {});
    }, this.retryInterval);

    // Don't keep the process alive just for the retry timer.
    if (this.retryTimer.unref) {
      this.retryTimer.unref();
    }
  }

  private stopRetryLoop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async processRetryableEvents(): Promise<void> {
    if (!this.processing || !this.initialized) return;

    const events = await this.storage.getRetryableEvents();

    for (const event of events) {
      if (this.activeProcessing >= this.concurrency) break;

      const retryInfo = this.processor.getRetryInfo(event.attempts);

      if (!retryInfo.shouldRetry) {
        // Exhausted → dead letter.
        try {
          if (canTransition(event.status, 'DEAD_LETTER')) {
            event.status = 'DEAD_LETTER';
            await this.storage.updateEventStatus(event.eventId, event.provider, 'DEAD_LETTER');
            this.metrics?.recordDeadLetter?.(event.provider, event.type);
            this.emit('event.deadLetter', event);
          }
        } catch {
          // Skip on error.
        }
        continue;
      }

      // Check if enough time has passed since the last attempt.
      if (event.lastAttemptAt) {
        const elapsed = Date.now() - event.lastAttemptAt.getTime();
        if (elapsed < retryInfo.delay) continue;
      }

      if (canTransition(event.status, 'PROCESSING')) {
        this.processEventAsync(event).catch(() => {});
      }
    }
  }

  // ---- Helpers --------------------------------------------------------------

  private transition(event: WebhookEvent, to: EventStatus): void {
    validateTransition(event.status, to);
    event.status = to;
  }

  private emit(engineEvent: EngineEvent, event: WebhookEvent): void {
    const set = this.listeners.get(engineEvent);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // Never let a listener error break the pipeline.
      }
    }
  }

  private extractField(body: Record<string, unknown>, candidates: string[]): string | undefined {
    for (const key of candidates) {
      const value = body[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  private result(
    status: number,
    message: string,
    error?: string,
    eventId?: string,
  ): IngestResult {
    return {
      status,
      body: {
        ...(eventId ? { eventId } : {}),
        message,
        ...(error ? { error } : {}),
      },
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('WebhookEngine is not initialized. Call initialize() first.');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
