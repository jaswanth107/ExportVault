import { prisma } from '../config/prisma';

/** One record as it will be written to CSV (already normalised to strings). */
export interface ExportableRow {
  id: string;
  external_id: string;
  name: string;
  email: string;
  category: string;
  amount: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RawRecordRow {
  id: bigint;
  external_id: string;
  name: string;
  email: string;
  category: string | null;
  amount: string | number | null;
  status: string | null;
  created_at: Date;
  updated_at: Date;
}

function formatAmount(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  // DECIMAL(12,2) comes back from the pg driver as a string; keep it verbatim so
  // the exported value is byte-identical to what the database holds.
  return typeof value === 'string' ? value : value.toFixed(2);
}

function formatTimestamp(value: Date): string {
  return value.toISOString();
}

export function normaliseRecord(row: RawRecordRow): ExportableRow {
  return {
    id: row.id.toString(),
    external_id: row.external_id,
    name: row.name,
    email: row.email,
    category: row.category ?? '',
    amount: formatAmount(row.amount),
    status: row.status ?? '',
    created_at: formatTimestamp(row.created_at),
    updated_at: formatTimestamp(row.updated_at),
  };
}

/**
 * Deterministic KEYSET pagination.
 *
 * OFFSET is deliberately NOT used anywhere in this codebase: with concurrent
 * INSERT/DELETE traffic, OFFSET shifts rows between pages, which silently
 * duplicates and skips records. Keying off the monotonically increasing primary
 * key makes each page independent of everything happening around it.
 *
 * `snapshotMaxId` is the immutable upper boundary captured when the job was
 * created, so rows inserted mid-export (which get higher ids) can never enter
 * this result set.
 */
export async function fetchRecordBatch(params: {
  afterId: bigint;
  snapshotMaxId: bigint;
  limit: number;
}): Promise<ExportableRow[]> {
  const { afterId, snapshotMaxId, limit } = params;

  const rows = await prisma.$queryRaw<RawRecordRow[]>`
    SELECT id, external_id, name, email, category, amount, status, created_at, updated_at
    FROM records
    WHERE id > ${afterId}
      AND id <= ${snapshotMaxId}
    ORDER BY id ASC
    LIMIT ${limit}
  `;

  return rows.map(normaliseRecord);
}

/** Captures the stable upper export boundary: MAX(id) at this instant. */
export async function captureSnapshotMaxId(): Promise<bigint> {
  const result = await prisma.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(id) AS max FROM records
  `;
  return result[0]?.max ?? 0n;
}

/** Number of rows currently eligible for export at or below a boundary. */
export async function countRecordsWithinSnapshot(snapshotMaxId: bigint): Promise<number> {
  const result = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM records WHERE id <= ${snapshotMaxId}
  `;
  return Number(result[0]?.count ?? 0n);
}
