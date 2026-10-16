import { expect, test, type Page } from '@playwright/test';
import { openPortfolioMenu } from './nav';

// Mock mode (pnpm dev:mock): the banner is the demo banner with no VITE_REAL_APP_URL, so it opens the dialog.
const banner = (page: Page) => page.getByRole('complementary', { name: 'Demo mode' });
const header = (page: Page) => page.getByRole('banner');
const switchControl = (page: Page) => banner(page).getByRole('button', { name: 'Switch to real data' });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

/** True when the element's centre is painted by the main nav (not covered by the banner or the page). */
async function isTopmostNav(page: Page, el: ReturnType<Page['locator']>) {
  const b = await box(el);
  return page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('nav') != null, [b.x + b.width / 2, b.y + b.height / 2]);
}

async function box(locator: ReturnType<Page['locator']>) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The page must really be taller than the viewport, or "stays on top after scrolling" proves nothing. */
async function scrollFar(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => scrollY(page)).toBeGreaterThan(300);
}

const SM = 640; // Tailwind `sm`: from here up the header is pinned under the banner, below it only the banner is

async function expectBannerAtTop(page: Page) {
  const b = await box(banner(page));
  expect(b.y).toBeGreaterThanOrEqual(-1);
  expect(b.y).toBeLessThanOrEqual(4);
  await expect(banner(page)).toBeInViewport();
  await expect(switchControl(page)).toBeInViewport();
}

async function expectPinnedToTop(page: Page) {
  await expectBannerAtTop(page);
  const b = await box(banner(page));
  const h = await box(header(page));
  expect(h.y).toBeGreaterThanOrEqual(b.y + b.height - 2); // the header sits directly below the banner
  expect(h.y).toBeLessThanOrEqual(b.y + b.height + 4);
  expect(h.y + h.height).toBeLessThan(page.viewportSize()!.height);
  await expect(header(page)).toBeInViewport();
}

/** Below sm only the banner is pinned: the header has scrolled out of the viewport. */
async function expectOnlyBannerPinned(page: Page) {
  await expectBannerAtTop(page);
  await expect(header(page)).not.toBeInViewport();
  const h = await box(header(page));
  expect(h.y + h.height).toBeLessThanOrEqual(2);
}

test.describe('demo banner', () => {
  test('at 1440 the banner and the header are on top together at load', async ({ page }) => {
    await page.goto('/dividends');
    await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
    await expect(banner(page)).toContainText('Demo mode');
    await expect(switchControl(page)).toBeVisible();
    await expectPinnedToTop(page);
  });

  for (const width of [1440, 1024, 640]) {
    test(`from sm up, banner AND header stay pinned while scrolling, no horizontal overflow, dropdowns layer on top (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dividends');
      await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await scrollFar(page);
      await expectPinnedToTop(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await openPortfolioMenu(page);
      const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Holdings', exact: true });
      await expect(link).toBeInViewport();
      expect(await isTopmostNav(page, link)).toBe(true);
    });
  }

  for (const width of [390, 320]) {
    test(`below sm only the compact banner is pinned; the header scrolls away, no horizontal overflow (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dividends');
      await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
      expect(width).toBeLessThan(SM);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const b = await box(banner(page));
      expect(b.height).toBeLessThan(110); // compact: text and button share a row (no exact pixels: CI fonts are wider)
      await expect(header(page)).toBeInViewport();
      await scrollFar(page);
      await expectOnlyBannerPinned(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('on a phone the open Portfolio menu is not clipped or covered by the banner, also after scrolling a little', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/dividends');
    await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
    await openPortfolioMenu(page);
    const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Holdings', exact: true });
    await expect(link).toBeInViewport();
    expect(await isTopmostNav(page, link)).toBe(true);
    await page.evaluate(() => window.scrollBy(0, 40));
    const bar = await box(banner(page));
    const l = await box(link);
    expect(l.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(await isTopmostNav(page, link)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('the control is a 44px tall touch target on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/dividends');
    const b = await box(switchControl(page));
    expect(b.height).toBeGreaterThanOrEqual(44);
    const text = await box(banner(page).getByText('Demo mode — sample data'));
    expect(b.y).toBeLessThan(text.y + text.height); // same row as the text (the text wraps beside it)
  });

  for (const width of [390, 1440]) {
    // What is pinned: the banner below sm, the banner plus the header from sm up.
    const pinnedBottom = async (page: Page) => {
      const unit = await box(width < SM ? banner(page) : header(page));
      return unit.y + unit.height;
    };

    test(`a focused control deep in the page is not hidden under what is pinned (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/dividends');
      await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
      const target = page.locator('main').getByRole('button').first();
      await expect(target).toBeVisible();
      await page.waitForLoadState('networkidle');
      // Late-loading cards can grow the page after the first scroll, so redo scroll + focus until it settles.
      await expect
        .poll(async () => {
          await scrollFar(page);
          await target.evaluate((el) => (el as HTMLElement).blur());
          await target.focus();
          return (await box(target)).y - (await pinnedBottom(page));
        })
        .toBeGreaterThanOrEqual(-1);
      await expect(target).toBeFocused();
    });

    test(`the #main anchor lands below what is pinned (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/dividends');
      await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
      await scrollFar(page);
      await page.evaluate(() => {
        location.hash = '#main';
      });
      const bottom = await pinnedBottom(page);
      await expect.poll(async () => (await box(page.locator('main'))).y).toBeGreaterThanOrEqual(bottom - 1);
    });
  }

  test('opens the dialog with the steps and returns focus on Escape', async ({ page }) => {
    await page.goto('/');
    await switchControl(page).click();
    const dialog = page.getByRole('dialog', { name: 'Switch to real data' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await expect(dialog).toContainText('Your Trading 212 key never goes through this demo site.');
    await expect(dialog.getByRole('link', { name: 'deployment guide' })).toHaveAttribute('href', /infra\/terraform\/README\.md$/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(switchControl(page)).toBeFocused();
  });

  test('the dialog fits a 320px phone without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await switchControl(page).click();
    await expect(page.getByRole('dialog', { name: 'Switch to real data' })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const d = await box(page.getByRole('dialog'));
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width).toBeLessThanOrEqual(320);
  });
});
