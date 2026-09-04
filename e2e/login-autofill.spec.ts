import { test, expect } from '@playwright/test';
import { createAccountViaApi, uniqueUser } from './helpers';

/**
 * The sign-in password box must be empty when the page opens.
 *
 * Nothing in the app ever stored the password — only the JWT reaches
 * localStorage — so a filled box is the browser's password manager writing
 * into the field on load. The field is held read-only across that window,
 * because Chrome skips read-only inputs and ignores autocomplete="off" on
 * password fields.
 *
 * What automation *can* prove is asserted here: the box is empty on arrival,
 * the guard is present while the fill would land, it lifts on its own, and
 * signing in still works. Chrome's saved-password fill itself cannot be
 * reproduced in a fresh automation profile, which has no saved credentials.
 */
test.describe('sign-in password field', () => {
  test('is empty when the page opens', async ({ page }) => {
    await page.goto('/login');

    const password = page.locator('#password');
    await expect(password).toHaveValue('');
    // Still empty once the page has fully settled — a late fill would show here.
    await page.waitForTimeout(1_500);
    await expect(password).toHaveValue('');
  });

  test('holds the read-only guard while the fill window is open, then releases it', async ({ page }) => {
    await page.goto('/login');
    const password = page.locator('#password');

    // The property that makes Chrome's password manager skip the field.
    await expect(password).toHaveJSProperty('readOnly', true);

    // The guard is scoped to the load window. If it stayed on it would also
    // block third-party password managers, which set the value without ever
    // focusing the input.
    await expect(password).toHaveJSProperty('readOnly', false, { timeout: 5_000 });
  });

  test('releases the guard immediately when the user clicks into it', async ({ page }) => {
    await page.goto('/login');
    const password = page.locator('#password');

    await password.click();
    await expect(password).toHaveJSProperty('readOnly', false);

    await password.pressSequentially('typed-by-hand');
    await expect(password).toHaveValue('typed-by-hand');
  });

  test('leaves the email field alone', async ({ page }) => {
    // Only the password was asked for. The email box keeps normal autofill so
    // the browser can still identify the returning user.
    await page.goto('/login');
    await expect(page.locator('#email')).toHaveJSProperty('readOnly', false);
  });

  test('signing in still works', async ({ page }) => {
    // The regression that would matter most: a guard that failed to lift would
    // make the form impossible to complete.
    const user = uniqueUser('autofill');
    const registerRes = await fetch(`${process.env.E2E_API_URL ?? 'http://localhost:5000'}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(user),
    });
    expect(registerRes.ok).toBe(true);

    await page.goto('/login');
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    await expect(page.locator('#password')).toHaveCount(0);
  });

  test('page.fill still reaches the field, so the guard has not broken automation', async ({ page }) => {
    await createAccountViaApi('autofill-fill');
    await page.goto('/login');

    // fill() refuses to write to a read-only input. That this succeeds is the
    // proof the guard is temporary rather than permanent.
    await page.fill('#password', 'written-programmatically');
    await expect(page.locator('#password')).toHaveValue('written-programmatically');
  });
});
