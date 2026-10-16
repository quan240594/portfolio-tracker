import { expect, test, type Locator, type Page } from '@playwright/test';

/** Legend hover / keyboard focus preview on the Dividends charts (mock mode): the entry's series stays, the rest fades; nothing is included or excluded. */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
// the bars only: the shaded "Upcoming" band is a rectangle too
const bars = (chart: Locator) => chart.locator('.recharts-bar-rectangle path.recharts-rectangle');
const slices = (chart: Locator) => chart.locator('path.recharts-sector');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const fillOpacity = (value: number) => `[fill-opacity="${value}"]`;

/** Bars (or slices) of the chart that are faded / at full strength. */
const dimmed = (shapes: Locator) => shapes.and(shapes.page().locator(fillOpacity(0.25)));
const strong = (shapes: Locator) => shapes.and(shapes.page().locator(fillOpacity(1)));

/** Highlighted-shape count after a hover: waits until the preview has been applied (every shape is either strong or dimmed and something is dimmed). */
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

async function openGrowth(page: Page) {
  await page.goto('/dividends');
  const region = card(page, 'Dividend growth');
  // the forecast bars arrive with the overview: wait for it before counting
  await expect(region.getByTestId('forecast-summary')).toBeVisible();
  const chart = region.getByTestId('year-compare-chart');
  await expect(bars(chart).first()).toBeVisible();
  return { region, chart, legend: region.getByTestId('growth-legend') };
}

test.describe('Dividend growth, By year', () => {
  test('hovering a year or a forecast entry fades the other bars and leaving restores them', async ({ page }) => {
    const { chart, legend } = await openGrowth(page);
    const all = await bars(chart).count();
    await expectNothingFaded(bars(chart));

    // the year with a received bar and a forecast stack: both stay, every other year and the lines fade
    await toggle(legend, '2026').hover();
    const kept = await settledKept(bars(chart));
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - kept);
    await expect(chart.locator('path.recharts-line-curve')).toHaveAttribute('stroke-opacity', '0.25');

    // a forecast-only year: its declared + estimated bars
    await toggle(legend, '2027 (forecast)').hover();
    const forecastKept = await settledKept(bars(chart));
    expect(forecastKept).toBeGreaterThan(0);
    expect(forecastKept).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - forecastKept);

    // the status entries: that status in every year
    await toggle(legend, 'Declared (forecast)').hover();
    const declared = await settledKept(bars(chart));
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - declared);

    // the average line: the bars fade, the line stays
    await toggle(legend, 'Average of years').hover();
    await expect(strong(bars(chart))).toHaveCount(0);
    await expect(chart.locator('path.recharts-line-curve')).toHaveAttribute('stroke-opacity', '1');

    // leaving restores the chart; nothing was included or excluded
    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));
    await expect(chart.locator('path.recharts-line-curve')).toHaveAttribute('stroke-opacity', '1');
    await expect(toggle(legend, '2026')).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, 'Dividend growth').getByTestId('selection-note')).toHaveCount(0);
  });

  test('an excluded entry has nothing to preview, and clicking still toggles', async ({ page }) => {
    const { chart, legend } = await openGrowth(page);
    await toggle(legend, '2026').click();
    await expect(toggle(legend, '2026')).toHaveAttribute('aria-pressed', 'false');
    const left = await bars(chart).count();
    await toggle(legend, '2026').hover();
    await expectNothingFaded(bars(chart));
    await expect(bars(chart)).toHaveCount(left);

    // another entry still previews while one is excluded
    await toggle(legend, '2025').hover();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));

    await toggle(legend, '2026').click();
    await expect(toggle(legend, '2026')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Tab onto a legend entry previews it, Tab away restores the chart', async ({ page }) => {
    const { chart, legend } = await openGrowth(page);
    await page.mouse.move(2, 2);
    const first = legend.getByRole('button').first();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await expectNothingFaded(bars(chart));
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(legend.getByRole('button').nth(1)).toBeFocused();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(legend.getByRole('button').first()).not.toBeFocused();
    await expectNothingFaded(bars(chart));
  });

  test('the timeline fades the other series, the lines included', async ({ page }) => {
    const { region, legend } = await openGrowth(page);
    await region.getByText('Timeline', { exact: true }).click();
    const timeline = region.getByTestId('growth-timeline-chart');
    await expect(timeline.locator('path.recharts-line-curve').first()).toBeVisible();
    const lines = timeline.locator('path.recharts-line-curve');
    await expect(bars(timeline).first()).toBeVisible();

    await toggle(legend, 'Trend').hover();
    await expect(dimmed(bars(timeline)).first()).toBeVisible();
    await expect(strong(bars(timeline))).toHaveCount(0);
    await expect(lines.and(page.locator('[stroke-opacity="1"]'))).toHaveCount(1);

    await toggle(legend, 'Received').hover();
    await expect(strong(bars(timeline)).first()).toBeVisible();
    await expect(lines.and(page.locator('[stroke-opacity="0.25"]'))).toHaveCount(await lines.count());

    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(timeline));
    await expect(lines.and(page.locator('[stroke-opacity="0.25"]'))).toHaveCount(0);
  });
});

