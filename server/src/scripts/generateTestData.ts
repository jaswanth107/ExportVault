/**
 * Deterministic test-data generator for the `records` table.
 *
 * Usage:
 *   npm run seed:records                  # ensure >= 60,000 records exist
 *   npm run seed:records -- --count 75000
 *   npm run seed:records -- --reset       # TRUNCATE first (destructive)
 *
 * The generator deliberately includes CSV-hostile values (commas, double
 * quotes, embedded newlines, unicode) in a fraction of rows so that the export
 * pipeline's escaping is exercised by real data rather than assumed to work.
 */
import crypto from 'node:crypto';
import { faker } from '@faker-js/faker';
import { prisma } from '../config/prisma';
import { logger } from '../utils/logger';

const DEFAULT_TARGET = 60_000;
const INSERT_CHUNK = 2_000;

const CATEGORIES = [
  'billing',
  'analytics',
  'compliance',
  'logistics',
  'marketing',
  'operations',
  'research',
  'support',
] as const;

const STATUSES = ['active', 'pending', 'archived', 'suspended', 'closed'] as const;

/** Deterministic UUID derived from the row index — collision-free by construction. */
function deterministicUuid(index: number): string {
  const hex = crypto.createHash('sha256').update(`exportvault-record-${index}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Every 50th row gets a name that would break a naive CSV writer.
 * If escaping is wrong, verification will see a wrong column count and fail.
 */
function hostileName(index: number, base: string): string {
  switch (index % 250) {
    case 0:
      return `${base}, Jr.`;
    case 50:
      return `${base} "The Exporter"`;
    case 100:
      return `${base}\nSecond Line`;
    case 150:
      return `${base} — Ünïcødé ✅`;
    case 200:
      return `"${base}", "alias"`;
    default:
      return base;
  }
}

interface GeneratedRecord {
  externalId: string;
  name: string;
  email: string;
  category: string;
  amount: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function buildRecord(index: number): GeneratedRecord {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const base = `${firstName} ${lastName}`;
  const createdAt = new Date(Date.UTC(2024, 0, 1) + index * 60_000);

  return {
    externalId: deterministicUuid(index),
    name: hostileName(index, base),
    email: `${firstName}.${lastName}.${index}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com',
    category: CATEGORIES[index % CATEGORIES.length]!,
    amount: (((index * 7919) % 1_000_000) / 100).toFixed(2),
    status: STATUSES[index % STATUSES.length]!,
    createdAt,
    updatedAt: createdAt,
  };
}

function parseArgs(argv: string[]): { target: number; reset: boolean } {
  let target = DEFAULT_TARGET;
  const countFlagIndex = argv.findIndex((a) => a === '--count' || a === '-c');
  if (countFlagIndex !== -1 && argv[countFlagIndex + 1]) {
    const parsed = Number(argv[countFlagIndex + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--count must be a positive integer, received "${argv[countFlagIndex + 1]}"`);
    }
    target = parsed;
  }
  const inline = argv.find((a) => a.startsWith('--count='));
  if (inline) {
    const parsed = Number(inline.split('=')[1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--count must be a positive integer, received "${inline}"`);
    }
    target = parsed;
  }
  return { target, reset: argv.includes('--reset') };
}

export async function generateTestData(options: { target: number; reset: boolean }): Promise<{
  inserted: number;
  total: number;
}> {
  const { target, reset } = options;
  faker.seed(20260903);

  if (reset) {
    console.log('Resetting records table (TRUNCATE ... RESTART IDENTITY)...');
    await prisma.$executeRawUnsafe('TRUNCATE TABLE records RESTART IDENTITY CASCADE');
  }

  const existing = await prisma.record.count();
  const toInsert = Math.max(0, target - existing);

  if (toInsert === 0) {
    console.log(`Records table already holds ${existing} rows (target ${target}); nothing to insert.`);
    return { inserted: 0, total: existing };
  }

  console.log(`Generating ${toInsert} records...`);
  const startedAt = Date.now();
  let inserted = 0;

  for (let startIndex = 0; startIndex < toInsert; startIndex += INSERT_CHUNK) {
    const size = Math.min(INSERT_CHUNK, toInsert - startIndex);
    const batch = Array.from({ length: size }, (_, i) => buildRecord(existing + startIndex + i));

    const result = await prisma.record.createMany({ data: batch, skipDuplicates: true });

    // Verify the database agreed with us instead of assuming it did.
    if (result.count !== size) {
      throw new Error(
        `Insert verification failed at index ${startIndex}: sent ${size} rows, database accepted ${result.count}`,
      );
    }

    inserted += result.count;
    if (inserted % 10_000 === 0 || inserted === toInsert) {
      console.log(`  inserted ${inserted}/${toInsert}...`);
    }
  }

  const total = await prisma.record.count();
  const elapsedMs = Date.now() - startedAt;

  console.log(`Inserted ${inserted} records successfully.`);

  // Post-insert verification: count, uniqueness of external ids, and max id.
  const distinctExternalIds = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT external_id)::bigint AS count FROM records
  `;
  const distinct = Number(distinctExternalIds[0]?.count ?? 0n);
  const maxId = await prisma.$queryRaw<{ max: bigint | null }[]>`SELECT MAX(id) AS max FROM records`;

  if (total < target) {
    throw new Error(`Post-insert verification FAILED: expected at least ${target} rows, found ${total}`);
  }
  if (distinct !== total) {
    throw new Error(
      `Post-insert verification FAILED: ${total} rows but only ${distinct} distinct external_id values`,
    );
  }

  console.log(`Database total verified: ${total} (target ${target}+)`);
  console.log(`Distinct external_id values: ${distinct}`);
  console.log(`MAX(id): ${maxId[0]?.max ?? 0}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  return { inserted, total };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await generateTestData(options);
}

if (require.main === module) {
  main()
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (error) => {
      // Loud failure: seeding silently producing too few rows would invalidate
      // every downstream export claim.
      logger.error({ err: error }, 'Test data generation failed');
      console.error(`\nSEED FAILED: ${(error as Error).message}`);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
