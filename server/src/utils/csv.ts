/**
 * Minimal RFC 4180 CSV serialisation.
 *
 * Deliberately hand-written and unit-tested rather than pulled from a library,
 * because the verification engine parses the output with an INDEPENDENT parser
 * (`csv-parse`). If writer and verifier shared an implementation, a bug in the
 * shared code would cancel itself out and verification would prove nothing.
 */

/** Deterministic column order for every exported CSV. */
export const CSV_COLUMNS = [
  'id',
  'external_id',
  'name',
  'email',
  'category',
  'amount',
  'status',
  'created_at',
  'updated_at',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const CSV_HEADER_LINE = CSV_COLUMNS.join(',');

/**
 * Escapes a single CSV field per RFC 4180:
 *  - null/undefined become an empty field
 *  - fields containing `"`, `,`, CR or LF are wrapped in double quotes
 *  - embedded double quotes are doubled
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (str === '') return '';
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialises one already-normalised row into a CSV line (no trailing newline). */
export function serializeCsvRow(row: Record<string, unknown>): string {
  return CSV_COLUMNS.map((column) => escapeCsvField(row[column])).join(',');
}

/** Serialises a batch of rows into a newline-terminated CSV chunk. */
export function serializeCsvChunk(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  return `${rows.map(serializeCsvRow).join('\n')}\n`;
}

/** The header row, newline terminated. */
export function csvHeader(): string {
  return `${CSV_HEADER_LINE}\n`;
}