test.describe('Other Dividends charts', () => {
  test('Dividends received: hovering Declared keeps the declared bars and fades the received ones', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Dividends received');
    const chart = region.getByTestId('received-time-chart');
    const legend = region.getByTestId('received-legend');
    await expect(bars(chart).first()).toBeVisible();
    await expectNothingFaded(bars(chart));
    const all = await bars(chart).count();

    await toggle(legend, 'Declared').hover();
    const kept = await settledKept(bars(chart));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - kept);
    await expect(chart.getByText('avg', { exact: true })).toBeVisible();
    await expect(chart.locator('.recharts-reference-line line')).toHaveAttribute('stroke-opacity', '0.25');

    await toggle(legend, 'avg').hover();
    await expect(strong(bars(chart))).toHaveCount(0);
    await expect(chart.locator('.recharts-reference-line line')).toHaveAttribute('stroke-opacity', '1');

    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));
  });

  test('Future payments: a status entry and the plain average item both preview', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Future payments');
    const chart = region.getByTestId('future-chart');
    const legend = region.getByTestId('future-legend');
    await expect(bars(chart).first()).toBeVisible();
    const line = chart.locator('.recharts-reference-line line');

    await toggle(legend, 'Declared').hover();
    await expect(dimmed(bars(chart)).first()).toBeVisible();
    await expect(strong(bars(chart)).first()).toBeVisible();
    await expect(line).toHaveAttribute('stroke-opacity', '0.25');

    await legend.getByText('Monthly average', { exact: true }).hover();
    await expect(strong(bars(chart))).toHaveCount(0);
    await expect(line).toHaveAttribute('stroke-opacity', '1');

    await page.mouse.move(2, 2);
    await expectNothingFaded(bars(chart));
  });

  test('Yield / payout: the dots and the bars preview each other', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Yield / payout');
    const chart = region.getByTestId('yield-payout-chart');
    const legend = region.getByTestId('yield-payout-legend');
    await expect(bars(chart).first()).toBeVisible();
    const dots = chart.locator('circle.recharts-dot');
    await expect(dots.first()).toHaveAttribute('fill-opacity', '1');

    await toggle(legend, 'Yield on cost').hover();
    await expect(strong(bars(chart))).toHaveCount(0);
    await expect(dots.first()).toHaveAttribute('fill-opacity', '1');

    await toggle(legend, 'Yield on value').hover();
    await expect(strong(bars(chart)).first()).toBeVisible();
    await expect(dots.first()).toHaveAttribute('fill-opacity', '0.25');

    await page.mouse.move(2, 2);
    await expect(dots.first()).toHaveAttribute('fill-opacity', '1');
  });

  for (const [name, donutId, legendId] of [
    ['Passive income diversification', 'income-donut', 'income-legend'],
    ['Dividend safety', 'consistency-donut', 'consistency-legend'],
  ] as const) {
    test(`${name}: hovering an entry fades the other slices, the centre text stays`, async ({ page }) => {
      await page.goto('/dividends');
      const region = card(page, name);
      const donut = region.getByTestId(donutId);
      const legend = region.getByTestId(legendId);
      await expect(slices(donut).first()).toBeVisible();
      const all = await slices(donut).count();
      expect(all).toBeGreaterThan(1);
      const centre = region.getByTestId(`${donutId}-centre`);
      const text = await centre.textContent();
      await expectNothingFaded(slices(donut));

      await legend.getByRole('button').nth(1).hover();
      await expect(strong(slices(donut))).toHaveCount(1);
      await expect(dimmed(slices(donut))).toHaveCount(all - 1);
      await expect(centre).toHaveText(text!);
      await expect(legend.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');

      await page.mouse.move(2, 2);
      await expectNothingFaded(slices(donut));
    });
  }

  test('hovering an excluded donut entry does nothing', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Passive income diversification');
    const donut = region.getByTestId('income-donut');
    const legend = region.getByTestId('income-legend');
    await expect(slices(donut).first()).toBeVisible();
    const entry = legend.getByRole('button').first();
    await entry.click();
    await expect(entry).toHaveAttribute('aria-pressed', 'false');
    await entry.hover();
    await expectNothingFaded(slices(donut));
  });
});

test.describe('Touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('a tap toggles the entry and leaves the chart unfaded', async ({ page }) => {
    const { chart, legend } = await openGrowth(page);
    await toggle(legend, '2025').tap();
    await expect(toggle(legend, '2025')).toHaveAttribute('aria-pressed', 'false');
    await expect(dimmed(bars(chart))).toHaveCount(0);
  });
});

test.describe('Layout', () => {
  for (const width of [1440, 390, 320]) {
    test(`hovering a legend entry never makes the page scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { legend } = await openGrowth(page);
      await toggle(legend, '2026').hover();
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      await page.mouse.move(2, 2);
      expect(await overflow(page)).toBeLessThanOrEqual(1);
    });
  }
});
