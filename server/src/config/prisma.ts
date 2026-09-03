import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env';
import { logger, LogEvent } from '../utils/logger';

// Prisma 7 connects through a driver adapter rather than a `url` in the schema.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log:
    env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
      ? [{ emit: 'stdout', level: 'query' }, 'warn', 'error']
      : ['warn', 'error'],
});

/**
 * Verifies the database is actually reachable. Called on startup by both the
 * API and the worker: a process that cannot reach Postgres must not report
 * itself healthy.
 */
export async function assertDatabaseConnection(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info({ event: LogEvent.DEPENDENCY_OK, dependency: 'postgres' }, 'PostgreSQL connection verified');
  } catch (error) {
    logger.error(
      { event: LogEvent.DEPENDENCY_FAILED, dependency: 'postgres', err: error },
      'PostgreSQL connection failed',
    );
    throw error;
  }
}
