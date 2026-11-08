// ---------------------------------------------------------------------------
// MySQL storage adapter for persistent webhook processing.
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
 * Minimal queryable client interface compatible with `mysql2/promise` (Pool or Connection).
 */
export interface MysqlQueryable {
  query<R = unknown>(
    sql: string,
    values?: unknown[],
  ): Promise<[R, unknown]>;
}

export interface MysqlStorageOptions {
  /** A mysql2 `Pool` or `Connection` instance. */
  pool: MysqlQueryable;
  /** Table name to store webhook events (default `"webhook_events"`). */
  tableName?: string;
  /** Lock timeout duration in seconds for in-flight claims (default 60). */
  lockTimeoutSeconds?: number;
  /** Automatically run table migration on initialize (default true). */
  autoMigrate?: boolean;
}

interface MysqlOkPacket {
  affectedRows: number;
  insertId?: number;
}

/**
 * Storage adapter backed by MySQL with unique composite primary key constraints
 * and row-level distributed lease locks.
 */
export class MysqlStorageAdapter implements StorageAdapter {
  private readonly pool: MysqlQueryable;
  private readonly table: string;
  private readonly lockTimeoutSeconds: number;
  private readonly autoMigrate: boolean;
  private readonly workerId: string;

  constructor(options: MysqlStorageOptions) {
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
        data JSON NOT NULL,
        headers JSON NOT NULL,
        raw_body LONGBLOB NOT NULL,
        received_at DATETIME(3) NOT NULL,
        status VARCHAR(50) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_attempt_at DATETIME(3) NULL,
        last_error TEXT NULL,
        metadata JSON NULL,
        locked_at DATETIME(3) NULL,
        locked_by VARCHAR(255) NULL,
        PRIMARY KEY (event_id, provider),
        INDEX idx_status_retry (status, last_attempt_at)
      ) ENGINE=InnoDB;
    `);
  }

  async shutdown(): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table} SET locked_at = NULL, locked_by = NULL WHERE locked_by = ?`,
      [this.workerId],
    ).catch(() => {});
  }

  async storeEvent(event: WebhookEvent): Promise<void> {
    const query = `
      INSERT INTO ${this.table} (
        event_id, provider, type, data, headers, raw_body,
        received_at, status, attempts, last_attempt_at, last_error, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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

    try {
      await this.pool.query(query, values);
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
        throw new DuplicateEventError(event.eventId);
      }
      throw err;
    }
  }

  async findEvent(eventId: string, provider: string): Promise<WebhookEvent | null> {
    const query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE event_id = ? AND provider = ?;
    `;

    const [rows] = await this.pool.query<Record<string, unknown>[]>(query, [eventId, provider]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return this.mapRowToEvent(rows[0]!);
  }

  async updateEventStatus(
    eventId: string,
    provider: string,
    status: EventStatus,
    error?: string,
  ): Promise<void> {
    const query = `
      UPDATE ${this.table}
      SET status = ?,
          last_error = COALESCE(?, last_error),
          last_attempt_at = CASE WHEN ? IN ('PROCESSING', 'RETRYING') THEN NOW(3) ELSE last_attempt_at END
      WHERE event_id = ? AND provider = ?;
    `;

    await this.pool.query(query, [status, error ?? null, status, eventId, provider]);
  }

  async claimEvent(eventId: string, provider: string): Promise<boolean> {
    const query = `
      UPDATE ${this.table}
      SET locked_at = NOW(3),
          locked_by = ?
      WHERE event_id = ?
        AND provider = ?
        AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(3), INTERVAL ? SECOND));
    `;

    const [result] = await this.pool.query<MysqlOkPacket>(query, [
      this.workerId,
      eventId,
      provider,
      this.lockTimeoutSeconds,
    ]);

    return (result?.affectedRows ?? 0) > 0;
  }

  async releaseEvent(eventId: string, provider: string): Promise<void> {
    const query = `
      UPDATE ${this.table}
      SET locked_at = NULL,
          locked_by = NULL
      WHERE event_id = ? AND provider = ?;
    `;

    await this.pool.query(query, [eventId, provider]);
  }

  async getRetryableEvents(): Promise<WebhookEvent[]> {
    const query = `
      SELECT event_id, provider, type, data, headers, raw_body,
             received_at, status, attempts, last_attempt_at, last_error, metadata
      FROM ${this.table}
      WHERE status IN ('FAILED', 'RETRYING')
        AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(3), INTERVAL ? SECOND))
      ORDER BY received_at ASC
      LIMIT 100;
    `;

    const [rows] = await this.pool.query<Record<string, unknown>[]>(query, [this.lockTimeoutSeconds]);
    return (Array.isArray(rows) ? rows : []).map((row) => this.mapRowToEvent(row));
  }

  async getDeadLetterEvents(filter?: DeadLetterFilter): Promise<WebhookEvent[]> {
    const conditions = ["status = 'DEAD_LETTER'"];
    const values: unknown[] = [];

    if (filter?.provider) {
      conditions.push('provider = ?');
      values.push(filter.provider);
    }
    if (filter?.eventType) {
      conditions.push('type = ?');
      values.push(filter.eventType);
    }
    if (filter?.since) {
      conditions.push('received_at >= ?');
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
      query += ' LIMIT ?';
      values.push(filter.limit);
    }

    const [rows] = await this.pool.query<Record<string, unknown>[]>(query, values);
    return (Array.isArray(rows) ? rows : []).map((row) => this.mapRowToEvent(row));
  }

  async queryEvents(filter: EventQueryFilter): Promise<WebhookEvent[]> {
    const conditions: string[] = ['1=1'];
    const values: unknown[] = [];

    if (filter.provider) {
      conditions.push('provider = ?');
      values.push(filter.provider);
    }
    if (filter.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter.eventType) {
      conditions.push('type = ?');
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
      query += ' LIMIT ?';
      values.push(filter.limit);
    }
    if (filter.offset) {
      query += ' OFFSET ?';
      values.push(filter.offset);
    }

    const [rows] = await this.pool.query<Record<string, unknown>[]>(query, values);
    return (Array.isArray(rows) ? rows : []).map((row) => this.mapRowToEvent(row));
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

