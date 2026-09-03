import type { Request, Response, NextFunction } from 'express';
import { AppError, NotFoundError, toError } from '../utils/errors';
import { logger, LogEvent } from '../utils/logger';
import { isProduction } from '../config/env';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

/**
 * Central error handler. Every error is logged with its correlation id, route
 * and full stack trace on the server; clients get a structured message that
 * never leaks internals in production.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const err = toError(error);
  const appError = error instanceof AppError ? error : null;
  const statusCode = appError?.statusCode ?? 500;
  const code = appError?.code ?? 'INTERNAL_ERROR';

  const logPayload = {
    event: LogEvent.REQUEST_FAILED,
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    statusCode,
    code,
    userId: req.userId ?? null,
    err: { message: err.message, stack: err.stack },
  };

  if (statusCode >= 500) {
    logger.error(logPayload, 'Request failed');
  } else {
    logger.warn(logPayload, 'Request rejected');
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      // A 500 in production reveals nothing about internals; everything else is
      // a deliberate, client-safe message.
      message:
        statusCode >= 500 && isProduction
          ? 'An internal error occurred. Reference the requestId when reporting this.'
          : err.message,
      ...(appError?.details ? { details: appError.details } : {}),
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    },
  });
}
