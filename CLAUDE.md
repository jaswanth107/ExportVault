# CLAUDE.md — ExportVault engineering log

Working notes for anyone (human or agent) picking this repository up. Records
what was decided, what broke, how it was fixed, and what was actually verified.

---

## 1. Architecture decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Pagination | Keyset (`id > cursor AND id <= snapshot_max_id`) | OFFSET reorders rows under concurrent INSERT/DELETE, silently duplicating and skipping. A unit test greps the whole source tree and fails the build if `OFFSET <value>` or Prisma `skip:` ever appears. |
| Export boundary | `snapshot_max_id = MAX(id)` captured at job-creation time, in the API request | Gives the export an immutable upper bound. Rows inserted later get higher ids and are excluded by construction, so no locking or long transaction is needed. |
| Resume log | `export_checkpoints`, one row per successfully written batch, `UNIQUE(export_job_id, batch_number)` | The checkpoint log is the single source of truth for progress. `export_jobs.last_exported_id` is a denormalised copy; when they disagree the checkpoints win. |
| Partial output | One immutable object per batch (`exports/<job>/chunks/00000001.csv`), assembled into the final CSV at the end | Deterministic keys make a re-written batch idempotent. A crash between "bytes written" and "checkpoint committed" simply re-writes byte-identical content to the same key on resume. |
| Write ordering | fetch → write bytes → **confirm size via HEAD** → checkpoint + progress in one transaction | `last_exported_id` can never move ahead of bytes that actually exist. "No exception was thrown" is never treated as proof a write landed. |
| Verification | Written with a hand-rolled CSV writer, verified with `csv-parse` | Deliberately two different implementations. If writer and verifier shared code, a bug would cancel itself out and verification would prove nothing. |
| Crash detection | API-hosted sweeper flips `RUNNING` jobs with a stale `updated_at` heartbeat to `INTERRUPTED` | The API outlives individual workers. A killed worker becomes *visible* in the UI within the stall timeout instead of leaving a job stuck at RUNNING forever. |
| Worker isolation | Separate process (`dist/worker.js`), separate container / Render service | Exports must not depend on the API's request lifecycle or on a browser being open. |
| Prisma version | 7.10.0 (latest **stable**; 8.x is still RC) | Prisma 7 moved the datasource URL out of `schema.prisma`; the repo uses `prisma.config.ts` plus the `@prisma/adapter-pg` driver adapter. |
| Password hashing | `bcryptjs`, cost 12 | Same bcrypt algorithm as the native module, without needing build toolchains in the slim Docker image. |
| App shell | Full-width layout, one `<aside>` sidebar: static from `lg`, off-canvas drawer below | A single element at every breakpoint keeps one copy of each link in the accessibility tree. Separate mobile/desktop navs would duplicate every link and make selectors and screen-reader output ambiguous. |

### Data flow

```
POST /api/exports  →  capture MAX(id)  →  persist job (PENDING→QUEUED)  →  BullMQ
                                                                            ↓
worker: claim job → read checkpoints → loop {
    keyset SELECT → serialise → PUT chunk → HEAD confirm → TX{checkpoint, progress}
} → assemble chunks → verify CSV → COMPLETED (only if verification passed)
```

---

## 2. Commands actually executed

```bash
# infrastructure
docker compose up -d postgres redis minio
docker compose up -d --build              # whole stack incl. api, worker, client

# database
cd server && npx prisma migrate dev --name init
npm run seed:records                      # 60,000 rows, verified after insert

# tests
npm run test:unit                         # 38 tests
npm run test:integration                  # 39 tests
npm run test:concurrency                  # 5 reliability tests
npx playwright test                       # end-to-end through the real UI
```

---

## 3. Problems encountered and fixes applied

