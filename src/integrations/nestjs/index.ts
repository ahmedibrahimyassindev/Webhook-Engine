// ---------------------------------------------------------------------------
// NestJS integration for Node Webhook Engine.
// ---------------------------------------------------------------------------

import type { WebhookEngine } from '../../core/engine.js';
import type { WebhookEngineOptions, IngestRequest, IngestResult, EventHandler } from '../../core/types.js';

export const WEBHOOK_ENGINE_OPTIONS = Symbol('WEBHOOK_ENGINE_OPTIONS');
export const WEBHOOK_ENGINE = Symbol('WEBHOOK_ENGINE');

/**
 * Service wrapper for interacting with the WebhookEngine in NestJS applications.
 */
export class WebhookService {
  constructor(public readonly engine: WebhookEngine) {}

  /** Register an event handler */
  register(eventType: string, handler: EventHandler): void {
    this.engine.register(eventType, handler);
  }

  /** Ingest an incoming webhook request */
  async ingest(request: IngestRequest): Promise<IngestResult> {
    return this.engine.ingest(request);
  }
}

/**
 * Factory for creating a dynamic NestJS WebhookModule.
 */
export interface NestWebhookModuleOptions extends WebhookEngineOptions {}

/**
 * Helper to register and configure NestJS providers for WebhookEngine.
 *
 * Example:
 * ```ts
 * @Module({
 *   providers: createWebhookProviders(options),
 *   exports: [WebhookService, WEBHOOK_ENGINE],
 * })
 * export class WebhookModule {}
 * ```
 */
export function createWebhookProviders(options: NestWebhookModuleOptions) {
  return [
    {
      provide: WEBHOOK_ENGINE_OPTIONS,
      useValue: options,
    },
    {
      provide: WEBHOOK_ENGINE,
      useFactory: async (opts: WebhookEngineOptions) => {
        const { WebhookEngine } = await import('../../core/engine.js');
        const engine = new WebhookEngine(opts);
        await engine.initialize();
        return engine;
      },
      inject: [WEBHOOK_ENGINE_OPTIONS],
    },
    {
      provide: WebhookService,
      useFactory: (engine: WebhookEngine) => new WebhookService(engine),
      inject: [WEBHOOK_ENGINE],
    },
  ];
}

