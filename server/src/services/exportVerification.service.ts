import crypto from 'node:crypto';
import { parse } from 'csv-parse';
import { prisma } from '../config/prisma';
import { getObjectStream, headObject } from './storage.service';
import { CSV_COLUMNS } from '../utils/csv';
import { logger, LogEvent } from '../utils/logger';
import { NotFoundError } from '../utils/errors';

export interface VerificationResult {
  expectedRows: number;
  actualRows: number;
  uniqueRows: number;
  duplicates: number;
  minId: bigint | null;
  maxId: bigint | null;
  outOfSnapshot: number;
  headerValid: boolean;
  strictlyAscending: boolean;
  fileBytes: number;
  sha256: string;
  passed: boolean;
  failureReason: string | null;
  status: 'PASSED' | 'FAILED';
}

/**
 * Reads the generated CSV back out of object storage and proves what is in it.
 *
 * This is intentionally an independent audit: it re-downloads the real file and
 * parses it with `csv-parse` (a different implementation from the writer in
 * utils/csv.ts), so a bug in the writer cannot hide itself here. Nothing about
 * the in-memory export state is trusted.
 */
export async function verifyExportFile(params: {
  exportJobId: string;
  fileKey: string;
  expectedRows: number;
  snapshotMaxId: bigint;
}): Promise<VerificationResult> {
  const { exportJobId, fileKey, expectedRows, snapshotMaxId } = params;

  logger.info(
    { event: LogEvent.EXPORT_VERIFICATION_STARTED, exportJobId, fileKey, expectedRows },
    'Verifying exported CSV',
  );

  const { size: fileBytes } = await headObject(fileKey);
  const body = await getObjectStream(fileKey);

  const hash = crypto.createHash('sha256');
  body.on('data', (chunk: Buffer) => hash.update(chunk));

  const parser = parse({
    bom: true,
    relaxColumnCount: false,
    skipEmptyLines: false,
  });

  const seenIds = new Set<string>();
  let actualRows = 0;
  let duplicates = 0;
  let outOfSnapshot = 0;
  let headerValid = false;
  let strictlyAscending = true;
  let previousId: bigint | null = null;
  let minId: bigint | null = null;
  let maxId: bigint | null = null;
  let rowIndex = 0;
  let malformedRows = 0;

  await new Promise<void>((resolve, reject) => {
    parser.on('readable', () => {
      let row: string[] | null;
      // eslint-disable-next-line no-cond-assign
      while ((row = parser.read() as string[] | null) !== null) {
        if (rowIndex === 0) {
          headerValid =
            row.length === CSV_COLUMNS.length &&
            CSV_COLUMNS.every((column, i) => row?.[i] === column);
          rowIndex += 1;
          continue;
        }
        rowIndex += 1;

        if (row.length !== CSV_COLUMNS.length) {
          malformedRows += 1;
          continue;
        }

        actualRows += 1;
        const idText = row[0] ?? '';

        if (seenIds.has(idText)) {
          duplicates += 1;
        } else {
          seenIds.add(idText);
        }

        let idValue: bigint | null = null;
        try {
          idValue = BigInt(idText);
        } catch (error) {
          // A non-numeric id is corruption, not something to ignore.
          malformedRows += 1;
          logger.error(
            { exportJobId, rowIndex, idText, err: error },
            'CSV row contained a non-numeric id',
          );
        }

        if (idValue !== null) {
          if (idValue > snapshotMaxId) outOfSnapshot += 1;
          if (previousId !== null && idValue <= previousId) strictlyAscending = false;
          previousId = idValue;
          if (minId === null || idValue < minId) minId = idValue;
          if (maxId === null || idValue > maxId) maxId = idValue;
        }
      }
    });
    parser.on('error', reject);
    parser.on('end', resolve);
    body.on('error', reject);
    body.pipe(parser);
  });

  const uniqueRows = seenIds.size;
  const sha256 = hash.digest('hex');

  const problems: string[] = [];
  if (!headerValid) problems.push(`header row is not exactly "${CSV_COLUMNS.join(',')}"`);
  if (actualRows !== expectedRows) problems.push(`expected ${expectedRows} data rows, found ${actualRows}`);
  if (uniqueRows !== expectedRows) problems.push(`expected ${expectedRows} unique ids, found ${uniqueRows}`);
  if (duplicates !== 0) problems.push(`${duplicates} duplicate id(s) present`);
  if (outOfSnapshot !== 0) problems.push(`${outOfSnapshot} row(s) exceed snapshot boundary ${snapshotMaxId}`);
  if (!strictlyAscending) problems.push('ids are not strictly ascending (keyset ordering violated)');
  if (malformedRows !== 0) problems.push(`${malformedRows} malformed row(s)`);
  if (fileBytes <= 0) problems.push('file is empty');

  const passed = problems.length === 0;
  const failureReason = passed ? null : problems.join('; ');

  const result: VerificationResult = {
    expectedRows,
    actualRows,
    uniqueRows,
    duplicates,
    minId,
    maxId,
    outOfSnapshot,
    headerValid,
    strictlyAscending,
    fileBytes,
    sha256,
    passed,
    failureReason,
    status: passed ? 'PASSED' : 'FAILED',
  };

  await prisma.exportVerification.create({
    data: {
      exportJobId,
      expectedRows,
      actualRows,
      uniqueRows,
      duplicates,
      minId,
      maxId,
      outOfSnapshot,
      headerValid,
      fileBytes: BigInt(fileBytes),
      sha256,
      passed,
      failureReason,
    },
  });

  logger.info(
    {
      event: passed ? LogEvent.EXPORT_VERIFICATION_PASSED : LogEvent.EXPORT_VERIFICATION_FAILED,
      exportJobId,
      expectedRows,
      actualRows,
      uniqueRows,
      duplicates,
      outOfSnapshot,
      fileBytes,
      sha256,
      failureReason,
    },
    passed ? 'CSV verification passed' : 'CSV verification FAILED',
  );

  return result;
}

/** Latest persisted verification for a job, or null when never verified. */
export async function getLatestVerification(exportJobId: string) {
  return prisma.exportVerification.findFirst({
    where: { exportJobId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Re-runs verification on demand for the GET /api/exports/:id/verify endpoint.
 * If the job has produced a file, the file is re-read and re-proved; results are
 * never served from a cached claim without a file behind them.
 */
export async function verifyExportJobById(exportJobId: string) {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job) throw new NotFoundError('Export job not found');

  if (!job.fileKey) {
    const latest = await getLatestVerification(exportJobId);
    return { job, verification: latest, recomputed: false as const };
  }

  const result = await verifyExportFile({
    exportJobId,
    fileKey: job.fileKey,
    expectedRows: job.requestedRowLimit,
    snapshotMaxId: job.snapshotMaxId,
  });

  return { job, verification: result, recomputed: true as const };
}
