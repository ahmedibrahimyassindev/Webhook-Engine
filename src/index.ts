// ---------------------------------------------------------------------------
// Public API – re-exports everything consumers need.
// ---------------------------------------------------------------------------

// Core
export { WebhookEngine } from './core/engine.js';
export type {
  WebhookEngineOptions,
  WebhookEvent,
  EventHandler,
  EventStatus,
  IngestRequest,
  IngestResult,
  SignatureVerifier,
  VerificationContext,
  VerificationResult,
  StorageAdapter,
  DeadLetterFilter,
  EventQueryFilter,
  RetryPolicy,
  EngineEvent,
  EngineEventListener,
  Logger,
  MetricsCollector,
} from './core/types.js';

// Errors
export {
  WebhookError,
  RetryableError,
  PermanentError,
  VerificationError,
  DuplicateEventError,
  InvalidStateTransitionError,
} from './core/errors.js';

// Event state machine
export { validateTransition, canTransition, isTerminalState } from './core/event-state.js';

// Security
export { NoOpVerifier } from './security/verifier.js';
export { HmacVerifier } from './security/hmac-verifier.js';
export type { HmacVerifierOptions } from './security/hmac-verifier.js';
export { GitHubVerifier, StripeVerifier, ShopifyVerifier, SvixVerifier } from './security/presets.js';
export type { StripeVerifierOptions, SvixVerifierOptions } from './security/presets.js';
export { computeHmac, timingSafeCompare } from './security/signature.js';
export { ReplayProtection } from './security/replay-protection.js';
export type { ReplayProtectionOptions } from './security/replay-protection.js';
export { captureRawBody, getOrReadRawBody } from './security/raw-body.js';
export type { RawBodyOptions } from './security/raw-body.js';

// Storage
export { MemoryStorage } from './storage/memory-storage.js';
export { PostgresStorageAdapter } from './storage/pg-storage.js';
export type { PostgresStorageOptions, PgQueryable } from './storage/pg-storage.js';
export { MysqlStorageAdapter } from './storage/mysql-storage.js';
export type { MysqlStorageOptions, MysqlQueryable } from './storage/mysql-storage.js';
export { RedisStorageAdapter, RedisLockManager } from './storage/redis-storage.js';
export type { RedisStorageOptions, RedisClient } from './storage/redis-storage.js';

// Processing
export { HandlerRegistry } from './processing/handler-registry.js';
export { EventProcessor } from './processing/processor.js';
export type { ProcessorOptions, ProcessResult } from './processing/processor.js';
export {
  calculateDelay,
  shouldRetry,
  resolveRetryPolicy,
  DEFAULT_RETRY_POLICY,
} from './processing/retry-policy.js';

// Integrations
export { createExpressMiddleware } from './integrations/express/index.js';
export type { ExpressMiddlewareOptions } from './integrations/express/index.js';
export { createFastifyPlugin } from './integrations/fastify/index.js';
export type { FastifyPluginOptions } from './integrations/fastify/index.js';
export {
  WebhookService,
  createWebhookProviders,
  WEBHOOK_ENGINE,
  WEBHOOK_ENGINE_OPTIONS,
} from './integrations/nestjs/index.js';
export type { NestWebhookModuleOptions } from './integrations/nestjs/index.js';

// Testing utilities
export { createMockWebhookEvent, simulateWebhook } from './testing/index.js';