| # | Problem | Fix |
| --- | --- | --- |
| 1 | `npm install` skipped lifecycle scripts (npm 11 default), so Prisma engines and esbuild were never installed. | `npm approve-scripts @prisma/engines @prisma/client prisma esbuild msgpackr-extract`, which pins an `allowScripts` block in `package.json` that the Docker build reuses. |
| 2 | Prisma 7 rejects `url = env("DATABASE_URL")` inside `schema.prisma`. | Added `prisma.config.ts` and the `@prisma/adapter-pg` driver adapter; the runtime client is constructed with `new PrismaClient({ adapter })`. |
| 3 | The OFFSET guard test failed on `generateTestData.ts` — a loop variable was literally named `offset`. | Renamed the variable to `startIndex` and tightened the guard to match SQL `OFFSET <value>` and Prisma `skip:` only, after stripping comments. The guard was right to fire; the ambiguity was real. |
| 4 | Docker build failed: `prisma.config.ts` threw when `DATABASE_URL` was unset, but `prisma generate` needs no database. | The `datasource` block is now only declared when the variable is present. `generate` works offline; `migrate` still reports a missing URL itself. |
| 5 | Second interruption test hung: the healthy worker spawned by the previous test was still alive and won the queue race, so the crashing worker never received the job. | Workers are now stopped in `afterEach` rather than `afterAll`, so each test starts from a clean slate. |
| 6 | `MaxListenersExceededWarning` while assembling 50 chunks into one stream. | Replaced per-chunk `pipeline(src, dst, {end:false})` with an explicit backpressure-aware pump (`for await … write / once('drain')`). |
| 7 | The `client` container crashed: `vite preview` tries to write a temp file into `node_modules`, which is root-owned. | Client image now builds to static assets and serves them with nginx (SPA fallback), matching how Vercel serves the same bundle. |
| 8 | The worker container inherited the API image's HTTP healthcheck and could never pass it — it serves no HTTP port. | Compose overrides the worker healthcheck with a real Postgres + Redis connectivity probe. |
| 9 | Presigned download URLs were signed against the internal `minio:9000` hostname, so no browser could fetch them. Both the independent audit and the E2E download step failed identically. | Added `S3_PUBLIC_ENDPOINT` and a second S3 client used only for signing. Collapses to a no-op on R2/S3 where the API and the browser share a host. |
| 10 | Responsive drawer assertions read the sidebar position immediately after the click, catching it mid-transition. | The panel slides over 200ms, so its position is polled; `aria-expanded` is asserted immediately since state flips synchronously. |
| 11 | The responsive suite registered a user per test and tripped the 20/min auth rate limiter. | The limiter was right. The spec now creates one account over the API in `beforeAll` and seeds the token into `localStorage`, so it makes two auth calls in total. |

---

## 4. Verification results

See `README.md` § *What Was VERIFIED* for the full evidence with command output.
Headline numbers, all produced by executed commands and not by assertion:

```
DATABASE RECORDS AVAILABLE : 60000
EXPORT TARGET              : 50000
CSV ACTUAL ROWS            : 50000
CSV UNIQUE IDs             : 50000
CSV DUPLICATES             : 0
CONCURRENT INSERT TEST     : PASSED (400/500 rows inserted while status=RUNNING, 0 leaked)
INTERRUPTION TEST          : PASSED (hard crash at 10000 rows)
RESUME TEST                : PASSED (resumed to 50000/50000/0)
VERIFICATION STATUS        : PASSED
```

---

## 5. Deployment

| Component | Target | Config |
| --- | --- | --- |
| Frontend | Vercel (static) | `client/vercel.json` |
| API | Render web service (Docker) | `render.yaml` |
| Worker | Render **background worker** (Docker), separate service | `render.yaml` |
| PostgreSQL | Render managed Postgres 16 | `render.yaml` `databases:` |
| Redis | Render managed Redis, `maxmemoryPolicy: noeviction` | `render.yaml` |
| Object storage | Cloudflare R2 (S3 API) | env vars, `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=1` |

Local development substitutes MinIO for R2 — the same S3 API, so no code path
differs between environments.

**Status:** the blueprint and all container images are complete and the entire
stack has been verified running under Docker. Pushing it to Render/Vercel
requires the account credentials for those platforms, which this environment
does not hold — see README § *Deployment status* for the exact remaining steps.

---

## 6. Conventions

- Every `catch` block logs or rethrows. There are no empty catches and no
  `catch { return null }`. A repository-wide grep for this is part of the test
  suite documentation in the README.
- Every important operation verifies its expected result (row counts after
  seeding, object size after upload, CSV contents after assembly).
- `COMPLETED` is written only after a verification row with `passed = true`
  exists. Download is refused otherwise, even if the status were forced.
