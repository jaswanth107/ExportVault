import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { MAX_ROW_LIMIT } from '../config/env';
import {
  cancelExportJob,
  createExportJob,
  getExportDownload,
  getExportJobDetail,
  getExportStats,
  getOwnedExportJob,
  listExportJobs,
  resumeExportJob,
} from '../services/export.service';
import { verifyExportJobById, getLatestVerification } from '../services/exportVerification.service';
import {
  serializeExportJob,
  serializeFailure,
  serializeVerification,
  bigIntToJson,
} from '../utils/serialize';

export const createExportSchema = z.object({
  rowLimit: z.coerce
    .number()
    .int('rowLimit must be an integer')
    .positive('rowLimit must be positive')
    .max(MAX_ROW_LIMIT, `rowLimit may not exceed ${MAX_ROW_LIMIT}`)
    .default(MAX_ROW_LIMIT),
});

export const exportIdParamSchema = z.object({
  id: z.string().uuid('Export id must be a UUID'),
});

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { rowLimit } = req.body as z.infer<typeof createExportSchema>;
    const job = await createExportJob({ userId: req.userId!, rowLimit });
    res.status(201).json({ success: true, export: serializeExportJob(job) });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const jobs = await listExportJobs(req.userId!);
    const verifications = await Promise.all(jobs.map((j) => getLatestVerification(j.id)));
    res.json({
      success: true,
      exports: jobs.map((job, i) => ({
        ...serializeExportJob(job),
        verification: serializeVerification(verifications[i] ?? null),
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function stats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await getExportStats(req.userId!);
    res.json({
      success: true,
      stats: {
        total: result.total,
        completed: result.completed,
        failed: result.failed,
        running: result.running,
        interrupted: result.interrupted,
        cancelled: result.cancelled,
        totalRowsExported: result.totalRowsExported,
        byStatus: result.byStatus,
        latest: result.latest ? serializeExportJob(result.latest) : null,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function detail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { job, verification, failures, checkpointCount } = await getExportJobDetail(
      req.userId!,
      req.params.id as string,
    );
    res.json({
      success: true,
      ...serializeExportJob(job),
      checkpointCount,
      verification: serializeVerification(verification),
      failures: failures.map(serializeFailure),
    });
  } catch (error) {
    next(error);
  }
}

export async function resume(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const job = await resumeExportJob(req.userId!, req.params.id as string);
    res.json({ success: true, export: serializeExportJob(job) });
  } catch (error) {
    next(error);
  }
}

export async function cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const job = await cancelExportJob(req.userId!, req.params.id as string);
    res.json({ success: true, export: serializeExportJob(job) });
  } catch (error) {
    next(error);
  }
}

export async function download(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await getExportDownload(req.userId!, req.params.id as string);
    res.json({
      success: true,
      download: {
        url: result.url,
        filename: result.filename,
        expiresInSeconds: result.expiresInSeconds,
        fileBytes: bigIntToJson(result.fileBytes),
        sha256: result.sha256,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function verify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Ownership is enforced before any file is touched.
    await getOwnedExportJob(req.userId!, req.params.id as string);
    const { job, verification, recomputed } = await verifyExportJobById(req.params.id as string);

    if (!verification) {
      res.json({
        success: true,
        verification: null,
        message: `Export is ${job.status}; no CSV has been produced yet, so there is nothing to verify.`,
      });
      return;
    }

    res.json({
      success: true,
      recomputed,
      verification: {
        expectedRows: verification.expectedRows,
        actualRows: verification.actualRows,
        uniqueRows: verification.uniqueRows,
        duplicates: verification.duplicates,
        outOfSnapshot: verification.outOfSnapshot,
        headerValid: verification.headerValid,
        minId: bigIntToJson(verification.minId),
        maxId: bigIntToJson(verification.maxId),
        fileBytes: bigIntToJson(BigInt(verification.fileBytes)),
        sha256: verification.sha256,
        failureReason: verification.failureReason,
        status: verification.passed ? 'PASSED' : 'FAILED',
      },
    });
  } catch (error) {
    next(error);
  }
}
