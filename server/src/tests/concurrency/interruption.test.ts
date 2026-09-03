/**
 * PHASE 5 — Interruption and resume.
 *
 * This suite does not mock a failure. It launches the real worker entrypoint as
 * a child process and lets it die hard (process.exit(1), no cleanup) partway
 * through a 50,000-row export, then proves the export can be resumed to a
 * byte-correct result.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { createExportJob, resumeExportJob } from '../../services/export.service';
import { sweepStalledExports } from '../../services/stalledJobs.service';
import { closeExportQueue } from '../../queues/export.queue';
import { finalKey } from '../../services/storage.service';
import { auditCsvObject } from '../helpers/csvAudit';
import {
  createTestUser,
  ensureRecords,
  sleep,
  spawnWorker,
  stopWorker,
  waitForExit,
  waitForStatus,
} from '../helpers/testHelpers';

const TARGET_ROWS = 50_000;
const CRASH_AFTER_ROWS = 10_000;

let user: Awaited<ReturnType<typeof createTestUser>>;
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  await ensureRecords(60_000);
  user = await createTestUser('interrupt');
}, 300_000);

// Every test must leave no worker running: a survivor from a previous test
// would race the next test's worker for the queue.
afterEach(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
});

afterAll(async () => {
  while (spawned.length > 0) await stopWorker(spawned.pop()!);
  await prisma.exportJob.deleteMany({ where: { userId: user.user.id } });
  await prisma.user.deleteMany({ where: { id: user.user.id } });
  await closeExportQueue();
});

describe('interruption and resume', () => {
  it(
    'survives a hard worker crash and resumes to exactly 50,000 unique rows',
    async () => {
      const job = await createExportJob({ userId: user.user.id, rowLimit: TARGET_ROWS });

      // ---- 1. Run until the worker is killed mid-export -------------------
      const crashingWorker = spawnWorker({ EXPORT_CRASH_AFTER_ROWS: String(CRASH_AFTER_ROWS) });
      spawned.push(crashingWorker);

      const exitCode = await waitForExit(crashingWorker, 120_000);
      expect(exitCode, 'worker must have died with a non-zero exit code').toBe(1);

      const afterCrash = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(afterCrash.exportedRowCount).toBeGreaterThanOrEqual(CRASH_AFTER_ROWS);
      expect(afterCrash.exportedRowCount).toBeLessThan(TARGET_ROWS);
      expect(afterCrash.status).toBe(ExportStatus.RUNNING); // crash left it mid-flight

      const checkpointsAfterCrash = await prisma.exportCheckpoint.findMany({
        where: { exportJobId: job.id },
        orderBy: { batchNumber: 'asc' },
      });
      expect(checkpointsAfterCrash.length).toBe(afterCrash.exportedRowCount / afterCrash.batchSize);
      expect(checkpointsAfterCrash.at(-1)!.lastRecordId).toBe(afterCrash.lastExportedId);

      // ---- 2. The dead worker must become VISIBLE, not silently stuck -----
      await sleep(2_500); // exceed the 2s test stall timeout
      const swept = await sweepStalledExports();
      expect(swept).toBeGreaterThanOrEqual(1);

      const interrupted = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(interrupted.status).toBe(ExportStatus.INTERRUPTED);
      expect(interrupted.errorMessage).toMatch(/Worker stopped responding/i);
      expect(interrupted.exportedRowCount).toBe(afterCrash.exportedRowCount);

      const failures = await prisma.exportFailure.findMany({ where: { exportJobId: job.id } });
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0]!.errorType).toBe('WORKER_STALLED');

      // ---- 3. Resume ------------------------------------------------------
      const resumed = await resumeExportJob(user.user.id, job.id);
      expect(resumed.status).toBe(ExportStatus.RESUMING);
      // Resume must continue, not restart.
      expect(resumed.exportedRowCount).toBe(afterCrash.exportedRowCount);
      expect(resumed.lastExportedId).toBe(afterCrash.lastExportedId);

      const healthyWorker = spawnWorker();
      spawned.push(healthyWorker);

      const final = await waitForStatus(job.id, [ExportStatus.COMPLETED, ExportStatus.FAILED], 240_000);
      expect(final.status).toBe(ExportStatus.COMPLETED);

      // ---- 4. Prove the resumed file is correct ---------------------------
      const audit = await auditCsvObject(finalKey(job.id));
      expect(audit.rowCount).toBe(TARGET_ROWS);
      expect(audit.uniqueIds).toBe(TARGET_ROWS);
      expect(audit.duplicates).toBe(0);
      expect(audit.malformed).toBe(0);
      expect(audit.strictlyAscending).toBe(true);
      expect(audit.minId).toBe(1);
      expect(audit.maxId).toBe(TARGET_ROWS);

      // Specifically check the seam where the crash happened: the rows either
      // side of the interruption must appear exactly once each.
      const seam = audit.ids.filter(
        (id) => id > afterCrash.exportedRowCount - 3 && id <= afterCrash.exportedRowCount + 3,
      );
      expect(seam).toEqual([
        afterCrash.exportedRowCount - 2,
        afterCrash.exportedRowCount - 1,
        afterCrash.exportedRowCount,
        afterCrash.exportedRowCount + 1,
        afterCrash.exportedRowCount + 2,
        afterCrash.exportedRowCount + 3,
      ]);

      const verification = await prisma.exportVerification.findFirstOrThrow({
        where: { exportJobId: job.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(verification.passed).toBe(true);
      expect(verification.actualRows).toBe(TARGET_ROWS);
      expect(verification.uniqueRows).toBe(TARGET_ROWS);
      expect(verification.duplicates).toBe(0);

      console.log(
        `\n  INTERRUPTION TEST: crashed at ${afterCrash.exportedRowCount} rows, resumed, finished with ` +
          `${audit.rowCount} rows / ${audit.uniqueIds} unique / ${audit.duplicates} duplicates\n`,
      );
    },
    600_000,
  );

  it(
    'is idempotent when a crash lands between writing a chunk and checkpointing it',
    async () => {
      // The one window the ordering in exportRunner cannot avoid: bytes are
      // durably written, then the process dies before the checkpoint commits.
      // Deleting the newest checkpoint while leaving its chunk object in place
      // reproduces that state exactly.
      const job = await createExportJob({ userId: user.user.id, rowLimit: TARGET_ROWS });

      const crashingWorker = spawnWorker({ EXPORT_CRASH_AFTER_ROWS: String(CRASH_AFTER_ROWS) });
      spawned.push(crashingWorker);
      expect(await waitForExit(crashingWorker, 120_000)).toBe(1);

      const latest = await prisma.exportCheckpoint.findFirstOrThrow({
        where: { exportJobId: job.id },
        orderBy: { batchNumber: 'desc' },
      });
      await prisma.exportCheckpoint.delete({ where: { id: latest.id } });
      // The job row still claims the higher progress — the checkpoint log must win.
      const stale = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stale.lastExportedId).toBe(latest.lastRecordId);

      await sleep(2_500);
      await sweepStalledExports();
      await resumeExportJob(user.user.id, job.id);

      const healthyWorker = spawnWorker();
      spawned.push(healthyWorker);

      const final = await waitForStatus(job.id, [ExportStatus.COMPLETED, ExportStatus.FAILED], 240_000);
      expect(final.status).toBe(ExportStatus.COMPLETED);

      const audit = await auditCsvObject(finalKey(job.id));
      expect(audit.rowCount).toBe(TARGET_ROWS);
      expect(audit.uniqueIds).toBe(TARGET_ROWS);
      expect(audit.duplicates).toBe(0);
      expect(audit.strictlyAscending).toBe(true);

      console.log(
        `\n  RE-WRITE IDEMPOTENCY: replayed batch ${latest.batchNumber}, still ${audit.rowCount} rows / ` +
          `${audit.duplicates} duplicates\n`,
      );
    },
    600_000,
  );
});
