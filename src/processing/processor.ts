// ---------------------------------------------------------------------------
// Event processor – executes handlers and classifies errors.
// ---------------------------------------------------------------------------

import type { WebhookEvent, RetryPolicy } from '../core/types.js';
import type { HandlerRegistry } from './handler-registry.js';
import { calculateDelay, shouldRetry, resolveRetryPolicy } from './retry-policy.js';
import { WebhookError, RetryableError, PermanentError } from '../core/errors.js';

/**
 * Options for the {@link EventProcessor}.
 */
export interface ProcessorOptions {
  retryPolicy?: Partial<RetryPolicy>;
  processingTimeout?: number;
}

/**
 * Outcome of processing a single event.
 */
export interface ProcessResult {
  success: boolean;
  error?: string;
  retryable: boolean;
  nextRetryDelay?: number;
}

/**
 * Executes registered handlers for an event and classifies the outcome
 * as success, retryable failure, or permanent failure.
 */
export class EventProcessor {
  private readonly registry: HandlerRegistry;
  private readonly retryPolicy: RetryPolicy;
  private readonly processingTimeout: number;

  constructor(registry: HandlerRegistry, options?: ProcessorOptions) {
    this.registry = registry;
    this.retryPolicy = resolveRetryPolicy(options?.retryPolicy);
    this.processingTimeout = options?.processingTimeout ?? 30_000;
  }

  /**
   * Process an event by executing every matching handler in sequence.
   */
  async process(event: WebhookEvent): Promise<ProcessResult> {
    const handlers = this.registry.getHandlers(event.type);

    if (handlers.length === 0) {
      // No handlers → consider the event acknowledged-but-unhandled.
      return { success: true, retryable: false };
    }

    try {
      await this.executeWithTimeout(async () => {
        for (const handler of handlers) {
          await handler(event);
        }
      }, this.processingTimeout);

      return { success: true, retryable: false };
    } catch (error) {
      return this.classifyError(error, event.attempts);
    }
  }

  /**
   * Determine whether the event should be retried and, if so, the delay.
   */
  getRetryInfo(attempts: number): { shouldRetry: boolean; delay: number } {
    if (!shouldRetry(attempts, this.retryPolicy)) {
      return { shouldRetry: false, delay: 0 };
    }
    return {
      shouldRetry: true,
      delay: calculateDelay(attempts, this.retryPolicy),
    };
  }

  // ---- Private ----

  private classifyError(error: unknown, attempts: number): ProcessResult {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof PermanentError) {
      return { success: false, error: message, retryable: false };
    }

    if (error instanceof RetryableError) {
      return this.buildRetryResult(message, attempts);
    }

    if (error instanceof WebhookError) {
      return error.isRetryable
        ? this.buildRetryResult(message, attempts)
        : { success: false, error: message, retryable: false };
    }

    // Unknown errors are treated as retryable.
    return this.buildRetryResult(message, attempts);
  }

  private buildRetryResult(error: string, attempts: number): ProcessResult {
    const info = this.getRetryInfo(attempts);
    return {
      success: false,
      error,
      retryable: info.shouldRetry,
      nextRetryDelay: info.shouldRetry ? info.delay : undefined,
    };
  }

  private executeWithTimeout(fn: () => Promise<void>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RetryableError(`Handler timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

