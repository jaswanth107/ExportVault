import { ExportStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env, MAX_ROW_LIMIT } from '../config/env';
import { logger, LogEvent } from '../utils/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { captureSnapshotMaxId, countRecordsWithinSnapshot } from './recordSource.service';
import { enqueueExportJob } from '../queues/export.queue';
import { getLatestVerification } from './exportVerification.service';
import { getSignedDownloadUrl } from './storage.service';

/** Statuses from which a user may resume. */
const RESUMABLE_FOR_USER: ExportStatus[] = [
  ExportStatus.INTERRUPTED,
  ExportStatus.FAILED,
  ExportStatus.PENDING,
  ExportStatus.QUEUED,
  ExportStatus.RESUMING,
];

/** Statuses that a cancel request is meaningful for. */
const CANCELLABLE: ExportStatus[] = [
  ExportStatus.PENDING,
  ExportStatus.QUEUED,
  ExportStatus.RUNNING,
  ExportStatus.RESUMING,
  ExportStatus.INTERRUPTED,
];

/**
 * Creates an export job.
 *
 * The snapshot boundary is captured HERE, synchronously, at request time — not
 * later in the worker. Everything inserted from this moment on gets a larger id
 * and is therefore outside this export by construction.
 */
export async function createExportJob(params: { userId: string; rowLimit: number }) {
  const { userId, rowLimit } = params;

  if (!Number.isInteger(rowLimit) || rowLimit <= 0) {
    throw new ValidationError('rowLimit must be a positive integer');
  }
  if (rowLimit > MAX_ROW_LIMIT) {
    throw new ValidationError(`rowLimit may not exceed ${MAX_ROW_LIMIT} in this application`, {
      maxRowLimit: MAX_ROW_LIMIT,
    });
  }

  const snapshotMaxId = await captureSnapshotMaxId();
  const availableRows = await countRecordsWithinSnapshot(snapshotMaxId);

  if (availableRows < rowLimit) {
    // Refuse up front rather than failing 40,000 rows later.
    throw new ConflictError(
      `Only ${availableRows} records exist at or below the snapshot boundary (${snapshotMaxId}); ${rowLimit} were requested`,
      { availableRows, requestedRowLimit: rowLimit, snapshotMaxId: snapshotMaxId.toString() },
    );
  }

  const job = await prisma.exportJob.create({
    data: {
      userId,
      status: ExportStatus.PENDING,
      snapshotMaxId,
      requestedRowLimit: rowLimit,
      batchSize: env.EXPORT_BATCH_SIZE,
    },
  });

  logger.info(
    {
      event: LogEvent.EXPORT_REQUESTED,
      exportJobId: job.id,
      userId,
      rowLimit,
      snapshotMaxId: snapshotMaxId.toString(),
      availableRows,
    },
    'Export job created with snapshot boundary',
  );

  await enqueueExportJob({ exportJobId: job.id, trigger: 'initial' });

  const queued = await prisma.exportJob.update({
    where: { id: job.id },
    data: { status: ExportStatus.QUEUED },
  });

  return queued;
}

/** Loads a job and enforces ownership. Guessing another user's id yields 404. */
export async function getOwnedExportJob(userId: string, exportJobId: string) {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job) throw new NotFoundError('Export job not found');
  if (job.userId !== userId) {
    // Log the attempt, but answer 404 so ids cannot be probed for existence.
    logger.warn({ exportJobId, userId, ownerId: job.userId }, 'Cross-user export access blocked');
    throw new NotFoundError('Export job not found');
  }
  return job;
}

