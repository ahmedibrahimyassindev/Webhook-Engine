/**
 * Example: Ingesting GitHub webhooks with Fastify
 *
 * Run with: npx tsx examples/fastify-github.ts
 */

import Fastify from 'fastify';
import {
  WebhookEngine,
  MemoryStorage,
  GitHubVerifier,
  createFastifyPlugin,
} from '../src/index.js';

async function main() {
  const engine = new WebhookEngine({
    storage: new MemoryStorage(),
    verifier: new GitHubVerifier(process.env.GITHUB_WEBHOOK_SECRET ?? 'gh_secret_123'),
  });

  // Handle specific push events
  engine.register('push', async (event) => {
    console.log(`Processing push event: ${event.eventId}`);
  });

  // Wildcard handler for all GitHub events
  engine.register('*', async (event) => {
    console.log(`[Audit] Received event ${event.type} (${event.eventId})`);
  });

  await engine.initialize();

  const fastify = Fastify({ logger: true });

  // Register engine plugin on /webhooks/github
  fastify.register(
    createFastifyPlugin(engine, {
      provider: 'github',
      path: '/webhooks/github',
    }),
  );

  const port = Number(process.env.PORT ?? 3001);
  await fastify.listen({ port });
  console.log(`GitHub webhook listener running on port ${port}`);
}

main().catch(console.error);

