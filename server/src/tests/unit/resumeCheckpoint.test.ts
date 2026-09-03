import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { loadResumeState, reconcileJobProgress } from '../../services/exportResume.service';
import { ExportIntegrityError } from '../../utils/errors';
import { createTestUser } from '../helpers/testHelpers';

let userId: string;
const createdJobIds: string[] = [];

async function makeJob(overrides: Partial<{ exportedRowCount: number; lastExportedId: bigint }> = {}) {
  const job = await prisma.exportJob.create({
    data: {
      userId,
      status: ExportStatus.PENDING,
      snapshotMaxId: 60_000n,
      requestedRowLimit: 50_000,
      batchSize: 1_000,
      exportedRowCount: overrides.exportedRowCount ?? 0,
      lastExportedId: overrides.lastExportedId ?? null,
    },
  });
  createdJobIds.push(job.id);
  return job;
}

async function addCheckpoints(
  exportJobId: string,
  entries: { batchNumber: number; lastRecordId: number; rowsWritten: number }[],
) {
  await prisma.exportCheckpoint.createMany({
    data: entries.map((e) => ({
      exportJobId,
      batchNumber: e.batchNumber,
      lastRecordId: BigInt(e.lastRecordId),
      rowsWritten: e.rowsWritten,
    })),
  });
}

beforeAll(async () => {
  const { user } = await createTestUser('resume-unit');
  userId = user.id;
});

afterAll(async () => {
  await prisma.exportJob.deleteMany({ where: { id: { in: createdJobIds } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('resume checkpoint logic', () => {
  it('starts from scratch when no checkpoint exists', async () => {
    const job = await makeJob();
    expect(await loadResumeState(job.id)).toEqual({
      nextBatchNumber: 1,
      lastExportedId: 0n,
      rowsWritten: 0,
      checkpointCount: 0,
    });
  });

  it('resumes from the last checkpoint, not from zero', async () => {
    const job = await makeJob();
    await addCheckpoints(job.id, [
      { batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 },
      { batchNumber: 2, lastRecordId: 2_000, rowsWritten: 1_000 },
      { batchNumber: 3, lastRecordId: 3_000, rowsWritten: 1_000 },
    ]);

    expect(await loadResumeState(job.id)).toEqual({
      nextBatchNumber: 4,
      lastExportedId: 3_000n,
      rowsWritten: 3_000,
      checkpointCount: 3,
    });
  });

  it('sums a partial final batch correctly', async () => {
    const job = await makeJob();
    await addCheckpoints(job.id, [
      { batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 },
      { batchNumber: 2, lastRecordId: 1_250, rowsWritten: 250 },
    ]);
    const state = await loadResumeState(job.id);
    expect(state.rowsWritten).toBe(1_250);
    expect(state.lastExportedId).toBe(1_250n);
  });

  it('refuses to resume across a gap in the checkpoint log', async () => {
    const job = await makeJob();
    await addCheckpoints(job.id, [
      { batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 },
      { batchNumber: 3, lastRecordId: 3_000, rowsWritten: 1_000 },
    ]);
    await expect(loadResumeState(job.id)).rejects.toThrow(ExportIntegrityError);
    await expect(loadResumeState(job.id)).rejects.toThrow(/gap/i);
  });

  it('refuses to resume when checkpoint cursors are not strictly increasing', async () => {
    const job = await makeJob();
    await addCheckpoints(job.id, [
      { batchNumber: 1, lastRecordId: 2_000, rowsWritten: 1_000 },
      { batchNumber: 2, lastRecordId: 1_500, rowsWritten: 1_000 },
    ]);
    await expect(loadResumeState(job.id)).rejects.toThrow(/strictly increasing/i);
  });

  it('rejects duplicate batch numbers at the database level', async () => {
    const job = await makeJob();
    await addCheckpoints(job.id, [{ batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 }]);
    await expect(
      addCheckpoints(job.id, [{ batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 }]),
    ).rejects.toThrow();
  });

  it('trusts the checkpoint log over a stale job row', async () => {
    // Simulates a crash that left the denormalised job counters behind.
    const job = await makeJob({ exportedRowCount: 9_999, lastExportedId: 9_999n });
    await addCheckpoints(job.id, [
      { batchNumber: 1, lastRecordId: 1_000, rowsWritten: 1_000 },
      { batchNumber: 2, lastRecordId: 2_000, rowsWritten: 1_000 },
    ]);

    const state = await loadResumeState(job.id);
    await reconcileJobProgress(job.id, state);

    const reloaded = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(reloaded.exportedRowCount).toBe(2_000);
    expect(reloaded.lastExportedId).toBe(2_000n);
  });
});
