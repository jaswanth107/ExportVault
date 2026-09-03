import { ExportStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';
import { recordExportFailure } from './exportFailure.service';

/**
 * Detects exports whose worker died mid-run.
 *
 * A live worker touches `export_jobs.updated_at` after every batch. If a job is
 * still RUNNING but has not been touched within the stall timeout, its worker is
 * gone: the job is moved to INTERRUPTED so the failure is visible in the UI and
 * the export becomes resumable. Progress is left untouched — the checkpoint log
 * still holds every durably written row.
 */
export async function sweepStalledExports(): Promise<number> {
  const cutoff = new Date(Date.now() - env.EXPORT_STALL_TIMEOUT_SECONDS * 1000);

  const stalled = await prisma.exportJob.findMany({
    where: { status: ExportStatus.RUNNING, updatedAt: { lt: cutoff } },
    select: { id: true, exportedRowCount: true, updatedAt: true, requestedRowLimit: true },
  });

  for (const job of stalled) {
    const message = `Worker stopped responding after ${job.exportedRowCount}/${job.requestedRowLimit} rows (no heartbeat since ${job.updatedAt.toISOString()}). Export marked INTERRUPTED and can be resumed.`;

    // Guarded update: if the worker came back to life in the meantime, the
    // status will no longer be RUNNING-with-a-stale-heartbeat and we do nothing.
    const updated = await prisma.exportJob.updateMany({
      where: { id: job.id, status: ExportStatus.RUNNING, updatedAt: { lt: cutoff } },
      data: { status: ExportStatus.INTERRUPTED, errorMessage: message },
    });

    if (updated.count === 0) continue;

    await recordExportFailure({
      exportJobId: job.id,
      errorType: 'WORKER_STALLED',
      error: new Error(message),
    });

    logger.error(
      {
        event: LogEvent.EXPORT_INTERRUPTED,
        exportJobId: job.id,
        exportedRowCount: job.exportedRowCount,
        lastHeartbeat: job.updatedAt.toISOString(),
      },
      'Export marked INTERRUPTED: worker heartbeat expired',
    );
  }

  if (stalled.length > 0) {
    logger.warn({ event: LogEvent.STALLED_JOB_SWEPT, count: stalled.length }, 'Swept stalled exports');
  }

  return stalled.length;
}

let timer: NodeJS.Timeout | null = null;

/** Runs the sweeper on an interval. Hosted by the API, which outlives workers. */
export function startStalledExportSweeper(intervalMs = 5_000): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepStalledExports().catch((error) => {
      // Never silent: a broken sweeper means crashed exports stay invisible.
      logger.error({ err: error }, 'Stalled export sweep failed');
    });
  }, intervalMs);
  timer.unref();
}

export function stopStalledExportSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
