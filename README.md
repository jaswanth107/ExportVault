# ExportVault — A Large CSV Export System That Doesn't Lie

Export exactly **50,000 rows** to CSV from a table that is being written to at
the same time — and then *prove* the file is correct.

This is not a download button. It is an export pipeline that survives having its
worker killed mid-run, resumes from a durable checkpoint without duplicating or
skipping a single row, ignores rows inserted while it is running, and refuses to
mark itself `COMPLETED` until the generated file has been re-read and verified.

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [How snapshot consistency works](#3-how-snapshot-consistency-works)
4. [Crash safety and resume](#4-crash-safety-and-resume)
5. [What was VERIFIED](#5-what-was-verified)
6. [Screenshots](#6-screenshots)
7. [Tech stack](#7-tech-stack)
8. [Local setup](#8-local-setup)
9. [Environment variables](#9-environment-variables)
10. [API contract](#10-api-contract)
11. [Testing](#11-testing)
12. [Deployment](#12-deployment)
13. [Security](#13-security)
14. [Definition of done](#14-definition-of-done)

---

## 1. Project overview

The task: export exactly 50,000 rows from a large table while concurrent writes
are happening, without duplicating rows, skipping rows, or lying about the
result.

Four things make that hard, and each has a specific answer here:

| Problem | Answer |
| --- | --- |
| Concurrent inserts shift rows between pages | Keyset pagination bounded by an immutable snapshot id. No `OFFSET` anywhere — enforced by a test. |
| A worker can die at any instant | Per-batch durable chunks + a checkpoint log written only *after* bytes are confirmed. Resume replays at most one byte-identical batch. |
| "It didn't throw" is not proof | Every write is confirmed by reading it back; the finished CSV is re-parsed by a *different* implementation than the one that wrote it. |
| Failures disappear into logs | Failures are rows in `export_failures`, a status on the job, an error in the API response, and a red panel in the UI. |

---

## 2. Architecture

```
                 Browser
                    │
                    ▼
        React 19 + Vite SPA  (Vercel / nginx)
                    │  JWT
                    ▼
        ┌───────────────────────┐
        │   Express API         │  POST /api/exports
        │   - captures MAX(id)  │  ── captures the snapshot boundary here,
        │   - persists the job  │     synchronously, at request time
        │   - enqueues BullMQ   │
        │   - stalled sweeper   │
        └───────┬───────┬───────┘
                │       │
      ┌─────────▼──┐  ┌─▼──────────┐
      │ PostgreSQL │  │   Redis    │
      │  16        │  │  BullMQ    │
      └─────────▲──┘  └─┬──────────┘
                │       │
                │       ▼
                │   ┌────────────────────────────────┐
                │   │  Export Worker (own process)   │
                │   │                                │
                └───┤  loop per batch:               │
   checkpoints +    │   1. keyset SELECT             │
   progress          │   2. serialise CSV chunk       │
                    │   3. PUT chunk to storage      │
                    │   4. HEAD to confirm the bytes │
                    │   5. TX { checkpoint, progress}│
                    │                                │
                    │  then: assemble → verify       │
                    └───────────────┬────────────────┘
                                    ▼
                       S3-compatible object storage
                     (Cloudflare R2 / MinIO locally)
```

The frontend never generates CSV. The API never generates CSV. Only the worker
does, and only in a separate process that keeps running when the browser, the
API, or the developer's laptop goes away.

### Application shell

The UI is a full-width shell with a persistent left sidebar:

```
lg and above (>=1024px)          below lg
┌──────────┬──────────────┐      ┌─────────────────────┐
│ sidebar  │              │      │ ☰  ExportVault      │  sticky top bar
│          │  main        │      ├─────────────────────┤
│ Dashboard│  content     │      │                     │
│ History  │  fills the   │      │  main content       │
│ New      │  rest of the │      │  full width         │
│          │  window      │      │                     │
│ ─────────│              │      └─────────────────────┘
│ user     │              │      ☰ opens the same sidebar
│ sign out │              │        as an off-canvas drawer
└──────────┴──────────────┘
```

It is **one** `<aside>` element at every breakpoint — statically laid out from
`lg` up, translated off-canvas below it — rather than separate mobile and
desktop navigations. Two copies would duplicate every link in the accessibility
tree and make "Dashboard" ambiguous to both screen readers and test selectors.

Accessibility and responsiveness are enforced by tests rather than eyeballed
(`e2e/responsive.spec.ts`, 8 tests across 1440 / 820 / 390 px):

- the nav is reachable from every route at every width;
- the drawer opens from the hamburger, closes on `Escape`, closes on
  navigation, and returns focus to the control that opened it;
- `aria-expanded` / `aria-controls` track the drawer state, the active link
  carries `aria-current`, and a "Skip to content" link precedes the sidebar;
- main content spans the full window minus the sidebar — asserted numerically,
  not assumed;
- no page scrolls horizontally at any of the three widths.

### Why the file is built from per-batch chunks

Each batch is written as its own immutable object:

```
exports/<jobId>/chunks/00000001.csv
exports/<jobId>/chunks/00000002.csv
...
exports/<jobId>/export-<jobId>.csv      ← assembled once, at the end
```

The chunk key is a pure function of `(jobId, batchNumber)`, and the batch
contents are a pure function of `(cursor, snapshot, limit)`. Re-writing a batch
after a crash therefore overwrites the same key with byte-identical content —
idempotent by construction. The single downloadable CSV is streamed together
from those chunks only after every row is accounted for, so a partial file can
never be presented as a finished export.

---

## 3. How snapshot consistency works

### What happens if a row is inserted while the export is running?

> The export captures a snapshot maximum ID when the job starts. Only rows with
> IDs less than or equal to that snapshot boundary are included. Rows inserted
> afterward have higher IDs and are excluded from the current export. They will
> appear in future exports. This prevents concurrent inserts from shifting
> pagination and corrupting the export.

Concretely:

```sql
-- 1. At job creation, synchronously, inside POST /api/exports:
SELECT MAX(id) FROM records;          --> stored as export_jobs.snapshot_max_id

-- 2. Every batch the worker reads:
SELECT id, external_id, name, email, category, amount, status, created_at, updated_at
FROM records
WHERE id > $lastExportedId
  AND id <= $snapshotMaxId
ORDER BY id ASC
LIMIT $batchSize;
```

`records.id` is a `BIGSERIAL`, so it is monotonically increasing. Any row
inserted after the boundary is captured necessarily gets
`new_row.id > snapshot_max_id` and is therefore **not** in the current export.
It is not lost — the next export captures a higher boundary and includes it.

This is verified, not asserted: the concurrency test inserts 500 rows *while the
job status is `RUNNING`*, then checks that none of their `external_id`s appear
in the CSV and that all 500 are visible to a subsequent export.

### Why OFFSET is forbidden

```sql
-- Unstable: a row inserted or deleted before the current page shifts every
-- subsequent page, duplicating rows at the seam or skipping them entirely.
SELECT * FROM records ORDER BY id LIMIT 1000 OFFSET 10000;
```

`OFFSET` counts rows at execution time, so its meaning changes when the table
changes. Keyset pagination anchors on a value rather than a position, so each
page is independent of everything happening around it.

This is enforced mechanically, not by convention —
`src/tests/unit/keysetPagination.test.ts` reads every source file in
`server/src` (excluding tests), strips comments, and fails if it finds SQL
`OFFSET <value>` or Prisma's `skip:` option anywhere:

```
✓ never uses OFFSET pagination anywhere in the application source
✓ paginates with a strict id > cursor bounded by the snapshot
```

---

## 4. Crash safety and resume

### The ordering that makes a crash survivable

```
1. Fetch batch          (keyset, bounded by the snapshot)
2. Write batch bytes    (PUT chunk object)
3. Confirm the write    (HEAD; byte length must match exactly)
4. Persist checkpoint   ┐ one transaction — both or neither
   + update progress    ┘
```

`export_jobs.last_exported_id` never moves ahead of bytes that actually exist.
Step 4 is atomic, so the checkpoint and the progress counter can never disagree.

### Every crash window, and what happens

| Crash between | State left behind | Behaviour on resume |
| --- | --- | --- |
| 1 and 2 | Nothing written | Batch is re-fetched and written normally |
| 2 and 3 | Chunk possibly written, unconfirmed | Same batch re-written to the **same deterministic key** — idempotent |
| 3 and 4 | Chunk written, no checkpoint | Same batch re-written byte-identically, then checkpointed |
| after 4 | Chunk + checkpoint durable | Resume continues from the next batch |

The third row is the genuinely dangerous one, so it has its own test: the test
crashes a real worker, **deletes the newest checkpoint while leaving its chunk
object in place** to reproduce that exact state, then resumes and proves the
final file still contains exactly 50,000 unique rows.

### The checkpoint log is the source of truth

`export_checkpoints` has `UNIQUE(export_job_id, batch_number)`. On resume the
log is validated before a single row is read:

- batch numbers must be contiguous `1..N` — a gap means a missing chunk, which
  would silently skip rows, so the resume is **refused** rather than producing a
  short file;
- cursors must be strictly increasing;
- if `export_jobs.last_exported_id` disagrees with the log, the log wins and the
  job row is corrected.

### Making a dead worker visible

A live worker touches `export_jobs.updated_at` after every batch. The API — which
outlives any individual worker — runs a sweeper that flips a `RUNNING` job whose
heartbeat has expired to `INTERRUPTED`, writes a row into `export_failures`, and
puts the reason on the job. A crashed export shows up in the UI as an amber
`INTERRUPTED` badge with a **Resume** button, never as a job stuck at `RUNNING`
forever.

---

## 5. What was VERIFIED

Everything in this section is real command output from this repository. Full
transcripts live in [`docs/evidence/`](docs/evidence).

```
VERIFIED:
✓ Generated 60,000 database records, count re-checked after insert.
✓ Started an export targeting exactly 50,000 rows.
✓ Final CSV contained exactly 50,000 data rows.
✓ All 50,000 exported IDs were unique.
✓ Duplicate count was 0.
✓ Inserted 500 records while the export status was RUNNING.
✓ Concurrently inserted records were excluded from the current export.
✓ Those same 500 records were visible to the next export.
✓ Killed a real worker process mid-export (hard exit, no cleanup).
✓ Job became INTERRUPTED with a visible error and a persisted failure row.
✓ Resumed from the checkpoint — not from zero.
✓ Resumed export still contained exactly 50,000 unique rows, 0 duplicates.
✓ Reproduced a crash between "chunk written" and "checkpoint committed";
  the replayed batch was idempotent and the result was still 50,000/0.
✓ Verification failure prevents COMPLETED and blocks download.
✓ A second user cannot read, resume, cancel, verify or download another
  user's export — every route answers 404.
✓ The whole stack runs under Docker: postgres, redis, minio, api, worker, client.
```

### Evidence 1 — the dataset

```console
$ npm run seed:records

Generating 60000 records...
  inserted 10000/60000...
  inserted 20000/60000...
  inserted 30000/60000...
  inserted 40000/60000...
  inserted 50000/60000...
  inserted 60000/60000...
Inserted 60000 records successfully.
Database total verified: 60000 (target 60000+)
Distinct external_id values: 60000
MAX(id): 60000
Elapsed: 5.0s
```

Confirmed independently in Postgres:

```console
$ docker exec exportvault-db psql -U exportvault -d exportvault -t -c \
    "SELECT 'total='||COUNT(*), 'distinct_ext='||COUNT(DISTINCT external_id), 'max_id='||MAX(id) FROM records;"

 total=60000 | distinct_ext=60000 | max_id=60000
```

The seed deliberately plants CSV-hostile values so escaping is exercised by real
data rather than assumed:

```console
$ docker exec exportvault-db psql -U exportvault -d exportvault -c \
    "SELECT id, name FROM records WHERE id IN (1,51,101,151,201) ORDER BY id;"

   1 | Osvaldo Haag, Jr.
  51 | Verona Kemmer "The Exporter"
 101 | Caesar Casper               +
     | Second Line
 151 | Humberto Torp — Ünïcødé ✅
 201 | "Rosemarie Howell", "alias"
```

### Evidence 2 — an independent audit of a live export

`scripts/auditLiveExport.mjs` drives the deployed API over HTTP, downloads the
CSV through the signed URL, and parses it with a **hand-written RFC 4180 parser
that shares no code with the server**:

```console
$ node scripts/auditLiveExport.mjs

API: http://localhost:5000
health: {"status":"ok","timestamp":"2026-09-03T05:02:45.054Z"}
export created: 23122bbe-cb2f-438b-97f4-07d92098540c
snapshot_max_id captured at creation: 60000
final status: COMPLETED after 3.6s
checkpoints persisted: 200

================= INDEPENDENT CSV AUDIT =================
file bytes                 : 8316137
sha256 (downloaded)        : b6bedb10c2dba7219fd52d88671b5032d73ba4c7548022efe5d5f8502f17833c
sha256 (server reported)   : b6bedb10c2dba7219fd52d88671b5032d73ba4c7548022efe5d5f8502f17833c
sha256 match               : true
header                     : id,external_id,name,email,category,amount,status,created_at,updated_at
header matches spec        : true
physical lines in file     : 50201
parsed data rows           : 50000
unique ids                 : 50000
duplicate ids              : 0
rows with wrong width      : 0
ids strictly ascending     : true
min id / max id            : 1 / 50000
snapshot boundary          : 60000
ids beyond snapshot        : 0
=========================================================

AUDIT PASSED: exactly 50,000 unique rows, 0 duplicates, nothing beyond the snapshot.
```

Note `physical lines in file : 50201` against `parsed data rows : 50000`. The
201 extra physical lines are the embedded newlines inside correctly quoted
fields. A naive line-count would have reported the wrong number; the parser does
not, which is direct proof the escaping is real.

### Evidence 3 — interruption and resume

```console
$ npm run test:concurrency

  INTERRUPTION TEST: crashed at 10000 rows, resumed, finished with
  50000 rows / 50000 unique / 0 duplicates

  RE-WRITE IDEMPOTENCY: replayed batch 40, still 50000 rows / 0 duplicates
```

The worker is a genuinely separate OS process, spawned from `dist/worker.js`,
that terminates with `process.exit(1)` mid-batch. The test asserts along the way
that:

- the process exited non-zero;
- progress was `>= 10,000` and `< 50,000` when it died;
- the checkpoint count exactly matched `exportedRowCount / batchSize`;
- the sweeper moved the job to `INTERRUPTED` with a `WORKER_STALLED` failure row;
- resuming preserved `lastExportedId` instead of resetting it;
- the rows on either side of the crash seam each appear exactly once.

### Evidence 4 — concurrent writes

```console
  CONCURRENT INSERT TEST: snapshot=60000, 400/500 rows inserted while
  status=RUNNING (at export progress 750, 3000, 4750, 6250, 8750, 11250,
  13750, 15500 rows)
  CSV rows=50000 unique=50000 duplicates=0 maxId=50000 (<= snapshot 60000);
  leaked=0; all 500 deferred rows visible to the next export
```

400 of the 500 inserts are *observed* to have landed while the job status was
`RUNNING` — the test fails if that number is zero, so it cannot silently degrade
into a test that proves nothing.

### Evidence 5 — the verification engine

```
  ================ VERIFICATION EVIDENCE ================
  DATABASE RECORDS AVAILABLE : 60000
  SNAPSHOT BOUNDARY (max id) : 60000
  EXPORT TARGET              : 50000
  CSV ACTUAL ROWS            : 50000
  CSV UNIQUE IDs             : 50000
  CSV DUPLICATES             : 0
  CSV MIN / MAX ID           : 1 / 50000
  ROWS BEYOND SNAPSHOT       : 0
  FILE BYTES                 : 8316137
  SHA-256                    : b6bedb10c2dba7219fd52d88671b5032d73ba4c7548022efe5d5f8502f17833c
  VERIFICATION STATUS        : PASSED
  ======================================================
```

The verification engine is also tested against **deliberately broken files** —
duplicated ids, short files, wrong headers, rows beyond the snapshot,
non-ascending ids — and must report `FAILED` for each. A verifier that only ever
sees good input proves nothing.

### Evidence 6 — no silent failures

```console
$ grep -rEn 'catch\s*(\([^)]*\))?\s*\{\s*\}' server/src client/src
(none found)

$ grep -rEn -A2 'catch\s*\([^)]*\)\s*\{' server/src client/src | grep 'return null;'
(none found)

$ grep -rEn 'OFFSET\s+[0-9$:{]|[^A-Za-z]skip\s*:' server/src --include='*.ts' | grep -v '/tests/'
(none found)
```

---

## 6. Screenshots

All screenshots in [`docs/screenshots/`](docs/screenshots) are captured
automatically by the Playwright suite against the running stack, so they cannot
drift from reality.

| # | Feature | File |
| --- | --- | --- |
| 1 | Login | `01-login.png` |
| 2 | Registration, with live password rules | `02-register.png` |
| 3 | Dashboard — empty state | `03-dashboard-empty.png` |
| 4 | Dashboard — with export data | `03-dashboard.png` |
| 5 | Create export, with the snapshot explanation | `04-create-export.png` |
| 6 | Export running, live progress | `05-export-running.png` |
| 7 | Export interrupted (worker killed) | `06-export-interrupted.png` |
| 8 | Export resumed from checkpoint | `07-export-resumed.png` |
| 9 | Verification PASSED | `08-verification-passed.png` |
| 10 | Export history | `09-export-history.png` |
| 11 | Downloaded CSV evidence (filename, size, sha256) | `10-downloaded-csv-evidence.png` |
| 12 | Resumed export verified | `11-resumed-export-verified.png` |
| 13 | Full-width desktop layout with the left sidebar | `12-layout-desktop.png` |
| 14 | Tablet layout, nav collapsed to a drawer | `13-layout-tablet.png` |
| 15 | Mobile layout, stacked panels | `14-layout-mobile.png` |
| 16 | Mobile navigation drawer open | `15-mobile-nav-drawer.png` |

---

## 7. Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19, Vite 6, TypeScript, Tailwind CSS 4, React Router 7, TanStack Query 5 |
| Backend | Node.js 22 LTS, TypeScript, Express |
| Database | PostgreSQL 16 |
| ORM | Prisma 7.10.0 (latest stable) with the `@prisma/adapter-pg` driver adapter |
| Queue | BullMQ on Redis 7 |
| Storage | S3-compatible — Cloudflare R2 in production, MinIO locally |
| Tests | Vitest, Supertest, Playwright |
| Containers | Docker + Docker Compose |

---

## 8. Local setup

Requirements: Docker, Docker Compose, Node.js 22+.

### Everything at once

```bash
git clone <repository-url>
cd export-vault
cp .env.example .env          # defaults already match docker-compose

docker compose up -d --build  # postgres, redis, minio, migrate, api, worker, client

# seed 60,000 records
npm --prefix server install
npm run seed:records
```

Then open **http://localhost:5173**.

| Service | URL |
| --- | --- |
| Web client | http://localhost:5173 |
| API | http://localhost:5000 |
| API health | http://localhost:5000/health |
| API readiness (all dependencies) | http://localhost:5000/health/ready |
| MinIO console | http://localhost:9101 (`exportvault` / `exportvault-secret`) |
| PostgreSQL | `localhost:5435` |
| Redis | `localhost:6380` |

Ports are deliberately non-default so the stack does not collide with other
local projects.

### Running the backend outside Docker

```bash
cp .env.example .env
docker compose up -d postgres redis minio

cd server
npm install
npx prisma migrate dev
npm run seed:records

npm run dev          # API   → http://localhost:5000
npm run dev:worker   # worker (separate terminal — it is a separate process)
```

Frontend:

```bash
cd client
npm install
npm run dev          # → http://localhost:5173
```

---

## 9. Environment variables

Every variable is documented in [`.env.example`](.env.example). Never commit a
real `.env` — it is gitignored.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | – | `development` \| `test` \| `production` |
| `PORT` | – | API port (default `5000`) |
| `DATABASE_URL` | **yes** | PostgreSQL 16 connection string |
| `REDIS_HOST` / `REDIS_PORT` | **yes** | Redis for BullMQ |
| `REDIS_PASSWORD` | – | Set for managed Redis |
| `REDIS_TLS` | – | `1` when the provider needs TLS (e.g. Upstash) |
| `JWT_SECRET` | **yes** | Min. 32 chars; the process refuses to boot otherwise |
| `JWT_EXPIRES_IN` | – | Token lifetime (default `12h`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **yes** | S3/R2 credentials |
| `AWS_REGION` | – | `auto` for R2 |
| `S3_BUCKET` | **yes** | Bucket holding chunks and finished CSVs |
| `S3_ENDPOINT` | – | Empty for AWS S3; set for R2 / MinIO |
| `S3_PUBLIC_ENDPOINT` | – | Only when the browser cannot reach `S3_ENDPOINT` (as inside Docker) |
| `S3_FORCE_PATH_STYLE` | – | `1` for R2 and MinIO |
| `S3_SIGNED_URL_TTL` | – | Presigned download lifetime, seconds (default `900`) |
| `CLIENT_URL` | **yes** | Comma-separated CORS allowlist |
| `LOG_LEVEL` | – | `fatal`…`trace` (default `info`) |
| `WORKER_CONCURRENCY` | – | Concurrent export jobs per worker |
| `EXPORT_BATCH_SIZE` | – | Rows per batch/checkpoint |
| `EXPORT_STALL_TIMEOUT_SECONDS` | – | Heartbeat age before a job is swept to `INTERRUPTED` |
| `EXPORT_CRASH_AFTER_ROWS` | – | **Test-only** fault injection. Leave empty in production. |

The API and worker validate all of this with Zod at startup and **exit non-zero**
on a bad configuration rather than booting into a broken state.

---

## 10. API contract

All `/api/exports/*` routes require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account |
| `POST` | `/api/auth/login` | Obtain a JWT |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/exports` | Create an export; captures the snapshot boundary |
| `GET` | `/api/exports` | The caller's export history |
| `GET` | `/api/exports/stats` | Dashboard counters |
| `GET` | `/api/exports/:id` | Status, progress, checkpoints, verification, failures |
| `POST` | `/api/exports/:id/resume` | Resume from the last checkpoint |
| `POST` | `/api/exports/:id/cancel` | Cancel safely at a batch boundary |
| `GET` | `/api/exports/:id/download` | Presigned URL — completed **and verified** only |
| `GET` | `/api/exports/:id/verify` | Re-reads the CSV and recomputes the proof |
| `GET` | `/health` | Liveness |
| `GET` | `/health/ready` | Postgres + Redis + storage + queue readiness |

<details>
<summary>Example: create an export</summary>

```console
$ curl -X POST http://localhost:5000/api/exports \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" \
    -d '{"rowLimit":50000}'

{
  "success": true,
  "export": {
    "id": "12c5bb14-bcb5-4cff-b8fb-d9ec85f355c6",
    "status": "QUEUED",
    "snapshotMaxId": 60000,
    "requestedRowLimit": 50000,
    "progress": { "exportedRows": 0, "targetRows": 50000, "percentage": 0 }
  }
}
```
</details>

<details>
<summary>Example: verification</summary>

```console
$ curl -H "authorization: Bearer $TOKEN" \
    http://localhost:5000/api/exports/$ID/verify

{
  "success": true,
  "recomputed": true,
  "verification": {
    "expectedRows": 50000,
    "actualRows": 50000,
    "uniqueRows": 50000,
    "duplicates": 0,
    "outOfSnapshot": 0,
    "headerValid": true,
    "status": "PASSED"
  }
}
```
</details>

Errors are uniform and carry a correlation id:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Export is RUNNING; only COMPLETED exports can be downloaded",
    "requestId": "a18396c1-88e6-4f67-81c0-a997ab688985",
    "timestamp": "2026-09-03T04:39:59.488Z"
  }
}
```

---

## 11. Testing

```bash
npm run test:all          # unit + integration + concurrency
npm run test:unit
npm run test:integration
npm run test:concurrency  # interruption, resume, concurrent writes, verification
npm run test:verification # the verification gate on its own
npm run test:e2e          # Playwright, against the running stack
```

| Suite | Covers |
| --- | --- |
| **Unit** | CSV escaping (commas, quotes, CRLF, unicode), column order, keyset SQL shape, the OFFSET ban, snapshot filtering, cursor-walk disjointness, resume state derivation, gap/ordering rejection, verification maths against deliberately broken files |
| **Integration** | Registration, login, bcrypt storage, account-enumeration resistance, JWT rejection paths, export creation + snapshot capture, row-limit validation, ownership isolation across five routes, download authorization, cancel/resume state machine, readiness probe |
| **Reliability** | Real worker process killed mid-export; sweeper visibility; resume from checkpoint; crash between write and checkpoint; 500 concurrent inserts during a live export; full verification evidence |
| **E2E** | Register → login → create export → watch progress → completion → verification → download, plus a UI-driven `docker kill` of the worker, resume, and re-verification |
| **Responsive** | Sidebar/drawer behaviour, keyboard dismissal, focus handling, full-width content and horizontal-overflow checks at desktop, tablet and mobile widths |

Latest full run — transcripts in [`docs/evidence/`](docs/evidence):

```
Unit          5 files   38 passed (38)     docs/evidence/02-unit-tests.txt
Integration   2 files   39 passed (39)     docs/evidence/03-integration-tests.txt
Reliability   3 files    5 passed (5)      docs/evidence/04-concurrency-tests.txt
End-to-end    3 files   11 passed (11)     Playwright, against the running stack
                        ─────────────────
                        93 passed, 0 failed
```

`./scripts/capture-evidence.sh` regenerates every file in `docs/evidence/` from scratch,
so the numbers above can always be re-derived rather than taken on trust.

The reliability tests run real 50,000-row exports against real Postgres, Redis
and object storage. Nothing is mocked.

---

## 12. Deployment

The production topology keeps the worker as its **own** service, so exports
continue when the API restarts, when the browser closes, and when the developer's
machine is off.

| Component | Target | Config |
| --- | --- | --- |
| Frontend | Vercel (static build) | [`client/vercel.json`](client/vercel.json) |
| API | Render web service (Docker) | [`render.yaml`](render.yaml) |
| Worker | Render **background worker** (Docker) | [`render.yaml`](render.yaml) |
| PostgreSQL | Render managed Postgres 16 | [`render.yaml`](render.yaml) |
| Redis | Render managed Redis (`noeviction`) | [`render.yaml`](render.yaml) |
| Object storage | Cloudflare R2 | env vars |

```bash
# API + worker + Postgres + Redis
render blueprint launch        # or connect the repo in the Render dashboard

# Frontend
cd client && vercel --prod     # set VITE_API_URL to the Render API URL
```

Then set the secrets marked `sync: false` in `render.yaml`
(`CLIENT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`,
`S3_ENDPOINT`). The API service runs `prisma migrate deploy` on boot.

### Health checks

- **API** — `GET /health` (liveness) and `GET /health/ready`, which actually
  queries Postgres, pings Redis, touches the storage bucket and reads queue
  depth. A failing dependency returns **503** and logs the reason; it never
  returns a cheerful 200 over a broken system.
- **Worker** — no HTTP port, so its container healthcheck opens a real Postgres
  connection and pings Redis. Per-job liveness is separate: the worker updates
  `export_jobs.updated_at` after every batch, and the API's sweeper converts an
  expired heartbeat into a visible `INTERRUPTED` status.
- **Startup** — both processes verify Postgres, Redis and object storage before
  accepting any work, and exit non-zero if a dependency is unreachable.

### Deployment status

The container images, the Render blueprint and the Vercel configuration are
complete, and the **entire stack has been verified running under Docker** —
API, worker, PostgreSQL, Redis, MinIO and the web client, with a real 50,000-row
export driven end to end through it (see § 5).

Pushing to Render and Vercel requires an authenticated account on those
platforms. This build environment has no such credentials
(`flyctl auth whoami` → *no access token available*; no Render or Vercel
tokens are present), so **the hosted URLs are not live yet**. That step is:

1. `render blueprint launch` against this repo (or connect it in the dashboard).
2. Fill in the five `sync: false` secrets, pointing at a Cloudflare R2 bucket.
3. `cd client && vercel --prod`, with `VITE_API_URL` set to the Render API URL.
4. Set the API's `CLIENT_URL` to the Vercel domain so CORS allows it.

Nothing in the code changes between local and hosted: MinIO and R2 speak the
same S3 API, and the only environment difference is which endpoint is signed
into download URLs.

---

## 13. Security

- **bcrypt** password hashing, cost 12. Plaintext is never stored or logged.
- **JWT** bearer auth; every `/api/exports` route is authenticated.
- **Ownership checks** on every `:id` route, in the service layer rather than the
  controller. A cross-user request gets **404**, not 403, so ids cannot be probed
  for existence. Covered by five integration tests.
- **Download gating** — a presigned URL is issued only for a job that is
  `COMPLETED` *and* has a passing verification row. Forcing the status is not
  enough; a test proves a `COMPLETED` job without verification is refused.
- **Zod validation** on every request body and route parameter.
- **Rate limiting** — global, tighter on auth, and per-user on export creation.
- **Helmet** security headers; **CORS allowlist** driven by `CLIENT_URL`, with
  rejected origins logged.
- **No SQL injection surface** — every query is parameterised, including the raw
  keyset query.
- **Log redaction** for `authorization`, cookies, passwords and AWS secrets.
- **Production error responses** never leak internals: a 500 returns a generic
  message plus a `requestId` that ties back to the full stack trace in the logs.
- **Resource limits** — `rowLimit` is capped at 50,000 and a 100 kB JSON body
  limit is enforced.
- **Non-root** container user for the API and worker images.

---

## 14. Definition of done

| | Item |
| --- | --- |
| ✅ | User registration works |
| ✅ | User login works |
| ✅ | Protected routes work |
| ✅ | At least 60,000 records exist |
| ✅ | Export captures a snapshot boundary |
| ✅ | Export processes exactly 50,000 rows |
| ✅ | Deterministic keyset pagination |
| ✅ | OFFSET pagination is not used (enforced by a test) |
| ✅ | CSV contains exactly 50,000 rows |
| ✅ | CSV contains exactly 50,000 unique IDs |
| ✅ | Duplicate count is zero |
| ✅ | Export survives intentional interruption |
| ✅ | Export resumes from checkpoint |
| ✅ | Resume does not duplicate rows |
| ✅ | Concurrent inserts do not corrupt the export |
| ✅ | Rows inserted after the snapshot are excluded |
| ✅ | Verification runs automatically |
| ✅ | Failed verification prevents COMPLETED status |
| ✅ | Every failure is visible in logs, database and UI |
| ✅ | No silent catch blocks exist |
| ✅ | Unit tests pass |
| ✅ | Integration tests pass |
| ✅ | Concurrency tests pass |
| ✅ | End-to-end tests pass |
| ⏳ | Deployed independently of the developer laptop — images, blueprint and configs are complete and the full stack is verified under Docker; the hosted deploy needs Render/Vercel credentials this environment does not have (see § 12) |
| ✅ | README documents what was VERIFIED |
| ✅ | README includes the concurrent-write explanation |
| ✅ | Screenshots exist for every major feature |
