import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { EXPORT_QUEUE_NAME, type ExportJobPayload } from '../queues/export.queue';
import { runExportJob } from '../services/exportRunner.service';
import { recordExportFailure } from '../services/exportFailure.service';

/**
 * The export worker. Runs as its OWN process (dist/worker.js) so it is never
 * coupled to the API's request lifecycle or to a browser being open.
 */
export function createExportWorker(): Worker<ExportJobPayload> {
  const worker = new Worker<ExportJobPayload>(
    EXPORT_QUEUE_NAME,
    async (job: Job<ExportJobPayload>) => {
      const { exportJobId, trigger } = job.data;
      logger.info(
        { exportJobId, trigger, queueJobId: job.id, attempt: job.attemptsMade + 1 },
        'Worker picked up export job',
      );

      const result = await runExportJob(exportJobId);

      logger.info({ exportJobId, ...result }, 'Worker finished export job');
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
      // A job whose worker died is reclaimed rather than left hanging.
      stalledInterval: 15_000,
      maxStalledCount: 3,
    },
  );

  worker.on('failed', (job, error) => {
    // Never silent: every queue-level failure lands in logs AND the database.
    logger.error(
      { exportJobId: job?.data?.exportJobId, queueJobId: job?.id, err: error },
      'Export queue job failed',
    );
    void recordExportFailure({
      exportJobId: job?.data?.exportJobId ?? null,
      errorType: 'QUEUE_JOB_FAILED',
      error,
    });
  });

  worker.on('stalled', (jobId) => {
    logger.error({ queueJobId: jobId }, 'Export queue job stalled — worker likely died');
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'Export worker emitted an error');
  });

  return worker;
}
