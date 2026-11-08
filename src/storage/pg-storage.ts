// ---------------------------------------------------------------------------
// PostgreSQL storage adapter for production webhook persistence.
// ---------------------------------------------------------------------------

import type {
  StorageAdapter,
  WebhookEvent,
  EventStatus,
  DeadLetterFilter,
  EventQueryFilter,
} from '../core/types.js';
import { DuplicateEventError } from '../core/errors.js';

/**
 * Minimal queryable client interface (compatible with `pg.Pool` or `pg.Client`).
 */
export interface PgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/**
 * Options for {@link PostgresStorageAdapter}.
 */
export interface PostgresStorageOptions {
  /** A node-postgres `Pool` or client instance. */
  pool: PgQueryable;
  /** Table name to store webhook events (default `"webhook_events"`). */
  tableName?: string;
  /** Lock timeout duration in seconds for in-flight claims (default 60). */
  lockTimeoutSeconds?: number;
  /** Automatically run table migration on initialize (default true). */
  autoMigrate?: boolean;
}

/**
 * Storage adapter backed by PostgreSQL with atomic uniqueness constraints
 * and row-level distributed claim locks.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  private readonly pool: PgQueryable;
  private readonly table: string;
  private readonly lockTimeoutSeconds: number;
  private readonly autoMigrate: boolean;
  private readonly workerId: string;

  constructor(options: PostgresStorageOptions) {
    this.pool = options.pool;
    this.table = options.tableName ?? 'webhook_events';
    this.lockTimeoutSeconds = options.lockTimeoutSeconds ?? 60;
    this.autoMigrate = options.autoMigrate ?? true;
    this.workerId = `worker_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
  }

  async initialize(): Promise<void> {
    if (!this.autoMigrate) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        event_id VARCHAR(255) NOT NULL,
        provider VARCHAR(100) NOT NULL,
        type VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        headers JSONB NOT NULL,
        raw_body BYTEA NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(50) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        metadata JSONB DEFAULT '{}',
        locked_at TIMESTAMPTZ,
        locked_by VARCHAR(255),
        PRIMARY KEY (event_id, provider)
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_status_retry
      ON ${this.table} (status, last_attempt_at);
    `);
  }

  async shutdown(): Promise<void> {
    // Release any lingering locks held by this worker
    await this.pool.query(
      `UPDATE ${this.table} SET locked_at = NULL, locked_by = NULL WHERE locked_by = $1`,
      [this.workerId],
    ).catch(() => {});
  }

  async storeEvent(event: WebhookEvent): Promise<void> {
    const query = `
      INSERT INTO ${this.table} (
        event_id, provider, type, data, headers, raw_body,
        received_at, status, attempts, last_attempt_at, last_error, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (event_id, provider) DO NOTHING
      RETURNING event_id;
    `;

    const values = [
      event.eventId,
      event.provider,
      event.type,
      JSON.stringify(event.data),
      JSON.stringify(event.headers),
      event.rawBody,
      event.receivedAt,
      event.status,
      event.attempts,
      event.lastAttemptAt ?? null,
      event.lastError ?? null,
      JSON.stringify(event.metadata ?? {}),
    ];

    const res = await this.pool.query(query, values);
    if ((res.rowCount ?? 0) === 0) {
      throw new DuplicateEventError(event.eventId);
    }
  }

  async findEvent(eventId: string, provider: string): Promise<WebhookEvent | null> {
    const query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE event_id = $1 AND provider = $2;
    `;

    const res = await this.pool.query(query, [eventId, provider]);
    if (res.rows.length === 0) return null;
    return this.mapRowToEvent(res.rows[0]!);
  }

  async updateEventStatus(
    eventId: string,
    provider: string,
    status: EventStatus,
    error?: string,
  ): Promise<void> {
    const query = `
      UPDATE ${this.table}
      SET status = $1,
          last_error = COALESCE($2, last_error),
          last_attempt_at = CASE WHEN $1 IN ('PROCESSING', 'RETRYING') THEN NOW() ELSE last_attempt_at END
      WHERE event_id = $3 AND provider = $4;
    `;

    await this.pool.query(query, [status, error ?? null, eventId, provider]);
  }

  async claimEvent(eventId: string, provider: string): Promise<boolean> {
    const query = `
      UPDATE ${this.table}
      SET locked_at = NOW(),
          locked_by = $1
      WHERE event_id = $2
        AND provider = $3
        AND (locked_at IS NULL OR locked_at < NOW() - make_interval(secs => $4))
      RETURNING event_id;
    `;

    const res = await this.pool.query(query, [
      this.workerId,
      eventId,
      provider,
      this.lockTimeoutSeconds,
    ]);

    return (res.rowCount ?? 0) > 0;
  }

  async releaseEvent(eventId: string, provider: string): Promise<void> {
    const query = `
      UPDATE ${this.table}
      SET locked_at = NULL,
          locked_by = NULL
      WHERE event_id = $1 AND provider = $2;
    `;

    await this.pool.query(query, [eventId, provider]);
  }

  async getRetryableEvents(): Promise<WebhookEvent[]> {
    const query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE status IN ('FAILED', 'RETRYING')
        AND (locked_at IS NULL OR locked_at < NOW() - make_interval(secs => $1))
      ORDER BY received_at ASC
      LIMIT 100;
    `;

    const res = await this.pool.query(query, [this.lockTimeoutSeconds]);
    return res.rows.map((row) => this.mapRowToEvent(row));
  }

  async getDeadLetterEvents(filter?: DeadLetterFilter): Promise<WebhookEvent[]> {
    const conditions = ["status = 'DEAD_LETTER'"];
    const values: unknown[] = [];
    let idx = 1;

    if (filter?.provider) {
      conditions.push(`provider = $${idx++}`);
      values.push(filter.provider);
    }
    if (filter?.eventType) {
      conditions.push(`type = $${idx++}`);
      values.push(filter.eventType);
    }
    if (filter?.since) {
      conditions.push(`received_at >= $${idx++}`);
      values.push(filter.since);
    }

    let query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE ${conditions.join(' AND ')}
      ORDER BY received_at DESC
    `;

    if (filter?.limit) {
      query += ` LIMIT $${idx++}`;
      values.push(filter.limit);
    }

    const res = await this.pool.query(query, values);
    return res.rows.map((row) => this.mapRowToEvent(row));
  }

  async queryEvents(filter: EventQueryFilter): Promise<WebhookEvent[]> {
    const conditions: string[] = ['1=1'];
    const values: unknown[] = [];
    let idx = 1;

    if (filter.provider) {
      conditions.push(`provider = $${idx++}`);
      values.push(filter.provider);
    }
    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filter.status);
    }
    if (filter.eventType) {
      conditions.push(`type = $${idx++}`);
      values.push(filter.eventType);
    }

    let query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE ${conditions.join(' AND ')}
      ORDER BY received_at DESC
    `;

    if (filter.limit) {
      query += ` LIMIT $${idx++}`;
      values.push(filter.limit);
    }
    if (filter.offset) {
      query += ` OFFSET $${idx++}`;
      values.push(filter.offset);
    }

    const res = await this.pool.query(query, values);
    return res.rows.map((row) => this.mapRowToEvent(row));
  }

  private mapRowToEvent(row: Record<string, unknown>): WebhookEvent {
    return {
      eventId: String(row['event_id']),
      provider: String(row['provider']),
      type: String(row['type']),
      data: typeof row['data'] === 'string' ? JSON.parse(row['data'] as string) : row['data'],
      headers: typeof row['headers'] === 'string' ? JSON.parse(row['headers'] as string) : (row['headers'] as Record<string, string | string[] | undefined>),
      rawBody: Buffer.isBuffer(row['raw_body']) ? row['raw_body'] : Buffer.from(row['raw_body'] as string),
      receivedAt: new Date(row['received_at'] as string | number),
      status: row['status'] as EventStatus,
      attempts: Number(row['attempts']),
      lastAttemptAt: row['last_attempt_at'] ? new Date(row['last_attempt_at'] as string | number) : undefined,
      lastError: row['last_error'] ? String(row['last_error']) : undefined,
      metadata: typeof row['metadata'] === 'string' ? JSON.parse(row['metadata'] as string) : (row['metadata'] as Record<string, unknown>),
    };
  }
}

