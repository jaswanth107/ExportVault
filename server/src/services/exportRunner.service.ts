import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';
import { csvHeader, serializeCsvChunk } from '../utils/csv';
import { ExportIntegrityError, toError } from '../utils/errors';
import { fetchRecordBatch } from './recordSource.service';
import { loadResumeState, reconcileJobProgress } from './exportResume.service';
import { recordExportFailure } from './exportFailure.service';
import { verifyExportFile } from './exportVerification.service';
import {
  chunkKey,
  deleteChunks,
  finalKey,
  getObjectStream,
  headObject,
  putObjectVerified,
  uploadStream,
} from './storage.service';

export type RunOutcome =
  | { outcome: 'COMPLETED'; exportedRows: number }
  | { outcome: 'CANCELLED'; exportedRows: number }
  | { outcome: 'FAILED'; exportedRows: number; reason: string }
  | { outcome: 'SKIPPED'; reason: string };

/** Statuses a run may legitimately start or resume from. */
const RESUMABLE_STATUSES: ExportStatus[] = [
  ExportStatus.PENDING,
  ExportStatus.QUEUED,
  ExportStatus.INTERRUPTED,
  ExportStatus.RESUMING,
  ExportStatus.FAILED,
];

/**
 * Atomically claims a job for this worker.
 *
 * A job that is already RUNNING belongs to another worker and is left alone,
 * UNLESS its heartbeat (`updated_at`) is older than the stall timeout, which
 * means the owning worker died. This is what makes a hard crash recoverable
 * without ever letting two workers write the same export concurrently.
 */
async function claimJob(exportJobId: string): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - env.EXPORT_STALL_TIMEOUT_SECONDS * 1000);

  const claimed = await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      OR: [
        { status: { in: RESUMABLE_STATUSES } },
        { status: ExportStatus.RUNNING, updatedAt: { lt: staleCutoff } },
      ],
    },
    data: { status: ExportStatus.RUNNING, errorMessage: null, failedAt: null },
  });

  if (claimed.count === 0) return false;

  await prisma.exportJob.updateMany({
    where: { id: exportJobId, startedAt: null },
    data: { startedAt: new Date() },
  });

  return true;
}

async function isCancelRequested(exportJobId: string): Promise<boolean> {
  const job = await prisma.exportJob.findUnique({
    where: { id: exportJobId },
    select: { cancelRequested: true },
  });
  return job?.cancelRequested === true;
}

/**
 * Streams every chunk, in batch order, into one final CSV object.
 * The header is written once, up front; chunks contain data rows only.
 * Nothing is buffered in memory beyond a single chunk.
 */
async function assembleFinalCsv(params: {
  exportJobId: string;
  batchCount: number;
}): Promise<{ key: string; bytes: number }> {
  const { exportJobId, batchCount } = params;
  const key = finalKey(exportJobId);

  logger.info(
    { event: LogEvent.EXPORT_ASSEMBLY_STARTED, exportJobId, batchCount, key },
    'Assembling final CSV from durable chunks',
  );

  const passthrough = new PassThrough();
  const uploadPromise = uploadStream(key, passthrough);

  try {
    if (!passthrough.write(csvHeader())) await once(passthrough, 'drain');

    for (let batchNumber = 1; batchNumber <= batchCount; batchNumber += 1) {
      const source = await getObjectStream(chunkKey(exportJobId, batchNumber));
      // Pump manually rather than piping: this respects backpressure without
      // attaching a fresh set of stream listeners for every one of the N chunks.
      for await (const buffer of source) {
        if (!passthrough.write(buffer as Buffer)) await once(passthrough, 'drain');
      }
    }
    passthrough.end();
  } catch (error) {
    passthrough.destroy(toError(error));
    throw error;
  }

  await uploadPromise;

  const { size } = await headObject(key);
  if (size <= 0) {
    throw new ExportIntegrityError(
      `Assembled export ${exportJobId} is empty in object storage (${size} bytes)`,
      { exportJobId, key },
    );
  }

  logger.info(
    { event: LogEvent.EXPORT_ASSEMBLY_COMPLETED, exportJobId, key, bytes: size },
    'Final CSV assembled and uploaded',
  );

  return { key, bytes: size };
}

async function failJob(exportJobId: string, reason: string, error: unknown): Promise<void> {
  await prisma.exportJob.update({
    where: { id: exportJobId },
    data: {
      status: ExportStatus.FAILED,
      failedAt: new Date(),
      errorMessage: reason.slice(0, 4000),
    },
  });
  await recordExportFailure({ exportJobId, errorType: 'EXPORT_RUN_FAILED', error });
  logger.error({ event: LogEvent.EXPORT_FAILED, exportJobId, reason }, 'Export failed');
}

