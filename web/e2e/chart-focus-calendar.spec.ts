import { expect, test, type Locator, type Page } from '@playwright/test';
import { settledCount } from './settled';

/** Legend hover / keyboard focus preview of the Calendar income chart (mock mode): the status stays, the rest fades; nothing is included or excluded. */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page) => page.getByRole('region', { name: 'Income per month', exact: true });
const bars = (chart: Locator) => chart.locator('path.recharts-rectangle');
const toggle = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const kpis = (page: Page) => page.getByRole('region', { name: /^(Annual income|Monthly average|Daily average|Yield)$/ }).getByTestId('kpi-value').allTextContents();

const dimmed = (shapes: Locator) => shapes.and(shapes.page().locator('[fill-opacity="0.25"]'));
const strong = (shapes: Locator) => shapes.and(shapes.page().locator('[fill-opacity="1"]'));

/** Highlighted-bar count after a hover: waits until the preview has been applied (every bar is either strong or dimmed and something is dimmed). */
async function settledKept(shapes: Locator): Promise<number> {
  const total = await shapes.count();
  await expect
    .poll(async () => (await strong(shapes).count()) + (await dimmed(shapes).count()) === total && (await dimmed(shapes).count()) > 0)
    .toBe(true);
  return strong(shapes).count();
}

async function expectNothingFaded(shapes: Locator) {
  await expect(dimmed(shapes)).toHaveCount(0);
  await expect(strong(shapes)).toHaveCount(await shapes.count());
}

async function openCalendar(page: Page) {
  await page.goto('/calendar');
  const region = card(page);
  const chart = region.getByTestId('calendar-income-chart');
  await expect(bars(chart).first()).toBeVisible();
  return { region, chart, legend: region.getByTestId('calendar-income-legend') };
}

const valueLabel = (chart: Locator) => chart.locator('.recharts-label-list text').first();
const avgLine = (chart: Locator) => chart.locator('.recharts-reference-line line');
const avgLabel = (chart: Locator) => chart.locator('.recharts-reference-line text');

test.describe('Calendar income chart: legend preview', () => {
  test('hovering a status keeps its segments, fades the rest and the labels a little; leaving restores; nothing is included or excluded', async ({ page }) => {
    const { region, chart, legend } = await openCalendar(page);
    const all = await settledCount(bars(chart));
    await expectNothingFaded(bars(chart));
    const kpiValues = await kpis(page);
    const grid = await page.getByRole('region', { name: 'Events' }).innerText();

    await toggle(legend, 'Declared').hover();
    const declared = await settledKept(bars(chart));
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - declared);
    await expect(avgLine(chart)).toHaveAttribute('stroke-opacity', '0.25');
    await expect(avgLabel(chart)).toHaveAttribute('opacity', '0.25');
    await expect(valueLabel(chart)).toHaveAttribute('opacity', '0.5');

    await toggle(legend, 'Estimated').hover();
    const estimated = await settledKept(bars(chart));
    expect(estimated).toBeGreaterThan(0);
    expect(estimated).toBeLessThan(all);

    await toggle(legend, 'Received').hover();
    const received = await settledKept(bars(chart));
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(all);

    // the plain average item: the line and its label stay, every bar fades
    await legend.getByText('avg', { exact: true }).hover();
    await expect(strong(bars(chart))).toHaveCount(0);
    await expect(dimmed(bars(chart))).toHaveCount(all);
    await expect(avgLine(chart)).toHaveAttribute('stroke-opacity', '1');
    await expect(avgLabel(chart)).toHaveAttribute('opacity', '1');
    await expect(valueLabel(chart)).toHaveAttribute('opacity', '0.5');

    // leaving restores the chart; KPIs, the month grid and the legend state did not change
    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));
    await expect(avgLine(chart)).toHaveAttribute('stroke-opacity', '1');
    await expect(valueLabel(chart)).toHaveAttribute('opacity', '1');
    await expect(bars(chart)).toHaveCount(all);
    expect(await kpis(page)).toEqual(kpiValues);
    expect(await page.getByRole('region', { name: 'Events' }).innerText()).toEqual(grid);
    await expect(toggle(legend, 'Declared')).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
  });

  test('an excluded status has nothing to preview, and clicking still toggles it back', async ({ page }) => {
    const { chart, legend } = await openCalendar(page);
    await toggle(legend, 'Declared').click();
    await expect(toggle(legend, 'Declared')).toHaveAttribute('aria-pressed', 'false');
    const left = await bars(chart).count();
    await toggle(legend, 'Declared').hover();
    await expectNothingFaded(bars(chart));
    await expect(avgLine(chart)).toHaveAttribute('stroke-opacity', '1');

    // another entry still previews while one is excluded
    await toggle(legend, 'Estimated').hover();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));
    await expect(bars(chart)).toHaveCount(left);

    await toggle(legend, 'Declared').click();
    await expect(toggle(legend, 'Declared')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Tab onto a legend entry previews it, Tab away restores the chart', async ({ page }) => {
    const { chart, legend } = await openCalendar(page);
    await page.mouse.move(2, 2);
    const first = legend.getByRole('button').first();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await expectNothingFaded(bars(chart));
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(first).not.toBeFocused();
    await expectNothingFaded(bars(chart));
  });
});

test.describe('Touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('a tap toggles the entry and leaves the chart unfaded', async ({ page }) => {
    const { chart, legend } = await openCalendar(page);
    await toggle(legend, 'Estimated').tap();
    await expect(toggle(legend, 'Estimated')).toHaveAttribute('aria-pressed', 'false');
    await expect(dimmed(bars(chart))).toHaveCount(0);
  });
});

test.describe('Layout', () => {
  for (const width of [1440, 390, 320]) {
    test(`hovering a legend entry never makes the page scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { legend } = await openCalendar(page);
      await toggle(legend, 'Declared').hover();
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      await page.mouse.move(2, 2);
      expect(await overflow(page)).toBeLessThanOrEqual(1);
    });
  }
});
