import { expect, test, type Locator, type Page } from '@playwright/test';
import { settledCount } from './settled';

/** Legend hover / keyboard focus preview on the Growth tab and the asset detail charts (mock mode): the entry's series stays, the rest fades; nothing is included or excluded. */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const lines = (chart: Locator) => chart.locator('path.recharts-line-curve');
const bars = (chart: Locator) => chart.locator('.recharts-bar-rectangle path.recharts-rectangle');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string | RegExp) => scope.getByRole('button', { name, exact: typeof name === 'string' });
const withOpacity = (shapes: Locator, attribute: 'fill-opacity' | 'stroke-opacity', value: number) => shapes.and(shapes.page().locator(`[${attribute}="${value}"]`));

/** Shapes of the chart that are faded / at full strength (lines are drawn with a stroke, bars and areas with a fill). */
const dimmed = (shapes: Locator, attribute: 'fill-opacity' | 'stroke-opacity' = 'fill-opacity') => withOpacity(shapes, attribute, 0.25);
const strong = (shapes: Locator, attribute: 'fill-opacity' | 'stroke-opacity' = 'fill-opacity') => withOpacity(shapes, attribute, 1);

/** Strong-shape count after a hover: waits until the preview has been applied (every shape is either strong or dimmed and something is dimmed). */
async function settledKept(shapes: Locator, attribute: 'fill-opacity' | 'stroke-opacity'): Promise<number> {
  const total = await shapes.count();
  await expect
    .poll(async () => (await strong(shapes, attribute).count()) + (await dimmed(shapes, attribute).count()) === total && (await dimmed(shapes, attribute).count()) > 0)
    .toBe(true);
  return strong(shapes, attribute).count();
}

async function expectNothingFaded(shapes: Locator, attribute: 'fill-opacity' | 'stroke-opacity') {
  await expect(dimmed(shapes, attribute)).toHaveCount(0);
  await expect(strong(shapes, attribute)).toHaveCount(await shapes.count());
}

const LEAVE = { x: 2, y: 2 };

test.describe('Portfolio value', () => {
  test('hovering an entry keeps its line (the portfolio: its area) and fades the others; leaving restores', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio value');
    const chart = region.getByTestId('growth-value-chart');
    const legend = region.getByTestId('growth-value-legend');
    await expect(lines(chart).first()).toBeVisible();
    const all = await lines(chart).count();
    const area = chart.locator('path.recharts-area-area');
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await expect(area).toHaveAttribute('fill-opacity', '1');
    const headline = page.getByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by/);
    const text = await headline.textContent();

    await toggle(legend, /^IWDA\.AS/).hover();
    expect(await settledKept(lines(chart), 'stroke-opacity')).toBe(1);
    await expect(dimmed(lines(chart), 'stroke-opacity')).toHaveCount(all - 1);
    await expect(area).toHaveAttribute('fill-opacity', '0.25');
    await expect(chart.locator('path.recharts-area-curve')).toHaveAttribute('stroke-opacity', '0.25');

    await toggle(legend, /^Portfolio/).hover();
    await expect(strong(lines(chart), 'stroke-opacity')).toHaveCount(0);
    await expect(area).toHaveAttribute('fill-opacity', '1');

    await toggle(legend, /^Invested/).hover();
    expect(await settledKept(lines(chart), 'stroke-opacity')).toBe(1);
    await expect(area).toHaveAttribute('fill-opacity', '0.25');

    // leaving restores the chart; nothing was included or excluded, the headline and the benchmark picker are untouched
    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await expect(area).toHaveAttribute('fill-opacity', '1');
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
    await expect(headline).toHaveText(text!);
    await expect(card(page, 'Benchmarks').getByRole('list', { name: 'Selected benchmarks' }).getByRole('listitem')).toHaveCount(1);
  });

  test('an excluded entry has nothing to preview, and clicking still toggles', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio value');
    const chart = region.getByTestId('growth-value-chart');
    const legend = region.getByTestId('growth-value-legend');
    await expect(lines(chart).first()).toBeVisible();
    await toggle(legend, /^IWDA\.AS/).click();
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(1);
    await toggle(legend, /^IWDA\.AS/).hover();
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await expect(chart.locator('path.recharts-area-area')).toHaveAttribute('fill-opacity', '1');

    // another entry still previews while one is excluded
    await toggle(legend, /^Portfolio/).hover();
    await expect(dimmed(lines(chart), 'stroke-opacity')).toHaveCount(1);
    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(lines(chart), 'stroke-opacity');

    await toggle(legend, /^IWDA\.AS/).click();
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    await expect(lines(chart)).toHaveCount(2);
  });

  test('Tab onto a legend entry previews it, Tab away restores the chart', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio value');
    const chart = region.getByTestId('growth-value-chart');
    const legend = region.getByTestId('growth-value-legend');
    await expect(lines(chart).first()).toBeVisible();
    await page.mouse.move(LEAVE.x, LEAVE.y);
    const first = legend.getByRole('button').first();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    // the portfolio entry: its area stays, both lines fade
    await expect(dimmed(lines(chart), 'stroke-opacity')).toHaveCount(await lines(chart).count());
    await page.keyboard.press('Tab');
    await expect(legend.getByRole('button').nth(1)).toBeFocused();
    await expect(strong(lines(chart), 'stroke-opacity')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(first).not.toBeFocused();
    await expectNothingFaded(lines(chart), 'stroke-opacity');
  });
});

