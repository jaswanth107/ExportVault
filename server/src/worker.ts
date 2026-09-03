import { assertDatabaseConnection, prisma } from './config/prisma';
import { assertRedisConnection, closeRedisConnection } from './config/redis';
import { assertStorageReady } from './services/storage.service';
import { createExportWorker } from './workers/export.worker';
import { startWorkerHealthServer } from './workers/health.server';
import { logger, LogEvent } from './utils/logger';
import { env } from './config/env';

/**
 * Worker process entrypoint.
 * Every dependency is verified before a single job is accepted — a worker that
 * cannot reach Postgres, Redis or object storage exits non-zero instead of
 * quietly consuming jobs and failing them.
 */
async function main(): Promise<void> {
  await assertDatabaseConnection();
  await assertRedisConnection();
  await assertStorageReady();

  const worker = createExportWorker();

  // Render's free tier has no background-worker service type, so the worker can
  // be deployed as a port-binding service instead. PORT is what such hosts
  // inject; WORKER_HEALTH_PORT allows setting it explicitly.
  const healthPort = env.WORKER_HEALTH_PORT ?? (process.env.RENDER ? env.PORT : undefined);
  const healthServer = healthPort
    ? startWorkerHealthServer({ port: healthPort, worker })
    : null;

  logger.info(
    {
      event: LogEvent.SERVER_STARTED,
      role: 'worker',
      concurrency: env.WORKER_CONCURRENCY,
      healthPort: healthPort ?? null,
      crashAfterRows: env.EXPORT_CRASH_AFTER_ROWS ?? null,
    },
    'Export worker started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down');
    try {
      healthServer?.close();
      await worker.close();
      await closeRedisConnection();
      await prisma.$disconnect();
    } catch (error) {
      logger.error({ err: error }, 'Error during worker shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
