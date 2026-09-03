// Must run before anything opens a socket.
import { configureDns } from './config/dns';

import { createApp } from './app';
import { env } from './config/env';
import { assertDatabaseConnection, prisma } from './config/prisma';
import { assertRedisConnection, closeRedisConnection } from './config/redis';
import { assertStorageReady } from './services/storage.service';
import { closeExportQueue } from './queues/export.queue';
import { startStalledExportSweeper, stopStalledExportSweeper } from './services/stalledJobs.service';
import { logger, LogEvent } from './utils/logger';

/**
 * API process entrypoint.
 *
 * Startup verifies every dependency before the server binds a port. If Postgres,
 * Redis or object storage is unreachable, the process exits non-zero so the
 * platform restarts it — it never boots into a state where exports would be
 * accepted and then silently fail.
 */
async function main(): Promise<void> {
  configureDns();
  await assertDatabaseConnection();
  await assertRedisConnection();
  await assertStorageReady();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { event: LogEvent.SERVER_STARTED, role: 'api', port: env.PORT, nodeEnv: env.NODE_ENV },
      `ExportVault API listening on port ${env.PORT}`,
    );
  });

  // The API outlives individual workers, so it owns the stalled-job sweeper:
  // a worker that dies mid-export gets its job flipped to INTERRUPTED and the
  // failure becomes visible in the API and UI.
  startStalledExportSweeper();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'API shutting down');
    stopStalledExportSweeper();
    server.close();
    try {
      await closeExportQueue();
      await closeRedisConnection();
      await prisma.$disconnect();
    } catch (error) {
      logger.error({ err: error }, 'Error during API shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
});
