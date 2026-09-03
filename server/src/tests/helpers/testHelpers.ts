import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ExportStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { signToken } from '../../services/auth.service';
import { generateTestData } from '../../scripts/generateTestData';

export const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Creates an isolated user and returns a usable bearer token. */
export async function createTestUser(prefix = 'test') {
  const email = `${prefix}-${crypto.randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: {
      name: 'Test User',
      email,
      passwordHash: await bcrypt.hash('StrongPassword123!', 4),
    },
  });
  return { user, token: signToken({ sub: user.id, email: user.email }), email };
}

/** Guarantees the records table holds at least `target` rows. */
export async function ensureRecords(target = 60_000): Promise<number> {
  const existing = await prisma.record.count();
  if (existing >= target) return existing;
  const result = await generateTestData({ target, reset: false });
  return result.total;
}

/**
 * Spawns a REAL worker process (the same entrypoint production runs).
 * Reliability tests kill this process to simulate genuine crashes rather than
 * mocking an interruption.
 */
export function spawnWorker(extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'dist', 'worker.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.WORKER_LOG_LEVEL ?? 'info',
      EXPORT_STALL_TIMEOUT_SECONDS: '2',
      // Explicitly clear inherited fault injection unless the caller sets it.
      EXPORT_CRASH_AFTER_ROWS: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d: Buffer) => {
    if (process.env.SHOW_WORKER_LOGS) process.stdout.write(`[worker] ${d}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[worker:err] ${d}`);
  });

  return child;
}

export function waitForExit(child: ChildProcess, timeoutMs = 120_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Worker did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the database until an export reaches one of the given statuses. */
export async function waitForStatus(
  exportJobId: string,
  statuses: ExportStatus[],
  timeoutMs = 180_000,
): Promise<{ status: ExportStatus; exportedRowCount: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: ExportStatus; exportedRowCount: number } | null = null;

  while (Date.now() < deadline) {
    const job = await prisma.exportJob.findUniqueOrThrow({
      where: { id: exportJobId },
      select: { status: true, exportedRowCount: true },
    });
    last = job;
    if (statuses.includes(job.status)) return job;
    await sleep(250);
  }

  throw new Error(
    `Export ${exportJobId} did not reach ${statuses.join('|')} within ${timeoutMs}ms (last: ${last?.status}, rows ${last?.exportedRowCount})`,
  );
}

/** Polls until an export has written at least `rows` rows. */
export async function waitForRows(
  exportJobId: string,
  rows: number,
  timeoutMs = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.exportJob.findUniqueOrThrow({
      where: { id: exportJobId },
      select: { exportedRowCount: true, status: true },
    });
    if (job.exportedRowCount >= rows) return job.exportedRowCount;
    if (job.status === ExportStatus.FAILED || job.status === ExportStatus.COMPLETED) {
      return job.exportedRowCount;
    }
    await sleep(100);
  }
  throw new Error(`Export ${exportJobId} did not reach ${rows} rows within ${timeoutMs}ms`);
}
