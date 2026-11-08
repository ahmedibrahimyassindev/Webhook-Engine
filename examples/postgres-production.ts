/**
 * Example: Production setup with PostgreSQL, custom retry policy, and structured logging
 *
 * Run with: npx tsx examples/postgres-production.ts
 */

import {
  WebhookEngine,
  PostgresStorageAdapter,
  HmacVerifier,
  type Logger,
  type MetricsCollector,
  RetryableError,
  PermanentError,
} from '../src/index.js';

// Custom logger
const logger: Logger = {
  debug: (msg, ctx) => console.debug(`[DEBUG] ${msg}`, ctx ?? ''),
  info: (msg, ctx) => console.log(`[INFO]  ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`[WARN]  ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx ?? ''),
};

// Custom metrics telemetry
const metrics: MetricsCollector = {
  recordEventIngested: (provider, type) => {
    console.log(`[Metric] Ingested: ${provider} / ${type}`);
  },
  recordEventProcessed: (provider, type, durationMs, success) => {
    console.log(`[Metric] Processed in ${durationMs}ms (success: ${success})`);
  },
  recordRetry: (provider, type, attempt) => {
    console.log(`[Metric] Retrying attempt ${attempt} for ${provider} / ${type}`);
  },
  recordDeadLetter: (provider, type) => {
    console.log(`[Metric] DEAD LETTER for ${provider} / ${type}`);
  },
};

async function main() {
  // In real production, import { Pool } from 'pg'
  // const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const mockPool = {
    query: async (sql: string, values?: unknown[]) => {
      console.log(`[SQL Query]`, sql.trim().split('\n')[0], values ?? []);
      return { rows: [], rowCount: 1 };
    },
  };

  const engine = new WebhookEngine({
    storage: new PostgresStorageAdapter({
      pool: mockPool,
      tableName: 'production_webhooks',
      lockTimeoutSeconds: 60,
    }),
    verifier: new HmacVerifier({
      secret: process.env.WEBHOOK_SECRET ?? 'secret_123',
      algorithm: 'sha256',
      signatureHeader: 'x-custom-signature',
      timestampHeader: 'x-custom-timestamp',
      maxTimestampAge: 300_000,
    }),
    retryPolicy: {
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: 'decorrelated',
    },
    concurrency: 20,
    logger,
    metrics,
  });

  engine.register('invoice.paid', async (event) => {
    const data = event.data as Record<string, unknown>;
    if (!data['invoiceId']) {
      throw new PermanentError('Invalid invoice payload missing invoiceId');
    }
    // Business logic
  });

  await engine.initialize();
  console.log('Production Webhook Engine initialized successfully.');
}

main().catch(console.error);

