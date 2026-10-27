import { expect, test, type Page } from '@playwright/test';

const KEY = 'portfolio-tracker.layout.watchlist.desktop';

const cardOrder = (page: Page) => page.locator('[data-card-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-id')));
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

test.describe('Modular page layout (mock mode, layouts kept in this browser)', () => {
  test('customize, move a card, reload: the order persists; reset brings the default back', async ({ page }) => {
    await page.goto('/watchlist');
    await expect(page.getByRole('heading', { level: 1, name: 'Watchlist' })).toBeVisible();
    expect(await cardOrder(page)).toEqual(['watchlist-add', 'watchlist-table']);
    expect(await stored(page)).toBeNull();

    // The switch lives in the page header and shows nothing but itself until it is pressed.
    const toggle = page.getByRole('button', { name: 'Customize layout' });
    await expect(toggle).toBeVisible();
    await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(0);

    await toggle.click();
    await page.getByRole('button', { name: 'Move Add to watchlist down' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-table', 'watchlist-add']);
    // Saved a moment after the last edit.
    await expect.poll(() => stored(page)).toContain('"order":["watchlist-table","watchlist-add"]');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Watchlist' })).toBeVisible();
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-table', 'watchlist-add']);

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-add', 'watchlist-table']);
    await expect.poll(() => stored(page)).toBeNull();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Watchlist' })).toBeVisible();
    expect(await cardOrder(page)).toEqual(['watchlist-add', 'watchlist-table']);
  });

  test('hide and resize persist across a reload, and a hidden card comes back from the list', async ({ page }) => {
    await page.goto('/watchlist');
    await page.getByRole('button', { name: 'Customize layout' }).click();

    await page.getByLabel('Width of Watchlist').selectOption('half');
    await page.getByRole('button', { name: 'Hide Add to watchlist' }).click();
    await expect.poll(() => stored(page)).toContain('"hidden":["watchlist-add"]');
    expect(await stored(page)).toContain('"widths":{"watchlist-table":"half"}');

    await page.reload();
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-table']);
    await expect(page.locator('[data-card-id="watchlist-table"]')).toHaveAttribute('data-width', 'half');
    await expect(page.getByRole('form', { name: 'Add to watchlist' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Show Add to watchlist' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-add', 'watchlist-table']);
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => stored(page)).toBeNull();
    await expect(page.locator('[data-card-id="watchlist-table"]')).toHaveAttribute('data-width', 'full');
  });

  test('the narrow-screen layout is separate from the wide one', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/watchlist');
    await page.getByRole('button', { name: 'Customize layout' }).click();
    await expect(page.getByText('Editing the layout for narrow screens')).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Width of/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Move Add to watchlist down' }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('portfolio-tracker.layout.watchlist.mobile')))
      .toContain('"order":["watchlist-table","watchlist-add"]');
    expect(await stored(page)).toBeNull();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => cardOrder(page)).toEqual(['watchlist-add', 'watchlist-table']);
  });
});
