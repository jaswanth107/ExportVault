import { describe, it, expect } from 'vitest';
import {
  CSV_COLUMNS,
  CSV_HEADER_LINE,
  csvHeader,
  escapeCsvField,
  serializeCsvChunk,
  serializeCsvRow,
} from '../../utils/csv';

describe('CSV serialisation', () => {
  it('uses the exact deterministic column order required by the spec', () => {
    expect([...CSV_COLUMNS]).toEqual([
      'id',
      'external_id',
      'name',
      'email',
      'category',
      'amount',
      'status',
      'created_at',
      'updated_at',
    ]);
    expect(CSV_HEADER_LINE).toBe(
      'id,external_id,name,email,category,amount,status,created_at,updated_at',
    );
    expect(csvHeader()).toBe(`${CSV_HEADER_LINE}\n`);
  });

  describe('escapeCsvField', () => {
    it('passes plain values through unquoted', () => {
      expect(escapeCsvField('hello')).toBe('hello');
      expect(escapeCsvField(42)).toBe('42');
    });

    it('renders null and undefined as empty fields', () => {
      expect(escapeCsvField(null)).toBe('');
      expect(escapeCsvField(undefined)).toBe('');
      expect(escapeCsvField('')).toBe('');
    });

    it('quotes fields containing a comma', () => {
      expect(escapeCsvField('Osvaldo Haag, Jr.')).toBe('"Osvaldo Haag, Jr."');
    });

    it('doubles embedded quotes and wraps the field', () => {
      expect(escapeCsvField('Verona "The Exporter"')).toBe('"Verona ""The Exporter"""');
    });

    it('quotes fields containing newlines and carriage returns', () => {
      expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
      expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
    });

    it('preserves unicode without mangling it', () => {
      expect(escapeCsvField('Ünïcødé ✅')).toBe('Ünïcødé ✅');
    });
  });

  describe('serializeCsvRow', () => {
    it('emits every column in order, filling missing keys with empty fields', () => {
      expect(
        serializeCsvRow({
          id: '7',
          external_id: 'abc',
          name: 'Jane',
          email: 'jane@example.com',
          category: null,
          amount: '10.50',
          status: 'active',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        }),
      ).toBe('7,abc,Jane,jane@example.com,,10.50,active,2024-01-01T00:00:00.000Z,2024-01-02T00:00:00.000Z');
    });

    it('never emits more or fewer fields than there are columns', () => {
      const line = serializeCsvRow({ id: '1', extraneous: 'ignored' });
      expect(line.split(',')).toHaveLength(CSV_COLUMNS.length);
    });
  });

  describe('serializeCsvChunk', () => {
    it('newline-terminates every row', () => {
      const chunk = serializeCsvChunk([{ id: '1' }, { id: '2' }]);
      expect(chunk.endsWith('\n')).toBe(true);
      expect(chunk.split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('returns an empty string for an empty batch rather than a stray newline', () => {
      expect(serializeCsvChunk([])).toBe('');
    });
  });
});
