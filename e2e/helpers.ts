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
