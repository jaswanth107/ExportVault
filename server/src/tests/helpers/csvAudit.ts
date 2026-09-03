import { parse } from 'csv-parse';
import { getObjectStream } from '../../services/storage.service';
import { CSV_COLUMNS } from '../../utils/csv';

export interface CsvAudit {
  header: string[];
  rowCount: number;
  uniqueIds: number;
  duplicates: number;
  ids: number[];
  externalIds: Set<string>;
  malformed: number;
  strictlyAscending: boolean;
  minId: number | null;
  maxId: number | null;
}

/**
 * Independent audit of an exported CSV, used by tests.
 * Deliberately re-reads the real object from storage rather than trusting any
 * in-process state or the application's own verification result.
 */
export async function auditCsvObject(key: string): Promise<CsvAudit> {
  const stream = await getObjectStream(key);
  const parser = parse({ bom: true, relaxColumnCount: false });

  let header: string[] = [];
  const ids: number[] = [];
  const externalIds = new Set<string>();
  const seen = new Set<number>();
  let duplicates = 0;
  let malformed = 0;
  let rowIndex = 0;

  await new Promise<void>((resolve, reject) => {
    parser.on('readable', () => {
      let row: string[] | null;
      while ((row = parser.read() as string[] | null) !== null) {
        if (rowIndex === 0) {
          header = row;
          rowIndex += 1;
          continue;
        }
        rowIndex += 1;
        if (row.length !== CSV_COLUMNS.length) {
          malformed += 1;
          continue;
        }
        const id = Number(row[0]);
        if (!Number.isSafeInteger(id)) {
          malformed += 1;
          continue;
        }
        if (seen.has(id)) duplicates += 1;
        seen.add(id);
        ids.push(id);
        externalIds.add(row[1] as string);
      }
    });
    parser.on('error', reject);
    parser.on('end', resolve);
    stream.on('error', reject);
    stream.pipe(parser);
  });

  return {
    header,
    rowCount: ids.length,
    uniqueIds: seen.size,
    duplicates,
    ids,
    externalIds,
    malformed,
    strictlyAscending: ids.every((id, i) => i === 0 || id > ids[i - 1]!),
    minId: ids.length ? Math.min(...ids) : null,
    maxId: ids.length ? Math.max(...ids) : null,
  };
}
