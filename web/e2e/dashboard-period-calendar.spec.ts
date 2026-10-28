import { expect, test, type Locator, type Page } from '@playwright/test';

// The demo is relative to "today"; a fixed clock makes its figures reproducible.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const region = (scope: Page | Locator, name: string) => scope.getByRole('region', { name, exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

const periods = (page: Page) => page.getByRole('radiogroup', { name: 'Period' });

test.describe('Dashboard period toggle (mock mode)', () => {
  test('defaults to all time, filters the period cards and remembers the choice after a reload', async ({ page }) => {
    await page.goto('/');
    await expect(periods(page).getByRole('radio')).toHaveText(['TTM', 'YTD', '5 years', '10 years', 'All time']);
    await expect(periods(page).getByRole('radio', { name: 'All time' })).toHaveAttribute('aria-checked', 'true');
    await expect(region(page, 'Dividends received')).toContainText('Net of withholding tax, all time');
    const allTimeReturn = await region(page, 'Total return').getByTestId('kpi-value').textContent();

    await periods(page).getByRole('radio', { name: 'YTD' }).click();
    await expect(region(page, 'Dividends received')).toContainText('Net of withholding tax · Year to date');
    await expect(region(page, 'Total return')).toContainText('Year to date');
    await expect(region(page, 'Realized P&L').getByTestId('kpi-value')).toHaveText(/^€\s[+−][\d.]+,\d{2}$/);
    await expect(region(page, 'Time-weighted return (TWR)')).toContainText(/Since \d{2}-\d{2}-\d{4}/);

    await page.reload();
    await expect(periods(page).getByRole('radio', { name: 'YTD' })).toHaveAttribute('aria-checked', 'true');
    await expect(region(page, 'Total return')).toContainText('Year to date');

    await periods(page).getByRole('radio', { name: 'All time' }).click();
    await expect(region(page, 'Total return').getByTestId('kpi-value')).toHaveText(allTimeReturn!);
    await expect(region(page, 'Dividends received')).toContainText('Net of withholding tax, all time');
  });

  test('shows the covered range when the history is shorter than the period', async ({ page }) => {
    await page.goto('/');
    await periods(page).getByRole('radio', { name: '10 years' }).click();
    await expect(region(page, 'Total return')).toContainText(/Since \d{2}-\d{2}-\d{4}, the start of your history \(shorter than the period\)/);
    await expect(region(page, 'Money-weighted return (IRR)')).toContainText(/the start of your history/);
  });

  test('keeps the snapshot cards, with a quiet note, and the TTM cards unchanged', async ({ page }) => {
    await page.goto('/');
    const names = ['Total value', 'Day change', 'Unrealized P&L', 'Currency effect', 'Passive income (next 12 months)', 'Dividend yield (TTM)', 'Dividend growth (TTM)'];
    await expect(region(page, 'Dividend yield (TTM)').getByTestId('kpi-value')).toHaveText(/^\d+,\d{2}%$/);
    const before: string[] = [];
    for (const name of names) before.push((await region(page, name).getByTestId('kpi-value').textContent()) ?? '');
    for (const name of names.slice(0, 5)) await expect(region(page, name)).toHaveAttribute('title', 'Not affected by period');

    await periods(page).getByRole('radio', { name: '5 years' }).click();
    await expect(region(page, 'Total return')).toContainText(/Last 5 years|Since \d{2}-\d{2}-\d{4}/);
    const after: string[] = [];
    for (const name of names) after.push((await region(page, name).getByTestId('kpi-value').textContent()) ?? '');
    expect(after).toEqual(before);
  });

  test('shows the projected rest of the year on the dividends card whatever the period', async ({ page }) => {
    await page.goto('/');
    const line = region(page, 'Dividends received').getByText(/^Projected rest of year:/);
    await expect(line).toHaveText(/^Projected rest of year: €\s[\d.]+,\d{2}$/);
    const first = await line.textContent();
    await periods(page).getByRole('radio', { name: 'TTM' }).click();
    await expect(region(page, 'Dividends received')).toContainText('Last 12 months');
    await expect(line).toHaveText(first!);
  });

  test('keeps the period control on the title row without overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await expect(periods(page)).toBeVisible();
    const control = await box(periods(page));
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(320);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('Dashboard calendar card (mock mode)', () => {
  test('sits beside the top holdings, in the same colours as the calendar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const calendar = page.getByTestId('dashboard-calendar');
    await expect(calendar.getByTestId('compact-month-grid')).toBeVisible();
    const top = await box(region(page, 'Top holdings'));
    const cal = await box(calendar);
    expect(cal.x).toBeGreaterThanOrEqual(top.x + top.width - 1);
    expect(Math.abs(cal.y - top.y)).toBeLessThanOrEqual(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // the demo has dividend and earnings dates in the next weeks: markers with the status colours of the calendar page
    await calendar.getByRole('button', { name: 'Next month' }).click();
    await expect(calendar.getByRole('heading', { name: /november 2026/i })).toBeVisible();
    await expect(calendar.locator('[data-type][data-status]').first()).toBeVisible();
    await expect(calendar.locator('p', { hasText: 'Expected dividends in November 2026' })).toContainText('€');
  });

  test('opens the full calendar on the shown month', async ({ page }) => {
    await page.goto('/');
    const calendar = page.getByTestId('dashboard-calendar');
    await expect(calendar.getByTestId('compact-month-grid')).toBeVisible();
    await calendar.getByRole('button', { name: 'Next month' }).click();
    await calendar.getByRole('link', { name: 'Open full calendar →' }).click();
    await expect(page).toHaveURL(/\/calendar\?month=2026-11&scope=holdings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  });

  test('fits a phone without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    const calendar = page.getByTestId('dashboard-calendar');
    await expect(calendar.getByTestId('compact-month-grid')).toBeVisible();
    const cal = await box(calendar);
    expect(cal.x + cal.width).toBeLessThanOrEqual(320);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
