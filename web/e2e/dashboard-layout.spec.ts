import { expect, test, type Page } from '@playwright/test';

const KEY = 'portfolio-tracker.layout.dashboard.desktop';

// The demo is relative to "today"; a fixed clock makes its figures reproducible.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const cardOrder = (page: Page) => page.locator('[data-card-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-id')));
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const periods = (page: Page) => page.getByRole('radiogroup', { name: 'Period' });

const DEFAULT_ORDER = [
  'kpi-total-value',
  'kpi-day-change',
  'kpi-unrealized',
  'kpi-currency-effect',
  'kpi-total-return',
  'kpi-dividends-received',
  'kpi-realized',
  'kpi-irr',
  'kpi-twr',
  'kpi-yield-ttm',
  'kpi-growth-ttm',
  'kpi-passive-income',
  'kpi-cash',
  'kpi-custom-assets',
  'insights',
  'performance',
  'allocation',
  'top-holdings',
  'calendar',
  'watchlist-widget',
  'movers',
  'total-return-note',
];

// Dividend yield (TTM) moved up one place: it swaps with the card before it.
const MOVED = [...DEFAULT_ORDER.slice(0, 8), 'kpi-yield-ttm', 'kpi-twr', ...DEFAULT_ORDER.slice(10)];

test.describe('Dashboard card layout (mock mode, layouts kept in this browser)', () => {
  test('keeps the default order and widths, and the period toggle next to the Customize switch', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Dividend yield (TTM)' }).getByTestId('kpi-value')).toBeVisible();
    expect(await cardOrder(page)).toEqual(DEFAULT_ORDER);
    await expect(page.locator('[data-card-id="kpi-total-value"]')).toHaveAttribute('data-width', 'third');
    await expect(page.locator('[data-card-id="performance"]')).toHaveAttribute('data-width', 'twothirds');
    await expect(page.locator('[data-card-id="allocation"]')).toHaveAttribute('data-width', 'third');
    await expect(page.locator('[data-card-id="top-holdings"]')).toHaveAttribute('data-width', 'half');
    await expect(page.locator('[data-card-id="calendar"]')).toHaveAttribute('data-width', 'half');
    await expect(page.locator('[data-page-header-actions]').getByRole('button', { name: 'Customize layout' })).toBeVisible();
    await expect(periods(page)).toBeVisible();
  });

  test('customize, move a KPI card, reload: the order persists; the period toggle keeps working; reset restores the default', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Dividend yield (TTM)' }).getByTestId('kpi-value')).toBeVisible();
    expect(await stored(page)).toBeNull();

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await expect(periods(page)).toBeVisible();
    await page.getByRole('button', { name: 'Move Dividend yield (TTM) up' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(MOVED);
    await expect.poll(() => stored(page)).toContain('"order":[');

    await page.reload();
    await expect(page.getByRole('region', { name: 'Dividend yield (TTM)' }).getByTestId('kpi-value')).toBeVisible();
    await expect.poll(() => cardOrder(page)).toEqual(MOVED);

    const totalReturn = page.getByRole('region', { name: 'Total return', exact: true }).getByTestId('kpi-value');
    const allTime = await totalReturn.textContent();
    await periods(page).getByRole('radio', { name: 'TTM' }).click();
    await expect(totalReturn).not.toHaveText(allTime!);
    await periods(page).getByRole('radio', { name: 'All time' }).click();
    await expect(totalReturn).toHaveText(allTime!);

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(DEFAULT_ORDER);
    await expect.poll(() => stored(page)).toBeNull();
  });

  test('hide a KPI card and a block: they stay hidden after a reload and come back from the list', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Dividend yield (TTM)' }).getByTestId('kpi-value')).toBeVisible();
    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Hide Day change' }).click();
    await page.getByRole('button', { name: 'Hide Top movers' }).click();
    await expect.poll(() => stored(page)).toContain('"hidden":["kpi-day-change","movers"]');

    await page.reload();
    await expect(page.getByRole('region', { name: 'Dividend yield (TTM)' }).getByTestId('kpi-value')).toBeVisible();
    await expect.poll(() => cardOrder(page)).toEqual(DEFAULT_ORDER.filter((id) => id !== 'kpi-day-change' && id !== 'movers'));
    await expect(page.getByRole('region', { name: 'Day change', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Total value', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Show Day change' }).click();
    await expect(page.getByRole('region', { name: 'Day change', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => stored(page)).toBeNull();
    await expect.poll(() => cardOrder(page)).toEqual(DEFAULT_ORDER);
  });
});
