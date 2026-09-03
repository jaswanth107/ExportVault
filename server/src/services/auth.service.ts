import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';
import { ConflictError, UnauthorizedError } from '../utils/errors';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch (error) {
    // The reason is logged for operators but never leaked to the client.
    logger.warn({ err: error }, 'JWT verification failed');
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export async function registerUser(input: { name: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new ConflictError('An account with that email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: { name: input.name.trim(), email, passwordHash },
    select: { id: true, name: true, email: true, createdAt: true },
  });

  logger.info({ event: LogEvent.AUTH_REGISTERED, userId: user.id }, 'User registered');
  return user;
}

export async function loginUser(input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Identical response for "unknown email" and "wrong password" so the endpoint
  // cannot be used to enumerate accounts.
  if (!user) {
    logger.warn({ event: LogEvent.AUTH_LOGIN_REJECTED, reason: 'unknown_email' }, 'Login rejected');
    throw new UnauthorizedError('Invalid email or password');
  }

  const matches = await bcrypt.compare(input.password, user.passwordHash);
  if (!matches) {
    logger.warn(
      { event: LogEvent.AUTH_LOGIN_REJECTED, userId: user.id, reason: 'bad_password' },
      'Login rejected',
    );
    throw new UnauthorizedError('Invalid email or password');
  }

  const token = signToken({ sub: user.id, email: user.email });
  logger.info({ event: LogEvent.AUTH_LOGIN_OK, userId: user.id }, 'User logged in');

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}