test.describe('Portfolio performance', () => {
  test('hovering the portfolio or a benchmark fades the other line', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio performance');
    const chart = region.getByTestId('growth-performance-chart');
    const legend = region.getByTestId('growth-performance-legend');
    await expect(lines(chart).first()).toBeVisible();
    await expectNothingFaded(lines(chart), 'stroke-opacity');

    await toggle(legend, /^IWDA\.AS/).hover();
    expect(await settledKept(lines(chart), 'stroke-opacity')).toBe(1);
    await toggle(legend, /^Portfolio/).hover();
    await expect(strong(lines(chart), 'stroke-opacity')).toHaveCount(1);
    await expect(dimmed(lines(chart), 'stroke-opacity')).toHaveCount(1);

    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
  });
});

test.describe('Dynamics of portfolio returns', () => {
  test('hovering Portfolio or a benchmark keeps its bars and fades the other series; leaving restores', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Dynamics of portfolio returns');
    const chart = region.getByTestId('growth-dynamics-chart');
    const legend = region.getByTestId('growth-dynamics-legend');
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    await expectNothingFaded(bars(chart), 'fill-opacity');

    await toggle(legend, /^Portfolio/).hover();
    const portfolio = await settledKept(bars(chart), 'fill-opacity');
    expect(portfolio).toBeGreaterThan(0);
    expect(portfolio).toBeLessThan(all);
    await expect(dimmed(bars(chart))).toHaveCount(all - portfolio);
    await expect(withOpacity(bars(chart), 'stroke-opacity', 0.25)).toHaveCount(all - portfolio);

    await toggle(legend, /^IWDA\.AS/).hover();
    await expect(strong(bars(chart))).toHaveCount(all - portfolio);
    await expect(dimmed(bars(chart))).toHaveCount(portfolio);
    expect(await settledKept(bars(chart), 'fill-opacity')).toBe(all - portfolio);

    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(bars(chart), 'fill-opacity');
    await expect(toggle(legend, /^Portfolio/)).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
  });

  test('an excluded series does nothing', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Dynamics of portfolio returns');
    const chart = region.getByTestId('growth-dynamics-chart');
    const legend = region.getByTestId('growth-dynamics-legend');
    await expect(bars(chart).first()).toBeVisible();
    await toggle(legend, /^IWDA\.AS/).click();
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await toggle(legend, /^IWDA\.AS/).hover();
    await expectNothingFaded(bars(chart), 'fill-opacity');
  });
});

test.describe('Holdings performance', () => {
  test('the one series covers every bar, so hovering it fades nothing', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Holdings performance');
    const chart = region.getByTestId('growth-holdings-chart');
    await expect(bars(chart).first()).toBeVisible();
    await toggle(region.getByTestId('growth-holdings-legend'), /^Return per holding/).hover();
    await expect(dimmed(bars(chart))).toHaveCount(0);
  });
});

