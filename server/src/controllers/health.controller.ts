import type { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { getRedisConnection } from '../config/redis';
import { getQueueHealth } from '../queues/export.queue';
import { objectExists } from '../services/storage.service';
import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';

/** Liveness: is this process up? */
export function health(_req: Request, res: Response): void {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

/**
 * Readiness: are Postgres, Redis, the queue and object storage all actually
 * usable? A failing dependency produces 503 and a logged reason — never a
 * cheerful 200 hiding a broken system.
 */
export async function readiness(_req: Request, res: Response): Promise<void> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = { ok: true };
  } catch (error) {
    checks.postgres = { ok: false, detail: (error as Error).message };
    logger.error({ event: LogEvent.DEPENDENCY_FAILED, dependency: 'postgres', err: error }, 'Readiness: postgres failed');
  }

  try {
    const pong = await getRedisConnection().ping();
    checks.redis = pong === 'PONG' ? { ok: true } : { ok: false, detail: `PING returned ${pong}` };
  } catch (error) {
    checks.redis = { ok: false, detail: (error as Error).message };
    logger.error({ event: LogEvent.DEPENDENCY_FAILED, dependency: 'redis', err: error }, 'Readiness: redis failed');
  }

  try {
    // A HEAD on a key that need not exist still proves the bucket is reachable
    // and the credentials are valid.
    await objectExists('healthcheck/.probe');
    checks.storage = { ok: true, detail: `bucket=${env.S3_BUCKET}` };
  } catch (error) {
    checks.storage = { ok: false, detail: (error as Error).message };
    logger.error({ event: LogEvent.DEPENDENCY_FAILED, dependency: 's3', err: error }, 'Readiness: storage failed');
  }

  let queue: Awaited<ReturnType<typeof getQueueHealth>> | null = null;
  try {
    queue = await getQueueHealth();
    checks.queue = { ok: true, detail: `active=${queue.active} waiting=${queue.waiting}` };
  } catch (error) {
    checks.queue = { ok: false, detail: (error as Error).message };
    logger.error({ event: LogEvent.DEPENDENCY_FAILED, dependency: 'queue', err: error }, 'Readiness: queue failed');
  }

  const ok = Object.values(checks).every((c) => c.ok);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks,
    queue,
  });
}
