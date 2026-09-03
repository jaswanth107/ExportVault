import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseRecord } from '../../services/recordSource.service';

const SRC_DIR = path.resolve(__dirname, '..', '..');

function readAllSourceFiles(dir: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      out.push(...readAllSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ file: full, content: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('keyset pagination guarantees', () => {
  it('never uses OFFSET pagination anywhere in the application source', () => {
    const offenders = readAllSourceFiles(SRC_DIR).filter(({ content }) => {
      // Strip comments first so prose about OFFSET does not trip the guard.
      const code = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // SQL `OFFSET <value>` and Prisma's `skip:` option, which compiles to OFFSET.
      const sqlOffset = /\bOFFSET\s+[\d$:{]/i.test(code);
      const prismaSkip = /(^|[^A-Za-z])skip\s*:/.test(code);
      return sqlOffset || prismaSkip;
    });

    expect(
      offenders.map((o) => path.relative(SRC_DIR, o.file)),
      'OFFSET/skip pagination is unstable under concurrent writes and is forbidden',
    ).toEqual([]);
  });

  it('paginates with a strict id > cursor bounded by the snapshot', () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'services', 'recordSource.service.ts'),
      'utf8',
    );
    expect(source).toContain('WHERE id > ${afterId}');
    expect(source).toContain('AND id <= ${snapshotMaxId}');
    expect(source).toContain('ORDER BY id ASC');
    expect(source).toContain('LIMIT ${limit}');
  });
});

describe('record normalisation', () => {
  const base = {
    id: 42n,
    external_id: '570351f5-7354-41b2-bad2-e7590e550aa7',
    name: 'Osvaldo Haag, Jr.',
    email: 'osvaldo@example.com',
    category: 'billing',
    amount: '1234.56',
    status: 'active',
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-02T00:00:00.000Z'),
  };

  it('stringifies BigInt ids losslessly', () => {
    expect(normaliseRecord({ ...base, id: 9007199254740993n }).id).toBe('9007199254740993');
  });

  it('preserves DECIMAL(12,2) exactly as the database returned it', () => {
    expect(normaliseRecord(base).amount).toBe('1234.56');
    expect(normaliseRecord({ ...base, amount: '0.00' }).amount).toBe('0.00');
  });

  it('renders nullable columns as empty strings, never the text "null"', () => {
    const row = normaliseRecord({ ...base, category: null, amount: null, status: null });
    expect(row.category).toBe('');
    expect(row.amount).toBe('');
    expect(row.status).toBe('');
  });

  it('emits timestamps as ISO-8601 UTC', () => {
    expect(normaliseRecord(base).created_at).toBe('2024-01-01T00:00:00.000Z');
  });
});