test.describe('Asset detail', () => {
  test('Price history: hovering a benchmark fades the security line and its markers, hovering the security fades the benchmark', async ({ page }) => {
    await page.goto('/assets/ASML.AS?portfolio=all');
    const region = card(page, 'Price history');
    const chart = region.getByTestId('asset-price-chart');
    const legend = region.getByTestId('asset-price-legend');
    await expect(lines(chart).first()).toBeVisible();
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    const markers = chart.locator('.recharts-reference-dot path');
    await expect(markers.first()).toBeVisible();
    await expect(dimmed(markers)).toHaveCount(0);

    await toggle(legend, /^IWDA\.AS/).hover();
    expect(await settledKept(lines(chart), 'stroke-opacity')).toBe(1);
    await expect(dimmed(markers)).toHaveCount(await markers.count());
    await expect(dimmed(chart.locator('.recharts-reference-dot circle'))).toHaveCount(await chart.locator('.recharts-reference-dot circle').count());

    await toggle(legend, /^ASML\.AS/).hover();
    await expect(strong(markers)).toHaveCount(await markers.count());
    await expect(strong(lines(chart), 'stroke-opacity')).toHaveCount(1);
    await expect(dimmed(lines(chart), 'stroke-opacity')).toHaveCount(1);

    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await expect(dimmed(markers)).toHaveCount(0);
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
  });

  test('Price history: an excluded entry does nothing', async ({ page }) => {
    await page.goto('/assets/ASML.AS?portfolio=all');
    const region = card(page, 'Price history');
    const chart = region.getByTestId('asset-price-chart');
    const legend = region.getByTestId('asset-price-legend');
    await expect(lines(chart).first()).toBeVisible();
    await toggle(legend, /^IWDA\.AS/).click();
    await expect(lines(chart)).toHaveCount(1);
    await toggle(legend, /^IWDA\.AS/).hover();
    await expectNothingFaded(lines(chart), 'stroke-opacity');
  });

  test('Dividends per year: hovering a kind of year fades the other kind', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=all&tab=dividends');
    const chart = page.getByTestId('asset-dividend-chart');
    const legend = page.getByTestId('asset-dividend-legend');
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    await expectNothingFaded(bars(chart), 'fill-opacity');

    await toggle(legend, 'Full year').hover();
    const full = await settledKept(bars(chart), 'fill-opacity');
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThan(all);
    await toggle(legend, 'Partial year').hover();
    await expect(strong(bars(chart))).toHaveCount(all - full);
    await expect(dimmed(bars(chart))).toHaveCount(full);

    await page.mouse.move(LEAVE.x, LEAVE.y);
    await expectNothingFaded(bars(chart), 'fill-opacity');

    await toggle(legend, 'Partial year').click();
    await toggle(legend, 'Partial year').hover();
    await expect(dimmed(bars(chart))).toHaveCount(0);
  });
});

test.describe('Touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('a tap toggles the entry and leaves the chart unfaded', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio value');
    const chart = region.getByTestId('growth-value-chart');
    const legend = region.getByTestId('growth-value-legend');
    await expect(lines(chart).first()).toBeVisible();
    await toggle(legend, /^IWDA\.AS/).tap();
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(1);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
    await toggle(legend, /^IWDA\.AS/).tap();
    await expect(lines(chart)).toHaveCount(2);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
  });
});

test.describe('Layout', () => {
  for (const width of [1440, 390, 320]) {
    test(`hovering a legend entry never makes the page scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/analytics');
      const hover = async (region: string, legendId: string, name: RegExp, shapes: Locator) => {
        const scope = card(page, region);
        await expect(shapes.first()).toBeVisible();
        await toggle(scope.getByTestId(legendId), name).hover();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await page.mouse.move(LEAVE.x, LEAVE.y);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      };
      await hover('Portfolio value', 'growth-value-legend', /^IWDA\.AS/, lines(card(page, 'Portfolio value')));
      await hover('Portfolio performance', 'growth-performance-legend', /^IWDA\.AS/, lines(card(page, 'Portfolio performance')));
      await hover('Dynamics of portfolio returns', 'growth-dynamics-legend', /^Portfolio/, bars(card(page, 'Dynamics of portfolio returns')));

      // the asset header can already be a few pixels wider than a 320px phone: compare with the page before the preview
      await page.goto('/assets/AAPL?portfolio=all');
      await expect(lines(page.getByTestId('asset-price-chart')).first()).toBeVisible();
      const before = await overflow(page);
      await toggle(page.getByTestId('asset-price-legend'), /^IWDA\.AS/).hover();
      expect(await overflow(page)).toBeLessThanOrEqual(before);
      await page.mouse.move(LEAVE.x, LEAVE.y);
      expect(await overflow(page)).toBeLessThanOrEqual(before);
    });
  }
});
