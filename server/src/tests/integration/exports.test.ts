import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { ExportStatus } from '@prisma/client';
import { createApp } from '../../app';
import { prisma } from '../../config/prisma';
import { createTestUser, ensureRecords } from '../helpers/testHelpers';
import { closeExportQueue } from '../../queues/export.queue';

let app: Express;
let alice: Awaited<ReturnType<typeof createTestUser>>;
let bob: Awaited<ReturnType<typeof createTestUser>>;
let maxRecordId: bigint;

beforeAll(async () => {
  app = createApp();
  await ensureRecords(60_000);
  alice = await createTestUser('alice');
  bob = await createTestUser('bob');
  const max = await prisma.$queryRaw<{ max: bigint }[]>`SELECT MAX(id) AS max FROM records`;
  maxRecordId = max[0]!.max;
});

afterAll(async () => {
  await prisma.exportJob.deleteMany({ where: { userId: { in: [alice.user.id, bob.user.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [alice.user.id, bob.user.id] } } });
  await closeExportQueue();
});

describe('POST /api/exports', () => {
  it('creates a job, captures the snapshot boundary and queues it', async () => {
    const res = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 50000 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.export.status).toBe('QUEUED');
    expect(res.body.export.requestedRowLimit).toBe(50000);
    expect(res.body.export.snapshotMaxId).toBe(Number(maxRecordId));
    expect(res.body.export.id).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: res.body.export.id } });
    expect(stored.snapshotMaxId).toBe(maxRecordId);
    expect(stored.exportedRowCount).toBe(0);
    expect(stored.lastExportedId).toBeNull();
  });

  it('captures the boundary at request time, excluding later inserts', async () => {
    const created = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 1000 })
      .expect(201);

    const boundary = BigInt(created.body.export.snapshotMaxId);

    const later = await prisma.record.create({
      data: {
        externalId: crypto.randomUUID(),
        name: 'Post-snapshot row',
        email: 'post@example.com',
        category: 'test',
        amount: '5.00',
        status: 'active',
      },
    });

    expect(later.id > boundary).toBe(true);

    // A second export sees the new row; the first one never will.
    const second = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 1000 })
      .expect(201);

    expect(BigInt(second.body.export.snapshotMaxId)).toBeGreaterThanOrEqual(later.id);
    await prisma.record.delete({ where: { id: later.id } });
  });

  it('defaults rowLimit to 50000 when omitted', async () => {
    const res = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({})
      .expect(201);
    expect(res.body.export.requestedRowLimit).toBe(50000);
  });

  it.each([
    ['above the 50000 cap', 50001],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
  ])('rejects a rowLimit that is %s', async (_label, rowLimit) => {
    const res = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    await request(app).post('/api/exports').send({ rowLimit: 50000 }).expect(401);
  });
});

describe('GET /api/exports', () => {
  it('returns only the calling user\'s exports', async () => {
    await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${bob.token}`)
      .send({ rowLimit: 100 })
      .expect(201);

    const aliceList = await request(app)
      .get('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .expect(200);
    const bobList = await request(app)
      .get('/api/exports')
      .set('authorization', `Bearer ${bob.token}`)
      .expect(200);

    const aliceIds = new Set(aliceList.body.exports.map((e: { id: string }) => e.id));
    const bobIds = new Set(bobList.body.exports.map((e: { id: string }) => e.id));

    expect(bobIds.size).toBe(1);
    for (const id of bobIds) expect(aliceIds.has(id)).toBe(false);
  });
});

describe('export ownership (broken access control)', () => {
  let aliceExportId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 100 })
      .expect(201);
    aliceExportId = res.body.export.id;
  });

  it.each([
    ['GET detail', 'get', ''],
    ['GET verify', 'get', '/verify'],
    ['GET download', 'get', '/download'],
    ['POST resume', 'post', '/resume'],
    ['POST cancel', 'post', '/cancel'],
  ])('blocks another user from %s with 404, never 403 leakage', async (_label, method, suffix) => {
    const req =
      method === 'get'
        ? request(app).get(`/api/exports/${aliceExportId}${suffix}`)
        : request(app).post(`/api/exports/${aliceExportId}${suffix}`);

    const res = await req.set('authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Export job not found');
  });

  it('returns 404 for an unknown export id', async () => {
    const res = await request(app)
      .get(`/api/exports/${crypto.randomUUID()}`)
      .set('authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-UUID export id with 400', async () => {
    const res = await request(app)
      .get('/api/exports/not-a-uuid')
      .set('authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('download authorization', () => {
  it('refuses to hand out a URL for an export that is not COMPLETED', async () => {
    const created = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 100 })
      .expect(201);

    const res = await request(app)
      .get(`/api/exports/${created.body.export.id}/download`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/only COMPLETED exports can be downloaded/i);
  });

  it('refuses to hand out a URL when verification has not passed', async () => {
    // Force a job into COMPLETED with no passing verification on record.
    const job = await prisma.exportJob.create({
      data: {
        userId: alice.user.id,
        status: ExportStatus.COMPLETED,
        snapshotMaxId: maxRecordId,
        requestedRowLimit: 100,
        exportedRowCount: 100,
        fileKey: 'exports/fake/file.csv',
      },
    });

    const res = await request(app)
      .get(`/api/exports/${job.id}/download`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/has not passed verification/i);
  });
});

describe('cancel and resume state machine', () => {
  it('cancels a queued export', async () => {
    const created = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 100 })
      .expect(201);

    const res = await request(app)
      .post(`/api/exports/${created.body.export.id}/cancel`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.export.status).toBe('CANCELLED');
  });

  it('refuses to resume a cancelled export', async () => {
    const created = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 100 })
      .expect(201);
    await request(app)
      .post(`/api/exports/${created.body.export.id}/cancel`)
      .set('authorization', `Bearer ${alice.token}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/exports/${created.body.export.id}/resume`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/cancelled/i);
  });

  it('moves an INTERRUPTED export to RESUMING and preserves progress', async () => {
    const job = await prisma.exportJob.create({
      data: {
        userId: alice.user.id,
        status: ExportStatus.INTERRUPTED,
        snapshotMaxId: maxRecordId,
        requestedRowLimit: 50_000,
        exportedRowCount: 23_000,
        lastExportedId: 23_000n,
        errorMessage: 'Worker died',
      },
    });

    const res = await request(app)
      .post(`/api/exports/${job.id}/resume`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.export.status).toBe('RESUMING');
    // Resume must NOT reset progress back to zero.
    expect(res.body.export.exportedRowCount).toBe(23_000);
    expect(res.body.export.lastExportedId).toBe(23_000);
    expect(res.body.export.errorMessage).toBeNull();
  });
});

describe('GET /api/exports/:id verification endpoint', () => {
  it('reports honestly that there is nothing to verify yet', async () => {
    const created = await request(app)
      .post('/api/exports')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ rowLimit: 100 })
      .expect(201);

    const res = await request(app)
      .get(`/api/exports/${created.body.export.id}/verify`)
      .set('authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.verification).toBeNull();
    expect(res.body.message).toMatch(/no CSV has been produced/i);
  });
});