/**
 * Runs (or resumes) one export job to completion.
 *
 * Per-batch ordering is deliberate and is what makes a crash safe:
 *   1. fetch batch by keyset
 *   2. serialise and WRITE the batch bytes to object storage
 *   3. CONFIRM the write by reading the object's size back
 *   4. only then persist the checkpoint + progress in ONE transaction
 *
 * `last_exported_id` therefore never moves ahead of bytes that actually exist.
 * A crash between (3) and (4) simply re-writes the identical chunk to the same
 * deterministic key on resume, which is idempotent — no duplicates, no gaps.
 */
export async function runExportJob(exportJobId: string): Promise<RunOutcome> {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });

  if (!job) {
    const reason = `Export job ${exportJobId} does not exist`;
    logger.error({ exportJobId }, reason);
    await recordExportFailure({
      exportJobId: null,
      errorType: 'EXPORT_JOB_MISSING',
      error: new Error(reason),
    });
    return { outcome: 'SKIPPED', reason };
  }

  if (job.status === ExportStatus.COMPLETED) {
    return { outcome: 'SKIPPED', reason: 'Job already completed' };
  }
  if (job.status === ExportStatus.CANCELLED) {
    return { outcome: 'SKIPPED', reason: 'Job was cancelled' };
  }

  if (job.cancelRequested) {
    await prisma.exportJob.update({
      where: { id: exportJobId },
      data: { status: ExportStatus.CANCELLED, completedAt: new Date() },
    });
    logger.info({ event: LogEvent.EXPORT_CANCELLED, exportJobId }, 'Export cancelled before start');
    return { outcome: 'CANCELLED', exportedRows: job.exportedRowCount };
  }

  if (!(await claimJob(exportJobId))) {
    const reason = `Export job ${exportJobId} is already owned by a live worker (status=${job.status})`;
    logger.warn({ exportJobId, status: job.status }, reason);
    return { outcome: 'SKIPPED', reason };
  }

  try {
    const resume = await loadResumeState(exportJobId);
    await reconcileJobProgress(exportJobId, resume);

    const isResume = resume.checkpointCount > 0;
    logger.info(
      {
        event: isResume ? LogEvent.EXPORT_RESUMED : LogEvent.EXPORT_STARTED,
        exportJobId,
        userId: job.userId,
        snapshotMaxId: job.snapshotMaxId.toString(),
        targetRows: job.requestedRowLimit,
        batchSize: job.batchSize,
        resumeFromId: resume.lastExportedId.toString(),
        alreadyWritten: resume.rowsWritten,
        checkpointCount: resume.checkpointCount,
      },
      isResume ? 'Resuming export from checkpoint' : 'Starting export',
    );

    let lastExportedId = resume.lastExportedId;
    let exportedRowCount = resume.rowsWritten;
    let batchNumber = resume.nextBatchNumber;

    while (exportedRowCount < job.requestedRowLimit) {
      if (await isCancelRequested(exportJobId)) {
        await prisma.exportJob.update({
          where: { id: exportJobId },
          data: { status: ExportStatus.CANCELLED, completedAt: new Date() },
        });
        await deleteChunks(exportJobId);
        logger.info(
          { event: LogEvent.EXPORT_CANCELLED, exportJobId, exportedRowCount },
          'Export cancelled mid-run; partial chunks removed',
        );
        return { outcome: 'CANCELLED', exportedRows: exportedRowCount };
      }

      const remaining = job.requestedRowLimit - exportedRowCount;
      const limit = Math.min(job.batchSize, remaining);

      // 1. Fetch batch (keyset, bounded by the snapshot).
      const rows = await fetchRecordBatch({
        afterId: lastExportedId,
        snapshotMaxId: job.snapshotMaxId,
        limit,
      });

      if (rows.length === 0) {
        const reason = `Dataset exhausted at ${exportedRowCount} rows: no records remain with id > ${lastExportedId} and id <= ${job.snapshotMaxId}, but ${job.requestedRowLimit} were requested`;
        await failJob(exportJobId, reason, new ExportIntegrityError(reason, { exportJobId }));
        return { outcome: 'FAILED', exportedRows: exportedRowCount, reason };
      }

      const batchLastId = BigInt(rows[rows.length - 1]!.id);

      // 2. Write the batch bytes, 3. and confirm they landed.
      const payload = Buffer.from(serializeCsvChunk(rows as unknown as Record<string, unknown>[]), 'utf8');
      const key = chunkKey(exportJobId, batchNumber);
      const { size } = await putObjectVerified(key, payload);

      // 4. Only now record progress, atomically.
      await prisma.$transaction([
        prisma.exportCheckpoint.create({
          data: {
            exportJobId,
            batchNumber,
            lastRecordId: batchLastId,
            rowsWritten: rows.length,
          },
        }),
        prisma.exportJob.update({
          where: { id: exportJobId },
          data: {
            lastExportedId: batchLastId,
            exportedRowCount: exportedRowCount + rows.length,
          },
        }),
      ]);

      lastExportedId = batchLastId;
      exportedRowCount += rows.length;

      logger.info(
        {
          event: LogEvent.EXPORT_BATCH_COMPLETED,
          exportJobId,
          batchNumber,
          rows: rows.length,
          bytes: size,
          lastExportedId: lastExportedId.toString(),
          exportedRowCount,
          targetRows: job.requestedRowLimit,
        },
        'Batch written and checkpointed',
      );

      batchNumber += 1;

      // ---- Test-only fault injection -------------------------------------
      // Simulates a hard worker crash (SIGKILL-like): no cleanup, no status
      // update, no graceful shutdown. Never set in production.
      if (
        env.EXPORT_CRASH_AFTER_ROWS !== undefined &&
        exportedRowCount >= env.EXPORT_CRASH_AFTER_ROWS
      ) {
        logger.error(
          {
            event: LogEvent.EXPORT_FAULT_INJECTED,
            exportJobId,
            exportedRowCount,
            crashAfterRows: env.EXPORT_CRASH_AFTER_ROWS,
          },
          'EXPORT_CRASH_AFTER_ROWS reached — terminating worker process hard',
        );
        // Flush stdout before dying so the log line is not lost.
        process.stdout.write('', () => process.exit(1));
        await new Promise((resolve) => setTimeout(resolve, 5000));
        process.exit(1);
      }
      // --------------------------------------------------------------------
    }

    if (exportedRowCount !== job.requestedRowLimit) {
      const reason = `Exported ${exportedRowCount} rows but ${job.requestedRowLimit} were requested`;
      await failJob(exportJobId, reason, new ExportIntegrityError(reason, { exportJobId }));
      return { outcome: 'FAILED', exportedRows: exportedRowCount, reason };
    }

    // Cross-check the checkpoint log before trusting the chunk set.
    const finalState = await loadResumeState(exportJobId);
    if (finalState.rowsWritten !== job.requestedRowLimit) {
      const reason = `Checkpoint log accounts for ${finalState.rowsWritten} rows, expected ${job.requestedRowLimit}`;
      await failJob(exportJobId, reason, new ExportIntegrityError(reason, { exportJobId }));
      return { outcome: 'FAILED', exportedRows: exportedRowCount, reason };
    }

    await prisma.exportJob.update({
      where: { id: exportJobId },
      data: { status: ExportStatus.VERIFYING },
    });

    const assembled = await assembleFinalCsv({
      exportJobId,
      batchCount: finalState.checkpointCount,
    });

    const verification = await verifyExportFile({
      exportJobId,
      fileKey: assembled.key,
      expectedRows: job.requestedRowLimit,
      snapshotMaxId: job.snapshotMaxId,
    });

    if (!verification.passed) {
      const reason = `Verification failed: ${verification.failureReason}`;
      await prisma.exportJob.update({
        where: { id: exportJobId },
        data: { fileKey: assembled.key },
      });
      await failJob(exportJobId, reason, new ExportIntegrityError(reason, { exportJobId }));
      return { outcome: 'FAILED', exportedRows: exportedRowCount, reason };
    }

    // COMPLETED is set only on the far side of a passing verification.
    await prisma.exportJob.update({
      where: { id: exportJobId },
      data: {
        status: ExportStatus.COMPLETED,
        fileKey: assembled.key,
        fileUrl: `/api/exports/${exportJobId}/download`,
        completedAt: new Date(),
        errorMessage: null,
        failedAt: null,
      },
    });

    const removed = await deleteChunks(exportJobId);

    logger.info(
      {
        event: LogEvent.EXPORT_COMPLETED,
        exportJobId,
        exportedRowCount,
        fileKey: assembled.key,
        fileBytes: assembled.bytes,
        sha256: verification.sha256,
        chunksRemoved: removed,
      },
      'Export completed and verified',
    );

    return { outcome: 'COMPLETED', exportedRows: exportedRowCount };
  } catch (error) {
    const err = toError(error);
    await failJob(exportJobId, err.message, err);
    throw err;
  }
}