export async function listExportJobs(userId: string) {
  return prisma.exportJob.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getExportJobDetail(userId: string, exportJobId: string) {
  const job = await getOwnedExportJob(userId, exportJobId);
  const [verification, failures, checkpointCount] = await Promise.all([
    getLatestVerification(exportJobId),
    prisma.exportFailure.findMany({
      where: { exportJobId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.exportCheckpoint.count({ where: { exportJobId } }),
  ]);
  return { job, verification, failures, checkpointCount };
}

export async function resumeExportJob(userId: string, exportJobId: string) {
  const job = await getOwnedExportJob(userId, exportJobId);

  if (job.status === ExportStatus.COMPLETED) {
    throw new ConflictError('Export already completed; nothing to resume');
  }
  if (job.status === ExportStatus.CANCELLED) {
    throw new ConflictError('Export was cancelled and cannot be resumed');
  }
  if (!RESUMABLE_FOR_USER.includes(job.status)) {
    throw new ConflictError(`Export cannot be resumed while it is ${job.status}`);
  }

  const checkpoints = await prisma.exportCheckpoint.count({ where: { exportJobId } });

  const updated = await prisma.exportJob.update({
    where: { id: exportJobId },
    data: {
      status: ExportStatus.RESUMING,
      errorMessage: null,
      failedAt: null,
      cancelRequested: false,
    },
  });

  await enqueueExportJob({ exportJobId, trigger: 'resume' });

  logger.info(
    {
      event: LogEvent.EXPORT_RESUMED,
      exportJobId,
      userId,
      resumeFromId: job.lastExportedId?.toString() ?? '0',
      alreadyExported: job.exportedRowCount,
      checkpointCount: checkpoints,
    },
    'Resume requested',
  );

  return updated;
}

export async function cancelExportJob(userId: string, exportJobId: string) {
  const job = await getOwnedExportJob(userId, exportJobId);

  if (job.status === ExportStatus.COMPLETED) {
    throw new ConflictError('Export already completed and cannot be cancelled');
  }
  if (job.status === ExportStatus.CANCELLED) {
    return job;
  }
  if (!CANCELLABLE.includes(job.status)) {
    throw new ConflictError(`Export cannot be cancelled while it is ${job.status}`);
  }

  // Flag first; a RUNNING worker notices between batches and stops cleanly at a
  // checkpoint boundary rather than being torn down mid-write.
  const updated = await prisma.exportJob.update({
    where: { id: exportJobId },
    data: {
      cancelRequested: true,
      ...(job.status === ExportStatus.RUNNING
        ? {}
        : { status: ExportStatus.CANCELLED, completedAt: new Date() }),
    },
  });

  logger.info(
    { event: LogEvent.EXPORT_CANCELLED, exportJobId, userId, previousStatus: job.status },
    'Cancel requested',
  );

  return updated;
}

/**
 * Issues a time-limited, presigned download URL.
 * Only a COMPLETED job with a PASSED verification on record can be downloaded.
 */
export async function getExportDownload(userId: string, exportJobId: string) {
  const job = await getOwnedExportJob(userId, exportJobId);

  if (job.status !== ExportStatus.COMPLETED) {
    throw new ConflictError(
      `Export is ${job.status}; only COMPLETED exports can be downloaded`,
      { status: job.status },
    );
  }
  if (!job.fileKey) {
    throw new ConflictError('Export is marked completed but has no stored file key');
  }

  const verification = await getLatestVerification(exportJobId);
  if (!verification || !verification.passed) {
    throw new ForbiddenError('Export has not passed verification and cannot be downloaded');
  }

  const filename = `export-${exportJobId}.csv`;
  const url = await getSignedDownloadUrl(job.fileKey, filename);

  return {
    url,
    filename,
    expiresInSeconds: env.S3_SIGNED_URL_TTL,
    fileBytes: verification.fileBytes,
    sha256: verification.sha256,
  };
}

/** Aggregate counters for the dashboard. */
export async function getExportStats(userId: string) {
  const grouped = await prisma.exportJob.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });

  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const total = grouped.reduce((sum, g) => sum + g._count._all, 0);

  const latest = await prisma.exportJob.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const totalRowsExported = await prisma.exportJob.aggregate({
    where: { userId, status: ExportStatus.COMPLETED },
    _sum: { exportedRowCount: true },
  });

  return {
    total,
    completed: byStatus[ExportStatus.COMPLETED] ?? 0,
    failed: byStatus[ExportStatus.FAILED] ?? 0,
    running:
      (byStatus[ExportStatus.RUNNING] ?? 0) +
      (byStatus[ExportStatus.QUEUED] ?? 0) +
      (byStatus[ExportStatus.RESUMING] ?? 0) +
      (byStatus[ExportStatus.VERIFYING] ?? 0) +
      (byStatus[ExportStatus.PENDING] ?? 0),
    interrupted: byStatus[ExportStatus.INTERRUPTED] ?? 0,
    cancelled: byStatus[ExportStatus.CANCELLED] ?? 0,
    totalRowsExported: totalRowsExported._sum.exportedRowCount ?? 0,
    byStatus,
    latest,
  };
}
