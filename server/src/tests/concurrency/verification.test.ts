/**
 * PHASE 7 — Verification engine, end to end.
 *
 * Runs a real, uninterrupted 50,000-row export through the real worker and then
 * proves the resulting file, three independent ways:
 *   1. the application's own verification engine (csv-parse)
 *   2. an independent audit that re-downloads the object and re-parses it
 *   3. the HTTP /verify endpoint, which recomputes rather than replaying a claim
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { ChildProcess } from 'node:child_process';
import type { Express } from 'express';
import { ExportStatus } from '@prisma/client';
import { createApp } from '../../app';
import { prisma } from '../../config/prisma';
import { createExportJob } from '../../services/export.service';
import { closeExportQueue } from '../../queues/export.queue';
import { finalKey } from '../../services/storage.service';
import { auditCsvObject } from '../helpers/csvAudit';
import {
  createTestUser,
  ensureRecords,
  spawnWorker,
  stopWorker,
  waitForStatus,
} from '../helpers/testHelpers';

const TARGET_ROWS = 50_000;

let app: Express;
let user: Awaited<ReturnType<typeof createTestUser>>;
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  app = createApp();
  await ensureRecords(60_000);
  user = await createTestUser('verification');
}, 300_000);

afterEach(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
});

afterAll(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
  await prisma.exportJob.deleteMany({ where: { userId: user.user.id } });
  await prisma.user.deleteMany({ where: { id: user.user.id } });
  await closeExportQueue();
});

describe('verification engine end to end', () => {
  it(
    'exports exactly 50,000 unique rows and proves it',
    async () => {
      const availableRows = await prisma.record.count();
      expect(availableRows).toBeGreaterThanOrEqual(60_000);

      const job = await createExportJob({ userId: user.user.id, rowLimit: TARGET_ROWS });
      const worker = spawnWorker();
      spawned.push(worker);

      const final = await waitForStatus(
        job.id,
        [ExportStatus.COMPLETED, ExportStatus.FAILED],
        300_000,
      );
      expect(final.status).toBe(ExportStatus.COMPLETED);

      // ---- 1. The engine's own stored result ------------------------------
      const stored = await prisma.exportVerification.findFirstOrThrow({
        where: { exportJobId: job.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(stored.expectedRows).toBe(TARGET_ROWS);
      expect(stored.actualRows).toBe(TARGET_ROWS);
      expect(stored.uniqueRows).toBe(TARGET_ROWS);
      expect(stored.duplicates).toBe(0);
      expect(stored.outOfSnapshot).toBe(0);
      expect(stored.headerValid).toBe(true);
      expect(stored.passed).toBe(true);
      expect(stored.failureReason).toBeNull();

      // ---- 2. An independent re-read of the real object -------------------
      const audit = await auditCsvObject(finalKey(job.id));
      expect(audit.header).toEqual([
        'id',
        'external_id',
        'name',
        'email',
        'category',
        'amount',
        'status',
        'created_at',
        'updated_at',
      ]);
      expect(audit.rowCount).toBe(TARGET_ROWS);
      expect(audit.uniqueIds).toBe(TARGET_ROWS);
      expect(audit.duplicates).toBe(0);
      expect(audit.malformed).toBe(0);
      expect(audit.strictlyAscending).toBe(true);
      expect(BigInt(audit.maxId!)).toBeLessThanOrEqual(job.snapshotMaxId);

      // ---- 3. The HTTP contract -------------------------------------------
      const res = await request(app)
        .get(`/api/exports/${job.id}/verify`)
        .set('authorization', `Bearer ${user.token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.recomputed).toBe(true);
      expect(res.body.verification).toMatchObject({
        expectedRows: TARGET_ROWS,
        actualRows: TARGET_ROWS,
        uniqueRows: TARGET_ROWS,
        duplicates: 0,
        status: 'PASSED',
      });

      // ---- Download is authorised only now --------------------------------
      const download = await request(app)
        .get(`/api/exports/${job.id}/download`)
        .set('authorization', `Bearer ${user.token}`)
        .expect(200);
      expect(download.body.download.url).toContain(job.id);
      expect(download.body.download.sha256).toBe(stored.sha256);

      console.log(
        [
          '',
          '  ================ VERIFICATION EVIDENCE ================',
          `  DATABASE RECORDS AVAILABLE : ${availableRows}`,
          `  SNAPSHOT BOUNDARY (max id) : ${job.snapshotMaxId}`,
          `  EXPORT TARGET              : ${TARGET_ROWS}`,
          `  CSV ACTUAL ROWS            : ${audit.rowCount}`,
          `  CSV UNIQUE IDs             : ${audit.uniqueIds}`,
          `  CSV DUPLICATES             : ${audit.duplicates}`,
          `  CSV MIN / MAX ID           : ${audit.minId} / ${audit.maxId}`,
          `  ROWS BEYOND SNAPSHOT       : ${stored.outOfSnapshot}`,
          `  FILE BYTES                 : ${stored.fileBytes}`,
          `  SHA-256                    : ${stored.sha256}`,
          `  VERIFICATION STATUS        : ${stored.passed ? 'PASSED' : 'FAILED'}`,
          '  ======================================================',
          '',
        ].join('\n'),
      );
    },
    900_000,
  );

  it(
    'refuses to mark an export COMPLETED when verification fails',
    async () => {
      // Corrupt a finished export's file, re-verify, and confirm the system
      // reports FAILED rather than trusting its earlier success.
      const job = await createExportJob({ userId: user.user.id, rowLimit: 1_000 });
      const worker = spawnWorker();
      spawned.push(worker);

      const final = await waitForStatus(
        job.id,
        [ExportStatus.COMPLETED, ExportStatus.FAILED],
        300_000,
      );
      expect(final.status).toBe(ExportStatus.COMPLETED);

      const { putObjectVerified } = await import('../../services/storage.service');
      const { csvHeader, serializeCsvChunk } = await import('../../utils/csv');
      const truncated =
        csvHeader() +
        serializeCsvChunk(
          Array.from({ length: 999 }, (_, i) => ({
            id: String(i + 1),
            external_id: `ext-${i + 1}`,
            name: 'x',
            email: 'x@example.com',
            category: 'c',
            amount: '1.00',
            status: 'active',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          })),
        );
      await putObjectVerified(finalKey(job.id), Buffer.from(truncated, 'utf8'));

      const res = await request(app)
        .get(`/api/exports/${job.id}/verify`)
        .set('authorization', `Bearer ${user.token}`)
        .expect(200);

      expect(res.body.verification.status).toBe('FAILED');
      expect(res.body.verification.actualRows).toBe(999);
      expect(res.body.verification.failureReason).toMatch(/expected 1000 data rows, found 999/);

      // The failed verification is durably recorded, not just returned.
      const latest = await prisma.exportVerification.findFirstOrThrow({
        where: { exportJobId: job.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(latest.passed).toBe(false);
    },
    900_000,
  );
});
