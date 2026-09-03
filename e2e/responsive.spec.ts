/**
 * Responsive shell: the navigation must be reachable from every route at every
 * screen size, and no page may scroll horizontally.
 *
 * The sidebar is a single DOM element that slides off-canvas below `lg`, so
 * "hidden" is asserted by its position rather than by CSS visibility — a
 * translated element is still technically visible to the browser.
 */
import { test, expect, type Page } from '@playwright/test';
import { createAccountViaApi, seedSession, shot } from './helpers';

// One account for the whole file; each test seeds its own browser context with
// the same token instead of re-registering through the UI.
let token: string;

test.beforeAll(async () => {
  ({ token } = await createAccountViaApi('resp'));
});

test.beforeEach(async ({ page }) => {
  await seedSession(page, token);
});

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };
const MOBILE = { width: 390, height: 844 };

const ROUTES = ['/dashboard', '/exports', '/exports/new'];

async function sidebarOffsetX(page: Page): Promise<number> {
  const box = await page.locator('#primary-navigation').boundingBox();
  if (!box) throw new Error('Sidebar element was not found in the DOM');
  return box.x;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.describe('responsive navigation shell', () => {
  test('desktop: sidebar is permanently visible on every route', async ({ page }) => {
    await page.setViewportSize(DESKTOP);

    for (const route of ROUTES) {
      await page.goto(route);
      // Statically laid out, flush against the left edge.
      expect(await sidebarOffsetX(page), `sidebar off-screen on ${route}`).toBe(0);
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
      // No hamburger needed when the sidebar is always there.
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
      expect(await hasHorizontalOverflow(page), `horizontal overflow on ${route}`).toBe(false);
    }

    await page.goto('/dashboard');
    await shot(page, '12-layout-desktop');
  });

  test('desktop: content uses the full window width', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/dashboard');

    const main = await page.locator('#main-content').boundingBox();
    const sidebar = await page.locator('#primary-navigation').boundingBox();
    if (!main || !sidebar) throw new Error('Layout elements missing');

    // Main fills everything the sidebar does not, rather than a centred column.
    expect(Math.round(main.x)).toBe(Math.round(sidebar.width));
    expect(Math.round(main.x + main.width)).toBe(DESKTOP.width);
  });

  for (const [label, viewport] of [
    ['tablet', TABLET],
    ['mobile', MOBILE],
  ] as const) {
    test(`${label}: nav is off-canvas but reachable from every route`, async ({ page }) => {
      await page.setViewportSize(viewport);

      for (const route of ROUTES) {
        await page.goto(route);

        // Closed: parked off the left edge.
        expect(await sidebarOffsetX(page), `sidebar not off-canvas on ${route}`).toBeLessThan(0);

        const toggle = page.getByRole('button', { name: 'Open navigation' });
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toHaveAttribute('aria-controls', 'primary-navigation');

        await toggle.click();
        // aria state flips immediately; the panel itself slides in over 200ms,
        // so its position has to be polled rather than sampled once.
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect
          .poll(() => sidebarOffsetX(page), { message: `drawer did not open on ${route}` })
          .toBe(0);

        // Escape closes it again, for keyboard users.
        await page.keyboard.press('Escape');
        await expect.poll(() => sidebarOffsetX(page)).toBeLessThan(0);

        expect(await hasHorizontalOverflow(page), `horizontal overflow on ${route}`).toBe(false);
      }
    });

    test(`${label}: can navigate between pages through the drawer`, async ({ page }) => {
      await page.setViewportSize(viewport);

      await page.goto('/dashboard');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect.poll(() => sidebarOffsetX(page)).toBe(0);
      await page.getByRole('link', { name: 'Export History', exact: true }).click();
      await page.waitForURL('**/exports');

      // Navigating dismisses the drawer instead of covering the new page.
      await expect.poll(() => sidebarOffsetX(page)).toBeLessThan(0);

      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect.poll(() => sidebarOffsetX(page)).toBe(0);
      await page.getByRole('link', { name: 'New Export', exact: true }).click();
      await page.waitForURL('**/exports/new');
      await expect(page.getByRole('button', { name: 'Start Export' })).toBeVisible();
    });
  }

  test('mobile: drawer and detail page render correctly', async ({ page }) => {
    await page.setViewportSize(MOBILE);

    await page.goto('/exports/new');
    await page.getByRole('button', { name: 'Start Export' }).click();
    await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByTestId('status-badge').first()).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await shot(page, '14-layout-mobile');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect.poll(() => sidebarOffsetX(page)).toBe(0);
    await shot(page, '15-mobile-nav-drawer');
  });

  test('tablet: history table stays inside the viewport', async ({ page }) => {
    await page.setViewportSize(TABLET);

    await page.goto('/exports/new');
    await page.getByRole('button', { name: 'Start Export' }).click();
    await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await page.goto('/exports');
    // The account is shared across this file, so assert the table has rows to
    // lay out rather than an exact count — this test is about viewport fit.
    await expect(page.getByTestId('export-row').first()).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await shot(page, '13-layout-tablet');
  });
});
