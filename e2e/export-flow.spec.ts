/**
 * End-to-end happy path against the REAL stack:
 * register → login → start export → monitor progress → completion →
 * verification → download.
 *
 * Nothing here is stubbed: the export is a genuine 50,000-row export produced
 * by the worker container, and the download is fetched from object storage.
 */
import { test, expect } from '@playwright/test';
import { registerAndLogin, shot, uniqueUser } from './helpers';

test.describe.configure({ mode: 'serial' });

test('registers, exports 50,000 rows, verifies and downloads', async ({ page }) => {
  const user = uniqueUser('e2e');

  // ---- 1. Login screen -----------------------------------------------------
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await shot(page, '01-login');

  // ---- 2. Registration -----------------------------------------------------
  await page.goto('/register');
  await page.fill('#name', user.name);
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await expect(page.getByText('At least 10 characters')).toBeVisible();
  await shot(page, '02-register');
  await page.click('button[type="submit"]');

  // ---- 3. Dashboard, empty state ------------------------------------------
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByText('No exports yet.')).toBeVisible();
  await shot(page, '03-dashboard-empty');

  // ---- 4. Create export ----------------------------------------------------
  await page.getByRole('link', { name: 'New Export', exact: true }).click();
  await page.waitForURL('**/exports/new');
  await expect(
    page.getByText(
      'Records inserted after the export snapshot begins will not appear in this export.',
    ),
  ).toBeVisible();
  await shot(page, '04-create-export');

  await page.getByRole('button', { name: 'Start Export' }).click();
  await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const exportId = page.url().split('/').pop()!;
  expect(exportId).toMatch(/^[0-9a-f-]{36}$/);

  // ---- 5. Monitor progress -------------------------------------------------
  const badge = page.getByTestId('status-badge').first();
  await expect(badge).toHaveAttribute('data-status', /QUEUED|RUNNING|VERIFYING|COMPLETED/);

  // Catch it mid-flight for the screenshot; tolerate a very fast machine.
  try {
    await expect(badge).toHaveAttribute('data-status', /RUNNING|VERIFYING/, { timeout: 20_000 });
    await shot(page, '05-export-running');
  } catch {
    // If it finished before we looked, the completion assertions below still
    // prove the export worked — we just miss the in-flight screenshot.
    console.warn('Export completed too quickly to capture a RUNNING screenshot');
  }

  // ---- 6. Completion -------------------------------------------------------
  await expect(badge).toHaveAttribute('data-status', 'COMPLETED', { timeout: 150_000 });

  await expect(page.getByText('50,000 / 50,000 rows')).toBeVisible();
  await expect(page.getByTestId('progress-percentage')).toHaveText('100%');

  // ---- 7. Verification card ------------------------------------------------
  const verification = page.getByTestId('verification-status');
  await expect(verification).toHaveAttribute('data-status', 'PASSED');

  const card = page.locator('div').filter({ hasText: /^Verification/ }).first();
  await expect(card).toBeVisible();
  await shot(page, '08-verification-passed');

  // Assert the numbers on screen are the real ones, not decoration.
  await expect(page.getByText('Expected Rows').locator('..')).toContainText('50,000');
  await expect(page.getByText('Actual Rows').locator('..')).toContainText('50,000');
  await expect(page.getByText('Unique IDs').locator('..')).toContainText('50,000');
  await expect(page.getByText('Duplicates').locator('..')).toContainText('0');

  // ---- 8. Download ---------------------------------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('.csv');
  await shot(page, '10-downloaded-csv-evidence');

  // ---- 9. History ----------------------------------------------------------
  await page.getByRole('link', { name: 'Export History', exact: true }).click();
  await page.waitForURL('**/exports');
  await expect(page.getByTestId('export-row')).toHaveCount(1);
  await expect(page.getByText('✓ PASSED')).toBeVisible();
  await shot(page, '09-export-history');

  // ---- 10. Dashboard with data --------------------------------------------
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByText('Total export jobs')).toBeVisible();
  await shot(page, '03-dashboard');
});

test('blocks another user from opening someone else\'s export', async ({ page, context }) => {
  const owner = uniqueUser('owner');
  await registerAndLogin(page, owner);

  await page.goto('/exports/new');
  await page.getByRole('button', { name: 'Start Export' }).click();
  await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/);
  const exportId = page.url().split('/').pop()!;

  // A completely separate browser session for a different account.
  const intruderPage = await context.browser()!.newPage();
  const intruder = uniqueUser('intruder');
  await intruderPage.goto('/register');
  await registerAndLogin(intruderPage, intruder);

  await intruderPage.goto(`/exports/${exportId}`);
  await expect(intruderPage.getByTestId('error-state')).toBeVisible();
  await expect(intruderPage.getByText('Export job not found')).toBeVisible();
  await intruderPage.close();
});
