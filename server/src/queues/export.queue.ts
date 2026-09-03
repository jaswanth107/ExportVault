import { Queue, QueueEvents } from 'bullmq';
import { getRedisConnection } from '../config/redis';
import { logger, LogEvent } from '../utils/logger';

export const EXPORT_QUEUE_NAME = 'export-jobs';

export interface ExportJobPayload {
  exportJobId: string;
  /** 'initial' for the first run, 'resume' when continuing from a checkpoint. */
  trigger: 'initial' | 'resume';
}

let queue: Queue<ExportJobPayload> | null = null;

export function getExportQueue(): Queue<ExportJobPayload> {
  if (!queue) {
    queue = new Queue<ExportJobPayload>(EXPORT_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queue;
}

/**
 * Enqueues a run for an export job.
 *
 * The BullMQ job id is the export job id, so a double-submit cannot create two
 * concurrent runs. Any stale queue entry for the same export is removed first
 * so that a resume is always accepted.
 */
export async function enqueueExportJob(payload: ExportJobPayload): Promise<void> {
  const q = getExportQueue();

  const existing = await q.getJob(payload.exportJobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active') {
      logger.warn(
        { exportJobId: payload.exportJobId, state },
        'Export already has an active queue job; not enqueuing a duplicate',
      );
      return;
    }
    await existing.remove();
  }

  await q.add('run-export', payload, { jobId: payload.exportJobId });

  logger.info(
    { event: LogEvent.EXPORT_QUEUED, exportJobId: payload.exportJobId, trigger: payload.trigger },
    'Export job queued',
  );
}

/** Queue depth snapshot used by the health endpoint. */
export async function getQueueHealth(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}> {
  const q = getExportQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

let queueEvents: QueueEvents | null = null;

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(EXPORT_QUEUE_NAME, { connection: getRedisConnection().duplicate() });
  }
  return queueEvents;
}

export async function closeExportQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
