import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../app';
import { prisma } from '../../config/prisma';

let app: Express;
const emails: string[] = [];

function uniqueEmail(prefix: string) {
  const email = `${prefix}-${crypto.randomUUID()}@example.com`;
  emails.push(email);
  return email;
}

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe('POST /api/auth/register', () => {
  it('creates a user and returns the contract shape', async () => {
    const email = uniqueEmail('register');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Test User', email, password: 'StrongPassword123!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toMatchObject({ name: 'Test User', email });
    expect(res.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    const email = uniqueEmail('hash');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Hash User', email, password: 'StrongPassword123!' })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).not.toContain('StrongPassword123!');
    expect(user.passwordHash.startsWith('$2')).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('dupe');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'First', email, password: 'StrongPassword123!' })
      .expect(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Second', email, password: 'StrongPassword123!' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['missing name', { email: 'a@example.com', password: 'StrongPassword123!' }],
    ['bad email', { name: 'Test User', email: 'not-an-email', password: 'StrongPassword123!' }],
    ['short password', { name: 'Test User', email: 'b@example.com', password: 'Short1' }],
    ['no uppercase', { name: 'Test User', email: 'c@example.com', password: 'alllowercase1' }],
    ['no digit', { name: 'Test User', email: 'd@example.com', password: 'NoDigitsHere' }],
  ])('rejects %s with a field-level validation error', async (_label, payload) => {
    const res = await request(app).post('/api/auth/register').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });
});

describe('POST /api/auth/login', () => {
  const email = uniqueEmail('login');

  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Login User', email, password: 'StrongPassword123!' })
      .expect(201);
  });

  it('returns a JWT for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'StrongPassword123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token.split('.')).toHaveLength(3);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'WrongPassword123!' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('does not leak whether an account exists', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody-here@example.com', password: 'StrongPassword123!' });
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'WrongPassword123!' });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });
});

describe('protected routes', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await request(app).get('/api/auth/me').set('authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const jwt = await import('jsonwebtoken');
    const forged = jwt.default.sign({ sub: crypto.randomUUID(), email: 'x@example.com' }, 'a'.repeat(40));
    const res = await request(app).get('/api/auth/me').set('authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and returns the caller', async () => {
    const email = uniqueEmail('me');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Me User', email, password: 'StrongPassword123!' })
      .expect(201);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'StrongPassword123!' })
      .expect(200);

    const res = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });
});

describe('GET /health', () => {
  it('returns ok with a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('reports every dependency on the readiness probe', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(true);
    expect(res.body.checks.storage.ok).toBe(true);
    expect(res.body.checks.queue.ok).toBe(true);
  });
});
