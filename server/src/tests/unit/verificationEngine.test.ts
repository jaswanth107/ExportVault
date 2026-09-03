import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { verifyExportFile } from '../../services/exportVerification.service';
import { assertStorageReady, putObjectVerified } from '../../services/storage.service';
import { csvHeader, serializeCsvChunk } from '../../utils/csv';
import { createTestUser } from '../helpers/testHelpers';

let userId: string;
let jobId: string;

function row(id: number, overrides: Partial<Record<string, string>> = {}) {
  return {
    id: String(id),
    external_id: `ext-${id}`,
    name: `Name ${id}`,
    email: `user${id}@example.com`,
    category: 'billing',
    amount: '10.00',
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function uploadCsv(key: string, body: string) {
  await putObjectVerified(key, Buffer.from(body, 'utf8'));
  return key;
}

beforeAll(async () => {
  await assertStorageReady();
  const { user } = await createTestUser('verify-unit');
  userId = user.id;
  const job = await prisma.exportJob.create({
    data: {
      userId,
      status: ExportStatus.VERIFYING,
      snapshotMaxId: 100n,
      requestedRowLimit: 10,
      batchSize: 5,
    },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prisma.exportJob.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('verification engine calculations', () => {
  it('PASSES a correct file and reports exact counts', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const key = await uploadCsv(`test/verify/${jobId}-ok.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('PASSED');
    expect(result.actualRows).toBe(10);
    expect(result.uniqueRows).toBe(10);
    expect(result.duplicates).toBe(0);
    expect(result.headerValid).toBe(true);
    expect(result.strictlyAscending).toBe(true);
    expect(result.minId).toBe(1n);
    expect(result.maxId).toBe(10n);
    expect(result.failureReason).toBeNull();
  });

  it('detects duplicate ids and FAILS', async () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => row(i + 1)), row(9)];
    const key = await uploadCsv(`test/verify/${jobId}-dupe.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('FAILED');
    expect(result.actualRows).toBe(10);
    expect(result.uniqueRows).toBe(9);
    expect(result.duplicates).toBe(1);
    expect(result.failureReason).toMatch(/duplicate/i);
  });

  it('FAILS when the row count is short of the target', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(i + 1));
    const key = await uploadCsv(`test/verify/${jobId}-short.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('FAILED');
    expect(result.actualRows).toBe(7);
    expect(result.failureReason).toMatch(/expected 10 data rows, found 7/);
  });

  it('FAILS when the header is wrong', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const key = await uploadCsv(
      `test/verify/${jobId}-header.csv`,
      'wrong,header,cols,a,b,c,d,e,f\n' + serializeCsvChunk(rows),
    );

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('FAILED');
    expect(result.headerValid).toBe(false);
    expect(result.failureReason).toMatch(/header/i);
  });

  it('FAILS when a row escaped the snapshot boundary', async () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => row(i + 1)), row(500)];
    const key = await uploadCsv(`test/verify/${jobId}-beyond.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('FAILED');
    expect(result.outOfSnapshot).toBe(1);
    expect(result.failureReason).toMatch(/snapshot boundary/i);
  });

  it('FAILS when ids are not strictly ascending (keyset ordering broken)', async () => {
    const rows = [row(1), row(3), row(2), ...Array.from({ length: 7 }, (_, i) => row(i + 4))];
    const key = await uploadCsv(`test/verify/${jobId}-order.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    expect(result.status).toBe('FAILED');
    expect(result.strictlyAscending).toBe(false);
    expect(result.failureReason).toMatch(/ascending/i);
  });

  it('correctly parses rows whose fields contain commas, quotes and newlines', async () => {
    const rows = [
      row(1, { name: 'Comma, Name' }),
      row(2, { name: 'Quoted "Name"' }),
      row(3, { name: 'Multi\nLine' }),
      row(4, { name: 'Ünïcødé ✅' }),
      ...Array.from({ length: 6 }, (_, i) => row(i + 5)),
    ];
    const key = await uploadCsv(`test/verify/${jobId}-hostile.csv`, csvHeader() + serializeCsvChunk(rows));

    const result = await verifyExportFile({
      exportJobId: jobId,
      fileKey: key,
      expectedRows: 10,
      snapshotMaxId: 100n,
    });

    // 10 logical rows despite the embedded newline producing 11 physical lines.
    expect(result.status).toBe('PASSED');
    expect(result.actualRows).toBe(10);
  });

  it('persists every verification result to the database', async () => {
    const stored = await prisma.exportVerification.findMany({ where: { exportJobId: jobId } });
    expect(stored.length).toBeGreaterThanOrEqual(7);
    expect(stored.some((v) => v.passed)).toBe(true);
    expect(stored.some((v) => !v.passed)).toBe(true);
    expect(stored.every((v) => v.sha256 && v.sha256.length === 64)).toBe(true);
  });
});
