import http from 'node:http';
import type { Worker } from 'bullmq';
import { prisma } from '../config/prisma';
import { getRedisConnection } from '../config/redis';
import { getQueueHealth } from '../queues/export.queue';
import { logger, LogEvent } from '../utils/logger';

/**
 * Optional HTTP health endpoint for the worker process.
 *
 * The worker does no HTTP work of its own, but two things need it:
 *  - operators want queue-depth and liveness visibility (deployment §28);
 *  - hosts that only offer port-binding services (Render's free tier has no
 *    background-worker type) will not keep a process alive without one.
 *
 * It reports the worker's real state — running flag, Redis reachability and
 * queue counts — and answers 503 when any of that is broken, rather than a
 * blanket 200 that would keep a dead worker looking healthy.
 */
export function startWorkerHealthServer(params: { port: number; worker: Worker }): http.Server {
  const { port, worker } = params;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/health')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    void (async () => {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};

      checks.worker = worker.isRunning()
        ? { ok: true }
        : { ok: false, detail: 'BullMQ worker is not running' };

      try {
        const pong = await getRedisConnection().ping();
        checks.redis = pong === 'PONG' ? { ok: true } : { ok: false, detail: `PING returned ${pong}` };
      } catch (error) {
        checks.redis = { ok: false, detail: (error as Error).message };
        logger.error(
          { event: LogEvent.DEPENDENCY_FAILED, dependency: 'redis', err: error },
          'Worker health: redis unreachable',
        );
      }

      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = { ok: true };
      } catch (error) {
        checks.postgres = { ok: false, detail: (error as Error).message };
        logger.error(
          { event: LogEvent.DEPENDENCY_FAILED, dependency: 'postgres', err: error },
          'Worker health: postgres unreachable',
        );
      }

      let queue: Awaited<ReturnType<typeof getQueueHealth>> | null = null;
      try {
        queue = await getQueueHealth();
      } catch (error) {
        checks.queue = { ok: false, detail: (error as Error).message };
        logger.error({ err: error }, 'Worker health: could not read queue depth');
      }
      if (queue) checks.queue = { ok: true, detail: `active=${queue.active} waiting=${queue.waiting}` };

      const ok = Object.values(checks).every((c) => c.ok);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: ok ? 'ok' : 'unhealthy',
          role: 'worker',
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          checks,
          queue,
        }),
      );
    })();
  });

  server.on('error', (error) => {
    // A health server that cannot bind must not be shrugged off: on hosts that
    // require a bound port it means the deploy will be torn down.
    logger.error({ err: error, port }, 'Worker health server failed');
  });

  server.listen(port, () => {
    logger.info({ role: 'worker', port }, `Worker health endpoint listening on port ${port}`);
  });

  return server;
}
