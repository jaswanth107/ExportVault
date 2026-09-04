import pino from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Structured application logger. Every meaningful export lifecycle transition
 * is logged with a stable `event` name so failures are greppable in production.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'exportvault' },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'JWT_SECRET',
      'AWS_SECRET_ACCESS_KEY',
    ],
    censor: '[redacted]',
  },
  transport:
    !isProduction && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});

/** Stable structured log event names. */
export const LogEvent = {
  SERVER_STARTED: 'SERVER_STARTED',
  DEPENDENCY_OK: 'DEPENDENCY_OK',
  DEPENDENCY_FAILED: 'DEPENDENCY_FAILED',

  EXPORT_REQUESTED: 'EXPORT_REQUESTED',
  EXPORT_QUEUED: 'EXPORT_QUEUED',
  EXPORT_STARTED: 'EXPORT_STARTED',
  EXPORT_RESUMED: 'EXPORT_RESUMED',
  EXPORT_BATCH_COMPLETED: 'EXPORT_BATCH_COMPLETED',
  EXPORT_CHECKPOINT_PERSISTED: 'EXPORT_CHECKPOINT_PERSISTED',
  EXPORT_INTERRUPTED: 'EXPORT_INTERRUPTED',
  EXPORT_CANCELLED: 'EXPORT_CANCELLED',
  EXPORT_ASSEMBLY_STARTED: 'EXPORT_ASSEMBLY_STARTED',
  EXPORT_ASSEMBLY_COMPLETED: 'EXPORT_ASSEMBLY_COMPLETED',
  EXPORT_VERIFICATION_STARTED: 'EXPORT_VERIFICATION_STARTED',
  EXPORT_VERIFICATION_PASSED: 'EXPORT_VERIFICATION_PASSED',
  EXPORT_VERIFICATION_FAILED: 'EXPORT_VERIFICATION_FAILED',
  EXPORT_COMPLETED: 'EXPORT_COMPLETED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  EXPORT_FAULT_INJECTED: 'EXPORT_FAULT_INJECTED',

  WORKER_WAKE_SENT: 'WORKER_WAKE_SENT',
  WORKER_WAKE_FAILED: 'WORKER_WAKE_FAILED',

  STALLED_JOB_SWEPT: 'STALLED_JOB_SWEPT',
  REQUEST_FAILED: 'REQUEST_FAILED',
  AUTH_REGISTERED: 'AUTH_REGISTERED',
  AUTH_LOGIN_OK: 'AUTH_LOGIN_OK',
  AUTH_LOGIN_REJECTED: 'AUTH_LOGIN_REJECTED',
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];
