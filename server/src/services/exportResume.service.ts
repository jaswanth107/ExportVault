import { prisma } from '../config/prisma';
import { ExportIntegrityError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface ResumeState {
  /** Batch number the worker should write next (1-based). */
  nextBatchNumber: number;
  /** Highest record id already durably written. 0 when nothing was written. */
  lastExportedId: bigint;
  /** Total rows already durably written across all checkpoints. */
  rowsWritten: number;
  /** Number of checkpoints found. */
  checkpointCount: number;
}

/**
 * Derives resume position from the checkpoint log, which is the single source
 * of truth. `export_jobs.last_exported_id` is a denormalised convenience copy;
 * if the two ever disagree (e.g. a crash between writes), the checkpoints win.
 *
 * A gap in batch numbers means a chunk is missing, which would silently skip
 * rows. That is a hard failure, never a warning.
 */
export async function loadResumeState(exportJobId: string): Promise<ResumeState> {
  const checkpoints = await prisma.exportCheckpoint.findMany({
    where: { exportJobId },
    orderBy: { batchNumber: 'asc' },
    select: { batchNumber: true, lastRecordId: true, rowsWritten: true },
  });

  if (checkpoints.length === 0) {
    return { nextBatchNumber: 1, lastExportedId: 0n, rowsWritten: 0, checkpointCount: 0 };
  }

  let rowsWritten = 0;
  let previousLastId = 0n;

  for (let i = 0; i < checkpoints.length; i += 1) {
    const checkpoint = checkpoints[i]!;
    const expectedBatchNumber = i + 1;

    if (checkpoint.batchNumber !== expectedBatchNumber) {
      throw new ExportIntegrityError(
        `Checkpoint log for export ${exportJobId} has a gap: expected batch ${expectedBatchNumber}, found ${checkpoint.batchNumber}. Refusing to resume because rows would be skipped.`,
        { exportJobId, expectedBatchNumber, foundBatchNumber: checkpoint.batchNumber },
      );
    }

    if (checkpoint.lastRecordId <= previousLastId) {
      throw new ExportIntegrityError(
        `Checkpoint log for export ${exportJobId} is not strictly increasing at batch ${checkpoint.batchNumber} (${checkpoint.lastRecordId} <= ${previousLastId}).`,
        { exportJobId, batchNumber: checkpoint.batchNumber },
      );
    }

    previousLastId = checkpoint.lastRecordId;
    rowsWritten += checkpoint.rowsWritten;
  }

  const last = checkpoints[checkpoints.length - 1]!;

  return {
    nextBatchNumber: last.batchNumber + 1,
    lastExportedId: last.lastRecordId,
    rowsWritten,
    checkpointCount: checkpoints.length,
  };
}

/**
 * Re-syncs the job row with the checkpoint log before a run begins, so progress
 * reported to the UI is always backed by durably written bytes.
 */
export async function reconcileJobProgress(exportJobId: string, state: ResumeState): Promise<void> {
  const job = await prisma.exportJob.findUniqueOrThrow({
    where: { id: exportJobId },
    select: { lastExportedId: true, exportedRowCount: true },
  });

  const jobLastId = job.lastExportedId ?? 0n;
  if (jobLastId === state.lastExportedId && job.exportedRowCount === state.rowsWritten) {
    return;
  }

  logger.warn(
    {
      exportJobId,
      jobLastExportedId: jobLastId.toString(),
      jobExportedRowCount: job.exportedRowCount,
      checkpointLastExportedId: state.lastExportedId.toString(),
      checkpointRowsWritten: state.rowsWritten,
    },
    'Job progress disagreed with checkpoint log; trusting checkpoints',
  );

  await prisma.exportJob.update({
    where: { id: exportJobId },
    data: {
      lastExportedId: state.lastExportedId === 0n ? null : state.lastExportedId,
      exportedRowCount: state.rowsWritten,
    },
  });
}
