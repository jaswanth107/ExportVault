/**
 * End-to-end interruption and resume, driven entirely through the UI.
 *
 * The worker container is genuinely SIGKILLed mid-export (`docker kill`) — no
 * graceful shutdown, no mocked failure. The test then proves the UI surfaces
 * the interruption, that resuming continues from the checkpoint rather than
 * restarting, and that the final CSV still verifies at exactly 50,000 unique
 * rows with zero duplicates.
 */
import { test, expect } from '@playwright/test';
import { docker, registerAndLogin, shot, uniqueUser } from './helpers';

const WORKER_CONTAINER = 'exportvault-worker';

test('interrupts a running export, resumes it, and still verifies 50,000 unique rows', async ({
  page,
}) => {
  test.setTimeout(300_000);

  await registerAndLogin(page, uniqueUser('interrupt'));

  // ---- Start an export -----------------------------------------------------
  await page.goto('/exports/new');
  await page.getByRole('button', { name: 'Start Export' }).click();
  await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  const badge = page.getByTestId('status-badge').first();
  const rows = page.getByTestId('progress-rows');

  await expect(badge).toHaveAttribute('data-status', /RUNNING|VERIFYING/, { timeout: 60_000 });

  // Let it make real progress before pulling the plug.
  await expect
    .poll(
      async () => {
        const text = (await rows.textContent()) ?? '0';
        return Number(text.split('/')[0]!.replace(/[^0-9]/g, ''));
      },
      { timeout: 60_000, intervals: [250] },
    )
    .toBeGreaterThan(1_000);

  const progressText = (await rows.textContent()) ?? '';
  const rowsBeforeKill = Number(progressText.split('/')[0]!.replace(/[^0-9]/g, ''));
  await shot(page, '05-export-running');

  // ---- Kill the worker outright -------------------------------------------
  docker(['kill', WORKER_CONTAINER]);

  // The API's stalled-export sweeper notices the missing heartbeat and makes
  // the failure visible instead of leaving the job silently stuck.
  await expect(badge).toHaveAttribute('data-status', 'INTERRUPTED', { timeout: 120_000 });
  await expect(page.getByTestId('error-state').first()).toContainText(
    /Worker stopped responding/i,
  );
  await expect(page.getByText('WORKER_STALLED')).toBeVisible();
  await shot(page, '06-export-interrupted');

  // Progress must be preserved, not reset.
  const interruptedText = (await rows.textContent()) ?? '';
  const rowsAtInterrupt = Number(interruptedText.split('/')[0]!.replace(/[^0-9]/g, ''));
  expect(rowsAtInterrupt).toBeGreaterThanOrEqual(rowsBeforeKill);
  expect(rowsAtInterrupt).toBeLessThan(50_000);

  // ---- Bring the worker back and resume -----------------------------------
  docker(['start', WORKER_CONTAINER]);

  await page.getByTestId('resume-button').click();
  await expect(badge).toHaveAttribute('data-status', /RESUMING|RUNNING|VERIFYING|COMPLETED/, {
    timeout: 60_000,
  });
  await shot(page, '07-export-resumed');

  // A resume continues from the checkpoint: progress never drops back to zero.
  const afterResume = (await rows.textContent()) ?? '';
  expect(Number(afterResume.split('/')[0]!.replace(/[^0-9]/g, ''))).toBeGreaterThanOrEqual(
    rowsAtInterrupt,
  );

  // ---- Completion and proof -----------------------------------------------
  await expect(badge).toHaveAttribute('data-status', 'COMPLETED', { timeout: 180_000 });
  await expect(page.getByText('50,000 / 50,000 rows')).toBeVisible();

  await expect(page.getByTestId('verification-status')).toHaveAttribute('data-status', 'PASSED');
  await expect(page.getByText('Actual Rows').locator('..')).toContainText('50,000');
  await expect(page.getByText('Unique IDs').locator('..')).toContainText('50,000');
  await expect(page.getByText('Duplicates').locator('..')).toContainText('0');

  await shot(page, '11-resumed-export-verified');
});
