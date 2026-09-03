import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '../../config/prisma';
import {
  captureSnapshotMaxId,
  countRecordsWithinSnapshot,
  fetchRecordBatch,
} from '../../services/recordSource.service';
import { ensureRecords } from '../helpers/testHelpers';

describe('snapshot boundary filtering', () => {
  let snapshotMaxId: bigint;

  beforeAll(async () => {
    await ensureRecords(60_000);
    snapshotMaxId = await captureSnapshotMaxId();
  });

  it('captures MAX(id) as the export boundary', async () => {
    const dbMax = await prisma.$queryRaw<{ max: bigint }[]>`SELECT MAX(id) AS max FROM records`;
    expect(snapshotMaxId).toBe(dbMax[0]!.max);
  });

  it('never returns a row beyond the snapshot boundary', async () => {
    const boundary = 500n;
    const rows = await fetchRecordBatch({ afterId: 490n, snapshotMaxId: boundary, limit: 1000 });
    expect(rows.length).toBe(10);
    expect(rows.every((r) => BigInt(r.id) <= boundary)).toBe(true);
    expect(rows.at(-1)!.id).toBe('500');
  });

  it('returns rows in strictly ascending id order', async () => {
    const rows = await fetchRecordBatch({ afterId: 0n, snapshotMaxId, limit: 1000 });
    const ids = rows.map((r) => BigInt(r.id));
    expect(ids).toHaveLength(1000);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('produces disjoint, gapless pages when walked by cursor', async () => {
    const seen = new Set<string>();
    let cursor = 0n;
    for (let page = 0; page < 5; page += 1) {
      const rows = await fetchRecordBatch({ afterId: cursor, snapshotMaxId, limit: 200 });
      for (const row of rows) {
        expect(seen.has(row.id), `id ${row.id} appeared twice across pages`).toBe(false);
        seen.add(row.id);
      }
      cursor = BigInt(rows.at(-1)!.id);
    }
    expect(seen.size).toBe(1000);
    // Gapless: ids 1..1000 with no holes.
    expect([...seen].map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 1000 }, (_, i) => i + 1),
    );
  });

  it('excludes rows inserted after the boundary was captured', async () => {
    const boundary = await captureSnapshotMaxId();
    const before = await countRecordsWithinSnapshot(boundary);

    const inserted = await prisma.record.create({
      data: {
        externalId: crypto.randomUUID(),
        name: 'Inserted After Snapshot',
        email: 'after-snapshot@example.com',
        category: 'test',
        amount: '1.00',
        status: 'active',
      },
    });

    expect(inserted.id > boundary).toBe(true);
    expect(await countRecordsWithinSnapshot(boundary)).toBe(before);

    const tail = await fetchRecordBatch({
      afterId: boundary - 5n,
      snapshotMaxId: boundary,
      limit: 100,
    });
    expect(tail.some((r) => r.id === inserted.id.toString())).toBe(false);

    await prisma.record.delete({ where: { id: inserted.id } });
  });

  it('returns an empty page once the cursor reaches the boundary', async () => {
    const rows = await fetchRecordBatch({
      afterId: snapshotMaxId,
      snapshotMaxId,
      limit: 100,
    });
    expect(rows).toEqual([]);
  });
});
