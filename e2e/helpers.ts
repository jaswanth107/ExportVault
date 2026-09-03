import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { Page } from '@playwright/test';

export const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');

export function ensureScreenshotDir(): void {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

/** Saves a full-page screenshot into docs/screenshots. */
export async function shot(page: Page, name: string): Promise<void> {
  ensureScreenshotDir();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

export function uniqueUser(prefix: string) {
  const stamp = Date.now().toString(36);
  return {
    name: 'Export Operator',
    email: `${prefix}-${stamp}@example.com`,
    password: 'StrongPassword123!',
  };
}

/** Runs a docker command against the local stack (used to kill the worker). */
export function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:5000';

/**
 * Creates one account over the API and returns its token.
 *
 * Specs that need many browser sessions should call this ONCE and seed the
 * token with `seedSession`, rather than registering per test — the auth rate
 * limiter (20/min) is deliberately tight and driving it through the UI eight
 * times in a row trips it, which is the limiter working, not a bug.
 */
export async function createAccountViaApi(prefix: string): Promise<{ email: string; token: string }> {
  const user = uniqueUser(prefix);

  const registerRes = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (!registerRes.ok) {
    throw new Error(`Could not create the test account: HTTP ${registerRes.status} ${await registerRes.text()}`);
  }

  const loginRes = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!loginRes.ok) {
    throw new Error(`Could not log the test account in: HTTP ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token } = (await loginRes.json()) as { token: string };
  return { email: user.email, token };
}

/** Injects an existing session token so the page loads already authenticated. */
export async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('exportvault.token', value);
  }, token);
}

export async function registerAndLogin(
  page: Page,
  user: { name: string; email: string; password: string },
): Promise<void> {
  await page.goto('/register');
  await page.fill('#name', user.name);
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
}
