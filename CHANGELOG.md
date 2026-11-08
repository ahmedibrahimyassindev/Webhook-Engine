# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-09

### Added
- **Core Engine**:
  - Unified webhook processing pipeline (`parse -> verify -> deduplicate -> persist -> process`).
  - Standardized `WebhookEvent` model with lifecycle state machine (`RECEIVED`, `VERIFIED`, `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETRYING`, `DEAD_LETTER`).
  - Strict state transition validation with `validateTransition` and `canTransition`.
  - Error classification hierarchy: `WebhookError`, `RetryableError`, and `PermanentError`.
- **Processing & Reliability**:
  - `HandlerRegistry` supporting event-type-specific and wildcard (`"*"`) handlers.
  - Asynchronous event processor with handler execution timeouts.
  - Exponential backoff retry policies with configurable decorrelated jitter.
  - Automatic retry worker loop with configurable polling interval (`retryInterval`).
  - Dead Letter Queue (DLQ) tracking and manual recovery API (`retryDeadLetters`).
  - Atomic distributed processing lease locks (`claimEvent` and `releaseEvent`).
- **Security**:
  - Pluggable `SignatureVerifier` interface.
  - `HmacVerifier` supporting SHA-256 and SHA-512 algorithms, custom headers, and timestamp validation.
  - Timing-safe signature comparisons via `crypto.timingSafeEqual`.
  - `ReplayProtection` combining timestamp tolerance bounds with in-memory nonce tracking and automatic cache eviction.
  - Provider presets: `GitHubVerifier` and `StripeVerifier` (handling `${timestamp}.${rawBody}` signing).
  - Raw body preservation utilities: `captureRawBody` with DoS payload size limits, and `getOrReadRawBody`.
- **Storage Adapters**:
  - `MemoryStorage`: High-performance in-memory adapter for testing and development.
  - `PostgresStorageAdapter`: Production relational adapter with table auto-migration, `ON CONFLICT` atomic deduplication, and row-level lease locks.
  - `MysqlStorageAdapter`: MySQL adapter supporting composite primary keys, `ER_DUP_ENTRY` detection, and row lease locks.
  - `RedisStorageAdapter`: High-throughput adapter with `SET NX` atomic deduplication.
  - `RedisLockManager`: Distributed lock manager using safe atomic Lua script release.
- **Integrations**:
  - Express middleware (`createExpressMiddleware`).
  - Fastify route plugin (`createFastifyPlugin`).
  - NestJS dynamic module providers (`createWebhookProviders`) and `WebhookService`.
- **Observability**:
  - Lifecycle event emitter (`event.received`, `event.completed`, `event.failed`, `event.retrying`, `event.deadLetter`).
  - Pluggable structured `Logger` interface.
  - Pluggable `MetricsCollector` interface.
  - Query APIs: `getEvent(eventId, provider)` and `listEvents(filter)`.
- **Developer Experience**:
  - 100% TypeScript source with generated type definitions and source maps.
  - 146 unit, integration, and security tests.
  - Vitest throughput benchmarks (~44,800 to 88,900 ops/sec).

