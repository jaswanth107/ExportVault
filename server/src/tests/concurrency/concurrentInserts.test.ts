/**
 * PHASE 6 — Concurrent write stability.
 *
 * Proves the documented consistency strategy: rows inserted WHILE an export is
 * running are excluded from that export (their ids exceed the snapshot
 * boundary) and appear in a later export instead.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { createExportJob } from '../../services/export.service';
import { closeExportQueue } from '../../queues/export.queue';
import { finalKey } from '../../services/storage.service';
import {
  captureSnapshotMaxId,
  fetchRecordBatch,
} from '../../services/recordSource.service';
import { auditCsvObject } from '../helpers/csvAudit';
import {
  createTestUser,
  ensureRecords,
  sleep,
  spawnWorker,
  stopWorker,
  waitForStatus,
} from '../helpers/testHelpers';

const TARGET_ROWS = 50_000;
const CONCURRENT_INSERTS = 500;
const INSERT_CHUNK = 50;
/** Small batches lengthen the run so the inserts genuinely overlap it. */
const BATCH_SIZE = 250;

let user: Awaited<ReturnType<typeof createTestUser>>;
const spawned: ChildProcess[] = [];
const insertedExternalIds: string[] = [];

beforeAll(async () => {
  await ensureRecords(60_000);
  user = await createTestUser('concurrent');
}, 300_000);

// Every test must leave no worker running: a survivor from a previous test
// would race the next test's worker for the queue.
afterEach(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
});

afterAll(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
  await prisma.record.deleteMany({ where: { externalId: { in: insertedExternalIds } } });
  await prisma.exportJob.deleteMany({ where: { userId: user.user.id } });
  await prisma.user.deleteMany({ where: { id: user.user.id } });
  await closeExportQueue();
});

describe('concurrent inserts during an export', () => {
  it(
    'excludes rows inserted mid-export and still produces exactly 50,000 unique rows',
    async () => {
      const job = await createExportJob({ userId: user.user.id, rowLimit: TARGET_ROWS });
      const snapshotMaxId = job.snapshotMaxId;

      // Slow the export down so the concurrent inserts really do overlap it.
      await prisma.exportJob.update({
        where: { id: job.id },
        data: { batchSize: BATCH_SIZE },
      });

      const worker = spawnWorker();
      spawned.push(worker);

      // ---- Insert 500 rows WHILE the export runs --------------------------
      let insertedWhileRunning = 0;
      let observedRunning = false;
      const progressWhenInserting: number[] = [];

      for (let chunk = 0; chunk < CONCURRENT_INSERTS / INSERT_CHUNK; chunk += 1) {
        const current = await prisma.exportJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { status: true, exportedRowCount: true },
        });

        const rows = Array.from({ length: INSERT_CHUNK }, (_, i) => {
          const externalId = crypto.randomUUID();
          insertedExternalIds.push(externalId);
          return {
            externalId,
            name: `Concurrent Insert ${chunk}-${i}`,
            email: `concurrent-${chunk}-${i}@example.com`,
            category: 'concurrent',
            amount: '99.99',
            status: 'active',
          };
        });

        await prisma.record.createMany({ data: rows });

        if (current.status === ExportStatus.RUNNING) {
          observedRunning = true;
          insertedWhileRunning += INSERT_CHUNK;
          progressWhenInserting.push(current.exportedRowCount);
        }

        await sleep(120);
      }

      const final = await waitForStatus(
        job.id,
        [ExportStatus.COMPLETED, ExportStatus.FAILED],
        300_000,
      );
      expect(final.status).toBe(ExportStatus.COMPLETED);

      // The test is only meaningful if the writes actually overlapped the run.
      expect(observedRunning, 'inserts must overlap a RUNNING export').toBe(true);
      expect(insertedWhileRunning).toBeGreaterThan(0);

      // ---- Prove the export is untouched by those inserts -----------------
      const audit = await auditCsvObject(finalKey(job.id));
      expect(audit.rowCount).toBe(TARGET_ROWS);
      expect(audit.uniqueIds).toBe(TARGET_ROWS);
      expect(audit.duplicates).toBe(0);
      expect(audit.malformed).toBe(0);
      expect(audit.strictlyAscending).toBe(true);
      expect(BigInt(audit.maxId!)).toBeLessThanOrEqual(snapshotMaxId);

      const leaked = insertedExternalIds.filter((id) => audit.externalIds.has(id));
      expect(leaked, 'no concurrently inserted row may appear in this export').toEqual([]);

      // ---- ...and that those rows are not lost, just deferred -------------
      const newSnapshot = await captureSnapshotMaxId();
      expect(newSnapshot).toBeGreaterThan(snapshotMaxId);

      const deferred = new Set<string>();
      let cursor = snapshotMaxId;
      while (cursor < newSnapshot) {
        const rows = await fetchRecordBatch({
          afterId: cursor,
          snapshotMaxId: newSnapshot,
          limit: 500,
        });
        if (rows.length === 0) break;
        for (const row of rows) deferred.add(row.external_id);
        cursor = BigInt(rows.at(-1)!.id);
      }

      const missing = insertedExternalIds.filter((id) => !deferred.has(id));
      expect(missing, 'every deferred row must be visible to a future export').toEqual([]);

      console.log(
        `\n  CONCURRENT INSERT TEST: snapshot=${snapshotMaxId}, ` +
          `${insertedWhileRunning}/${CONCURRENT_INSERTS} rows inserted while status=RUNNING ` +
          `(at export progress ${progressWhenInserting.join(', ')} rows)\n` +
          `  CSV rows=${audit.rowCount} unique=${audit.uniqueIds} duplicates=${audit.duplicates} ` +
          `maxId=${audit.maxId} (<= snapshot ${snapshotMaxId}); leaked=${leaked.length}; ` +
          `all ${insertedExternalIds.length} deferred rows visible to the next export\n`,
      );
    },
    900_000,
  );
});
