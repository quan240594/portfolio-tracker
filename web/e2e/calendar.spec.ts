import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

const events = (page: Page) => page.getByRole('region', { name: 'Events' });
/** The native checkbox/radio is visually hidden: users click its label. */
const clickLabel = (page: Page, role: 'checkbox' | 'radio', name: string) => page.getByRole(role, { name }).locator('xpath=ancestor::label').click();

test.describe('Calendar (mock mode)', () => {
  test('month grid, navigation, filters, overflow, event details and the .ics download', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calendar' }).click();
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
    await expect(page).toHaveTitle(/Calendar · Portfolio Tracker/);

    // KPIs and the income chart.
    for (const label of ['Annual income', 'Monthly average', 'Daily average']) {
      await expect(page.getByRole('region', { name: label, exact: true }).getByTestId('kpi-value')).toHaveText(/€\s[\d.]+,\d{2}$/);
    }
    await expect(page.getByRole('region', { name: 'Yield' }).getByTestId('kpi-value')).toHaveText(/\d+,\d{2}%/);
    await expect(page.getByTestId('calendar-income-chart')).toBeVisible();

    // Month grid (the default on a desktop viewport): Monday first, today highlighted.
    const grid = events(page).getByRole('table');
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('columnheader')).toHaveCount(7);
    await expect(grid.locator('[aria-current="date"]')).toHaveCount(1);
    await expect(grid.locator('[aria-current="date"]')).toHaveText(new RegExp(`^${new Date().getDate()}`));

    // Month navigation keeps working in both directions and "Today" returns.
    const heading = page.getByRole('heading', { level: 2, name: /\d{4}$/ });
    const current = await heading.textContent();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(heading).not.toHaveText(current!);
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(heading).toHaveText(current!);

    // Go to the month with the busy day (15 days ahead has an ex-dividend, earnings and a split).
    const busy = daysAhead(15);
    if (busy.getMonth() !== new Date().getMonth()) await page.getByRole('button', { name: 'Next month' }).click();
    const cell = grid.locator(`td[data-date="${isoDay(busy)}"]`);
    await expect(cell.getByRole('button')).toHaveCount(4);
    await expect(cell.getByRole('button', { name: /^1 more on/ })).toBeVisible();

    // The overflow opens the day; an event opens its details with the user's quantity and expected amount.
    await cell.getByRole('button', { name: /^1 more on/ }).click();
    const dayDialog = page.getByRole('dialog');
    await expect(dayDialog).toContainText('4 events');
    await dayDialog.getByRole('button', { name: /^KO, Ex-dividend/ }).click();
    const detail = page.getByRole('dialog', { name: 'KO · Ex-dividend' });
    await expect(detail).toContainText('Your shares on the ex-date');
    await expect(detail).toContainText(/Expected \(net\)€\s\d/);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // Keyboard: a chip is a button; Enter opens it and Escape returns focus.
    const chip = cell.getByRole('button').first();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(chip).toBeFocused();

    // Filters: type toggles hide events without reloading; the Calendar/List toggle switches views.
    await clickLabel(page, 'checkbox', 'Earnings');
    await expect(page.getByRole('checkbox', { name: 'Earnings' })).not.toBeChecked();
    await expect(grid.getByRole('button', { name: /Earnings,/ })).toHaveCount(0);
    await clickLabel(page, 'checkbox', 'Earnings');
    await expect(grid.getByRole('button', { name: /Earnings,/ }).first()).toBeVisible();
    await clickLabel(page, 'radio', 'List');
    await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
    await expect(grid).toBeHidden();
    await expect(events(page).getByRole('heading', { level: 3 }).first()).toBeVisible();

    // The 12-month range is a list of everything coming up, including the demo split.
    await clickLabel(page, 'radio', 'Next 12 months');
    await expect(page.getByRole('radio', { name: 'Calendar' })).toBeDisabled();
    await events(page).getByRole('button', { name: /^MSFT, Stock split/ }).click();
    await expect(page.getByRole('dialog', { name: 'MSFT · Stock split' })).toContainText('2-for-1 stock split');
    await page.keyboard.press('Escape');

    // Scope: watchlist-only events have no amounts.
    await page.getByLabel('Show').selectOption('watchlist');
    await expect(events(page).getByRole('button', { name: /^AAPL,/ })).toHaveCount(0);
    await expect(events(page).getByRole('button', { name: /^NVDA,/ }).first()).toBeVisible();
    await page.getByLabel('Show').selectOption('all');

    // Download: fetched with the app's credentials and saved as a file.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .ics' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^portfolio-calendar-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.ics$/);
    const body = await readFile((await download.path())!, 'utf8');
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body).toMatch(/UID:earn:AAPL:\d{4}-\d{2}-\d{2}@portfolio-tracker/);
    expect(body).toMatch(/DTSTART;VALUE=DATE:\d{8}\r\nDTEND;VALUE=DATE:\d{8}/);
    await expect(page.getByText(/^Saved portfolio-calendar-/)).toBeVisible();
  });

  test('works in dark mode', async ({ page }) => {
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Dark mode' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(events(page).getByRole('table')).toBeVisible();
    await expect(page.getByTestId('calendar-income-chart')).toBeVisible();
  });

  test('portfolio scope is honoured', async ({ page }) => {
    await page.goto('/calendar?portfolio=trading-212&range=year');
    await expect(events(page).getByRole('heading', { level: 3 }).first()).toBeVisible();
    await expect(events(page).getByRole('button', { name: /^VWRL\.AS,/ })).toHaveCount(0);
    await expect(events(page).getByRole('button', { name: /^AAPL,/ }).first()).toBeVisible();
  });
});

test.describe('Calendar on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shows the list by default without horizontal scrolling', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
    await expect(events(page).getByRole('heading', { level: 3 }).first()).toBeVisible();
    await expect(events(page).getByRole('table')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await events(page).getByRole('listitem').first().getByRole('button').click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
