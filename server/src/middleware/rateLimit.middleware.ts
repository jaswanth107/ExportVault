import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const disabled = env.NODE_ENV === 'test';

/** Broad protection against excessive resource consumption. */
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: disabled ? 100_000 : 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

/** Credential endpoints are the ones worth brute forcing, so they are tighter. */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: disabled ? 100_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' },
  },
});

/** Creating an export is expensive; cap how fast a user can queue them. */
export const exportCreationLimiter = rateLimit({
  windowMs: 60_000,
  limit: disabled ? 100_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? req.ip ?? 'anonymous',
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many export jobs created; slow down' },
  },
});
