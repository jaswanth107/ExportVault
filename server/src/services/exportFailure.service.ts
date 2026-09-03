import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';
import { toError } from '../utils/errors';

/**
 * Persists a failure so it is visible in the database, the API and the UI —
 * not just in a log line that scrolls away. Recording a failure must never
 * itself throw and mask the original error, so a secondary failure is logged
 * at fatal level with BOTH errors attached.
 */
export async function recordExportFailure(params: {
  exportJobId: string | null;
  errorType: string;
  error: unknown;
}): Promise<void> {
  const error = toError(params.error);
  try {
    await prisma.exportFailure.create({
      data: {
        exportJobId: params.exportJobId,
        errorType: params.errorType,
        errorMessage: error.message.slice(0, 8000),
        stackTrace: error.stack?.slice(0, 16000) ?? null,
      },
    });
  } catch (persistError) {
    logger.fatal(
      {
        exportJobId: params.exportJobId,
        errorType: params.errorType,
        originalError: { message: error.message, stack: error.stack },
        persistError,
      },
      'Could not persist export failure record — original failure preserved in this log line',
    );
  }
}
