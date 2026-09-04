import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';

/**
 * How long a wake request may hang before its socket is released.
 *
 * A cold start on a scale-to-zero host takes roughly 20-25 seconds, so this is
 * deliberately longer than that. It is not a deadline for the worker to become
 * useful — nothing waits on this request — only a bound that stops sockets
 * accumulating if the URL is wrong or the host never answers at all.
 */
const WAKE_TIMEOUT_MS = 30_000;

/**
 * The wake request currently in flight, or null. Module-level on purpose: one
 * boot serves every job already in the queue.
 */
let inFlight: Promise<void> | null = null;

export interface WakeContext {
  exportJobId: string;
  trigger: string;
  /** Why the wake was sent; distinguishes a fresh enqueue from a stale-lock nudge. */
  reason: 'enqueued' | 'already-active';
}

/**
 * Nudges the worker service so that something is running to consume what was
 * just queued.
 *
 * **Why this exists.** Render (and every host with no free background-worker
 * tier) runs the worker as a web service that spins down after ~15 minutes
 * idle. The API stays warm because the browser talks to it constantly; the
 * worker has its own URL that nothing ever visits. So the worker spins down
 * once and never comes back, and every export after that sits at
 * `QUEUED / 0 rows` indefinitely — the queue keeps accepting jobs and no
 * consumer exists. One HTTP GET is all it takes to start the process.
 *
 * **Why it is fire-and-forget.** The caller must not await a cold start: the
 * export-creation response would block for ~25 seconds and time out at the
 * proxy long before the worker was ready. This returns `void` rather than a
 * promise specifically so it cannot be awaited by accident.
 *
 * **Why failure is swallowed.** By the time this runs the job is already
 * durable in Postgres and in Redis. A failed wake costs latency — the job waits
 * for the next export's wake, or for a manual Resume — never correctness.
 * Throwing here would fail a request whose work had already been committed.
 *
 * With `WORKER_WAKE_URL` unset this is a no-op, which is the correct behaviour
 * both for local development and for a real always-on background worker.
 */
export function wakeWorker(context: WakeContext): void {
  const url = env.WORKER_WAKE_URL;
  if (!url) return;

  // A burst of enqueues must not trigger a burst of cold starts. Joining the
  // in-flight request is not merely an optimisation: one worker boot drains
  // everything already waiting, so a second request would buy nothing.
  if (inFlight) {
    logger.debug({ ...context, url }, 'Worker wake already in flight; not sending another');
    return;
  }

  const startedAt = Date.now();

  inFlight = (async () => {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        headers: { 'user-agent': 'exportvault-api/worker-wake' },
      });

      // Any answer proves the process is up, so a non-2xx is not a failure of
      // the wake. The worker's own /health returns 503 when one of *its*
      // dependencies is down — which still means it booted and is reading the
      // queue, which is the only thing this request was trying to achieve.
      logger.info(
        {
          event: LogEvent.WORKER_WAKE_SENT,
          ...context,
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
        'Worker wake answered',
      );
    } catch (error) {
      logger.warn(
        {
          event: LogEvent.WORKER_WAKE_FAILED,
          ...context,
          url,
          durationMs: Date.now() - startedAt,
          err: error,
        },
        'Worker wake failed; the job stays queued until a worker picks it up',
      );
    } finally {
      inFlight = null;
    }
  })();
}

/**
 * Resolves once no wake request is outstanding.
 *
 * A test-only seam. Production code must never wait on a cold start, which is
 * why `wakeWorker` itself hands back nothing to await.
 */
export async function whenWakeSettled(): Promise<void> {
  await inFlight;
}
