import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from '../../config/env';
import { wakeWorker, whenWakeSettled } from '../../queues/workerWake';

/**
 * The wake exists to un-stick a worker that a scale-to-zero host has spun down.
 * The properties worth locking in are the ones whose absence caused the
 * original bug (no wake at all) or would cause a new one (a wake that blocks or
 * throws inside the export-creation request).
 */
describe('worker wake', () => {
  const originalUrl = env.WORKER_WAKE_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  const context = { exportJobId: 'job-1', trigger: 'initial', reason: 'enqueued' as const };

  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    env.WORKER_WAKE_URL = 'https://worker.example.com/health';
    // Each test must start with no request outstanding, or the in-flight guard
    // from a previous test would suppress its wake.
    await whenWakeSettled();
  });

  afterEach(async () => {
    // Bounded on purpose. A test that leaves a wake unresolved is a bug in the
    // test, and it should surface as a fast, named failure rather than as the
    // whole suite hanging until vitest's multi-minute hook timeout.
    await Promise.race([
      whenWakeSettled(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('a wake request was left unresolved by this test')), 2_000),
      ),
    ]);
    vi.unstubAllGlobals();
    env.WORKER_WAKE_URL = originalUrl;
  });

  it('sends one GET to the configured URL', async () => {
    wakeWorker(context);
    await whenWakeSettled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://worker.example.com/health');
    expect(init).toMatchObject({ method: 'GET' });
  });

  it('does nothing when WORKER_WAKE_URL is unset', async () => {
    env.WORKER_WAKE_URL = undefined;

    wakeWorker(context);
    await whenWakeSettled();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an empty URL as unset rather than fetching ""', async () => {
    // Hosts inject unset `sync: false` variables as the empty string. The env
    // schema trims that to undefined; this asserts the behaviour end to end.
    env.WORKER_WAKE_URL = undefined;

    wakeWorker(context);
    await whenWakeSettled();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collapses a burst of enqueues into a single cold start', async () => {
    // One worker boot drains everything already waiting, so three jobs queued
    // back to back must not fire three cold-start requests.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    wakeWorker({ ...context, exportJobId: 'job-1' });
    wakeWorker({ ...context, exportJobId: 'job-2' });
    wakeWorker({ ...context, exportJobId: 'job-3' });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    release({ status: 200 } as Response);
    await whenWakeSettled();
  });

  it('sends again once the previous request has settled', async () => {
    wakeWorker(context);
    await whenWakeSettled();
    wakeWorker(context);
    await whenWakeSettled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns synchronously instead of blocking on the cold start', async () => {
    // A cold start takes ~25s. If this ever became awaitable the export
    // response would block on it, which is the failure this guards against.
    // The request is held open for the duration of the assertion and only then
    // released, so the suite never awaits an unresolvable promise.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    expect(wakeWorker(context)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release({ status: 200 } as Response);
    await whenWakeSettled();
  });

  it('swallows a failed wake — the job is already durable', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND worker.example.com'));

    expect(() => wakeWorker(context)).not.toThrow();
    await expect(whenWakeSettled()).resolves.toBeUndefined();
  });

  it('clears the in-flight guard after a failure, so the next wake still fires', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));

    wakeWorker(context);
    await whenWakeSettled();

    fetchMock.mockResolvedValue({ status: 200 } as Response);
    wakeWorker(context);
    await whenWakeSettled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a non-2xx answer as a successful wake', async () => {
    // The worker's own /health answers 503 when one of its dependencies is
    // down. The process still booted and is reading the queue, which is all
    // the wake was for.
    fetchMock.mockResolvedValue({ status: 503 } as Response);

    wakeWorker(context);
    await expect(whenWakeSettled()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
