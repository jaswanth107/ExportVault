import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service';
import { UnauthorizedError } from '../utils/errors';

/** Rejects any request without a valid bearer token. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) throw new UnauthorizedError('Missing bearer token');

    const payload = verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch (error) {
    next(error);
  }
}
