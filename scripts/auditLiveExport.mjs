/**
 * Drives a real 50,000-row export against the running API, downloads the CSV
 * through the signed URL, and audits it with Node's own parsing — independent
 * of the server code that produced it.
 *
 * Usage: node scripts/auditLiveExport.mjs [apiBaseUrl]
 */
import crypto from 'node:crypto';

const API = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:5000').replace(/\/$/, '');
const TARGET = 50_000;
// Free hosting tiers spin services down after idle, so a cold start can take
// ~60s and the worker may wake only after the API has. Be patient rather than
// declaring a working deployment broken.
const WAKE_TIMEOUT_MS = 180_000;
const EXPORT_TIMEOUT_MS = 900_000;
const EXPECTED_HEADER = 'id,external_id,name,email,category,amount,status,created_at,updated_at';

const email = `audit-${Date.now().toString(36)}@example.com`;
const password = 'StrongPassword123!';

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Minimal RFC 4180 parser, written here so the audit shares no code with the server. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Waits for a possibly-sleeping service to answer /health. */
async function waitForApi() {
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return await res.json();
      console.log(`  /health returned HTTP ${res.status}; retrying (attempt ${attempt})`);
    } catch (error) {
      console.log(`  API not reachable yet (${error.message}); retrying (attempt ${attempt})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`API at ${API} did not become healthy within ${WAKE_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function main() {
  console.log(`API: ${API}`);
  console.log('waking the API (free tiers spin down when idle)...');
  const health = await waitForApi();
  console.log(`health: ${JSON.stringify(health)}`);

  // Readiness proves the API can actually reach Postgres, Redis and storage.
  try {
    const readyRes = await fetch(`${API}/health/ready`);
    const ready = await readyRes.json();
    console.log(`readiness: HTTP ${readyRes.status} ${JSON.stringify(ready.checks)}`);
    if (!readyRes.ok) {
      throw new Error(
        `Dependencies are unhealthy, so the export would fail: ${JSON.stringify(ready.checks)}`,
      );
    }
  } catch (error) {
    if (error.message.startsWith('Dependencies')) throw error;
    console.log(`readiness check could not be read: ${error.message}`);
  }

  await call('/api/auth/register', {
    method: 'POST',
    body: { name: 'CSV Auditor', email, password },
  });
  const { token } = await call('/api/auth/login', { method: 'POST', body: { email, password } });

  const created = await call('/api/exports', {
    method: 'POST',
    body: { rowLimit: TARGET },
    token,
  });
  const job = created.export;
  console.log(`export created: ${job.id}`);
  console.log(`snapshot_max_id captured at creation: ${job.snapshotMaxId}`);

  const started = Date.now();
  let detail;
  let lastReport = 0;
  let queuedSince = null;
  for (;;) {
    detail = await call(`/api/exports/${job.id}`, { token });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(detail.status)) break;

    // Surface progress instead of sitting silent for minutes.
    if (Date.now() - lastReport > 5_000) {
      lastReport = Date.now();
      console.log(
        `  status=${detail.status} rows=${detail.progress.exportedRows}/${detail.progress.targetRows} ` +
          `(${detail.progress.percentage}%) checkpoints=${detail.checkpointCount}`,
      );
    }

    // A job stuck in QUEUED means nothing is consuming the queue.
    if (detail.status === 'QUEUED' || detail.status === 'PENDING') {
      queuedSince ??= Date.now();
      if (Date.now() - queuedSince > 120_000) {
        throw new Error(
          `Export sat in ${detail.status} for over 2 minutes — no worker claimed it. ` +
            'Check that (a) the worker service is deployed and running, (b) it points at the SAME Redis/Key Value ' +
            'instance as the API, and (c) it points at the SAME database. A worker sharing the queue but using a ' +
            'different DATABASE_URL will consume the job, fail to find it, and log EXPORT_JOB_MISSING.',
        );
      }
    } else {
      queuedSince = null;
    }

    if (Date.now() - started > EXPORT_TIMEOUT_MS) {
      throw new Error(
        `Export did not finish within ${EXPORT_TIMEOUT_MS / 60_000} minutes (last status ${detail.status}, ` +
          `${detail.progress.exportedRows} rows)`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.log(`final status: ${detail.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (detail.status !== 'COMPLETED') {
    throw new Error(`Export ended as ${detail.status}: ${detail.errorMessage}`);
  }
  console.log(`checkpoints persisted: ${detail.checkpointCount}`);
  console.log(`server-reported verification: ${JSON.stringify(detail.verification, null, 2)}`);

  const { download } = await call(`/api/exports/${job.id}/download`, { token });
  console.log(`\ndownloading ${download.filename} (signed URL, ttl ${download.expiresInSeconds}s)`);

  const fileRes = await fetch(download.url);
  if (!fileRes.ok) throw new Error(`Download failed: HTTP ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  const rows = parseCsv(text);
  const header = rows[0].join(',');
  const dataRows = rows.slice(1).filter((r) => r.length > 1 || r[0] !== '');

  const ids = dataRows.map((r) => Number(r[0]));
  const unique = new Set(ids);
  const wrongWidth = dataRows.filter((r) => r.length !== 9).length;
  const ascending = ids.every((id, i) => i === 0 || id > ids[i - 1]);
  const beyondSnapshot = ids.filter((id) => id > Number(job.snapshotMaxId)).length;

  console.log('\n================= INDEPENDENT CSV AUDIT =================');
  console.log(`file bytes                 : ${buffer.byteLength}`);
  console.log(`sha256 (downloaded)        : ${sha256}`);
  console.log(`sha256 (server reported)   : ${download.sha256}`);
  console.log(`sha256 match               : ${sha256 === download.sha256}`);
  console.log(`header                     : ${header}`);
  console.log(`header matches spec        : ${header === EXPECTED_HEADER}`);
  console.log(`physical lines in file     : ${text.split('\n').length - 1}`);
  console.log(`parsed data rows           : ${dataRows.length}`);
  console.log(`unique ids                 : ${unique.size}`);
  console.log(`duplicate ids              : ${dataRows.length - unique.size}`);
  console.log(`rows with wrong width      : ${wrongWidth}`);
  console.log(`ids strictly ascending     : ${ascending}`);
  console.log(`min id / max id            : ${Math.min(...ids)} / ${Math.max(...ids)}`);
  console.log(`snapshot boundary          : ${job.snapshotMaxId}`);
  console.log(`ids beyond snapshot        : ${beyondSnapshot}`);
  console.log('=========================================================');

  const problems = [];
  if (header !== EXPECTED_HEADER) problems.push('header mismatch');
  if (dataRows.length !== TARGET) problems.push(`expected ${TARGET} rows, found ${dataRows.length}`);
  if (unique.size !== TARGET) problems.push(`expected ${TARGET} unique ids, found ${unique.size}`);
  if (wrongWidth !== 0) problems.push(`${wrongWidth} malformed rows`);
  if (!ascending) problems.push('ids not strictly ascending');
  if (beyondSnapshot !== 0) problems.push(`${beyondSnapshot} rows beyond snapshot`);
  if (sha256 !== download.sha256) problems.push('sha256 mismatch');

  if (problems.length > 0) {
    console.error(`\nAUDIT FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('\nAUDIT PASSED: exactly 50,000 unique rows, 0 duplicates, nothing beyond the snapshot.');
}

main().catch((error) => {
  console.error('\nAUDIT ERROR:', error.message);
  process.exit(1);
});
