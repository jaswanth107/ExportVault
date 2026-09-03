import type { ExportJob, ExportVerification, ExportFailure } from '@prisma/client';

/** BigInt values are emitted as JSON numbers when they fit safely, else strings. */
export function bigIntToJson(value: bigint | null | undefined): number | string | null {
  if (value === null || value === undefined) return null;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export function serializeExportJob(job: ExportJob) {
  const percentage =
    job.requestedRowLimit > 0
      ? Math.floor((job.exportedRowCount / job.requestedRowLimit) * 100)
      : 0;

  return {
    id: job.id,
    status: job.status,
    progress: {
      exportedRows: job.exportedRowCount,
      targetRows: job.requestedRowLimit,
      percentage,
    },
    lastExportedId: bigIntToJson(job.lastExportedId),
    snapshotMaxId: bigIntToJson(job.snapshotMaxId),
    requestedRowLimit: job.requestedRowLimit,
    exportedRowCount: job.exportedRowCount,
    batchSize: job.batchSize,
    fileKey: job.fileKey,
    fileUrl: job.fileUrl,
    cancelRequested: job.cancelRequested,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function serializeVerification(v: ExportVerification | null) {
  if (!v) return null;
  return {
    expectedRows: v.expectedRows,
    actualRows: v.actualRows,
    uniqueRows: v.uniqueRows,
    duplicates: v.duplicates,
    minId: bigIntToJson(v.minId),
    maxId: bigIntToJson(v.maxId),
    outOfSnapshot: v.outOfSnapshot,
    headerValid: v.headerValid,
    fileBytes: bigIntToJson(v.fileBytes),
    sha256: v.sha256,
    status: v.passed ? ('PASSED' as const) : ('FAILED' as const),
    failureReason: v.failureReason,
    verifiedAt: v.createdAt.toISOString(),
  };
}

export function serializeFailure(f: ExportFailure) {
  return {
    id: f.id,
    errorType: f.errorType,
    errorMessage: f.errorMessage,
    createdAt: f.createdAt.toISOString(),
  };
}
