import { expect, test, type Locator, type Page } from '@playwright/test';

/** Legend hover / keyboard focus preview on the Dashboard, Analytics and Goals charts (mock mode): the entry's series stays, the rest fades; nothing is included or excluded. */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const lines = (chart: Locator) => chart.locator('path.recharts-line-curve');
const bars = (chart: Locator) => chart.locator('.recharts-bar-rectangle path.recharts-rectangle');
const slices = (chart: Locator) => chart.locator('path.recharts-sector');

const at = (shapes: Locator, attribute: string, value: number) => shapes.and(shapes.page().locator(`[${attribute}="${value}"]`));
const dimmed = (shapes: Locator, attribute: string) => at(shapes, attribute, 0.25);
const strong = (shapes: Locator, attribute: string) => at(shapes, attribute, 1);

/** Highlighted-shape count after a hover: waits until the preview has been applied (every shape is either strong or dimmed and something is dimmed). */
async function settledKept(shapes: Locator, attribute: string): Promise<number> {
  const total = await shapes.count();
  await expect
    .poll(async () => (await strong(shapes, attribute).count()) + (await dimmed(shapes, attribute).count()) === total && (await dimmed(shapes, attribute).count()) > 0)
    .toBe(true);
  return strong(shapes, attribute).count();
}

async function expectNothingFaded(shapes: Locator, attribute: string) {
  await expect(dimmed(shapes, attribute)).toHaveCount(0);
  await expect(strong(shapes, attribute)).toHaveCount(await shapes.count());
}

/** A chart with a legend: where it lives and which shapes carry the opacity. */
interface Target {
  name: string;
  open: (page: Page) => Promise<{ legend: Locator; shapes: Locator }>;
  attribute: string;
  /** Legend entry to preview, and how many shapes stay for it (null = every shape stays: one series only). */
  entry: string | number;
  kept: number | null;
}

async function openOn(page: Page, path: string, chartId: string, legendId: string, shapesOf: (chart: Locator) => Locator, scope?: Locator) {
  await page.goto(path);
  const root = scope ?? page;
  const chart = root.getByTestId(chartId);
  const shapes = shapesOf(chart);
  await expect(shapes.first()).toBeVisible();
  return { legend: root.getByTestId(legendId), shapes };
}

const valueShapes = (chart: Locator) => chart.locator('.recharts-area-curve, path.recharts-line-curve');

const TARGETS: Target[] = [
  {
    name: 'Dashboard value chart',
    open: (page) => openOn(page, '/', 'value-chart', 'value-legend', valueShapes, page.getByRole('region', { name: 'Value vs invested', exact: true })),
    attribute: 'stroke-opacity',
    entry: 'Invested',
    kept: 1,
  },
  {
    name: 'Dashboard allocation donut',
    open: (page) => openOn(page, '/', 'allocation-donut', 'allocation-legend', slices, page.getByRole('region', { name: 'Allocation', exact: true })),
    attribute: 'fill-opacity',
    entry: 0,
    kept: 1,
  },
  {
    name: 'Analytics Benchmark',
    open: (page) => openOn(page, '/analytics?tab=benchmark', 'benchmark-chart', 'benchmark-legend', lines),
    attribute: 'stroke-opacity',
    entry: 'Portfolio',
    kept: 1,
  },
  {
    name: 'Analytics Returns',
    open: (page) => openOn(page, '/analytics?tab=returns', 'returns-chart', 'returns-legend', bars),
    attribute: 'fill-opacity',
    entry: 'Return (TWR)',
    kept: null,
  },
  {
    name: 'Analytics Dividend growth (per month)',
    open: (page) => openOn(page, '/analytics?tab=dividends', 'dividend-month-chart', 'dividend-month-chart-legend', bars),
    attribute: 'fill-opacity',
    entry: 'This period',
    kept: -1,
  },
  {
    name: 'Analytics Income goal',
    open: (page) => openOn(page, '/analytics?tab=goal', 'goal-chart', 'goal-legend', lines),
    attribute: 'stroke-opacity',
    entry: 'Base',
    kept: 1,
  },
  {
    name: 'Goals',
    open: (page) => openOn(page, '/goals', 'goal-chart', 'goal-legend', lines),
    attribute: 'stroke-opacity',
    entry: 'Safe',
    kept: 1,
  },
];

const entryOf = (legend: Locator, entry: string | number) => (typeof entry === 'number' ? legend.getByRole('button').nth(entry) : toggle(legend, entry));

for (const target of TARGETS) {
  test.describe(target.name, () => {
    test('hovering a legend entry keeps its series and fades the rest; leaving restores', async ({ page }) => {
      const { legend, shapes } = await target.open(page);
      const all = await shapes.count();
      await expectNothingFaded(shapes, target.attribute);

      const button = entryOf(legend, target.entry);
      await button.hover();
      if (target.kept === null) {
        // a single series: previewing it keeps every shape
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expectNothingFaded(shapes, target.attribute);
      } else {
        const kept = await settledKept(shapes, target.attribute);
        expect(kept).toBeGreaterThan(0);
        expect(kept).toBeLessThan(all);
        if (target.kept > 0) expect(kept).toBe(target.kept);
        await expect(dimmed(shapes, target.attribute)).toHaveCount(all - kept);
      }

      // leaving restores the chart; nothing was included or excluded
      await page.mouse.move(2, 2);
      await expectNothingFaded(shapes, target.attribute);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('selection-note')).toHaveCount(0);
    });

    test('an excluded entry has nothing to preview, and clicking still toggles', async ({ page }) => {
      const { legend, shapes } = await target.open(page);
      const button = entryOf(legend, target.entry);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      const left = await shapes.count();
      await button.hover();
      if (left > 0) {
        await expectNothingFaded(shapes, target.attribute);
        await expect(shapes).toHaveCount(left);
      }
      await page.mouse.move(2, 2);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    });

    test('Tab onto a legend entry previews it, Tab away restores the chart', async ({ page }) => {
      test.skip(target.kept === null, 'one series: nothing fades');
      const { legend, shapes } = await target.open(page);
      await page.mouse.move(2, 2);
      const button = entryOf(legend, target.entry);
      await button.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await settledKept(shapes, target.attribute);
      await button.blur();
      await expectNothingFaded(shapes, target.attribute);
    });
  });
}

test.describe('Goals chart', () => {
  test('the goal-reached dots fade with their line and the verdict never changes', async ({ page }) => {
    await page.goto('/goals');
    const verdict = page.locator('output').filter({ hasText: /Achievable in|Not reached within|already reached/ });
    await expect(verdict).toBeVisible();
    const text = await verdict.textContent();
    const chart = page.getByTestId('goal-chart');
    const legend = page.getByTestId('goal-legend');
    const dots = chart.locator('.recharts-reference-dot-dot');
    await expect(lines(chart).first()).toBeVisible();
    const total = await dots.count();
    expect(total).toBeGreaterThan(0);

    await toggle(legend, 'Goal (inflation-adjusted)').hover();
    await settledKept(lines(chart), 'stroke-opacity');
    // the goal line has no dot: every dot fades
    await expect(dimmed(dots, 'fill-opacity')).toHaveCount(total);
    await expect(verdict).toHaveText(text!);

    await toggle(legend, 'Your plan').hover();
    await expect.poll(() => strong(dots, 'fill-opacity').count()).toBeGreaterThan(0);
    await expect(strong(dots, 'fill-opacity')).toHaveCount(1);
    await expect(verdict).toHaveText(text!);

    await page.mouse.move(2, 2);
    await expect(strong(dots, 'fill-opacity')).toHaveCount(total);
    await expectNothingFaded(lines(chart), 'stroke-opacity');
  });
});

test.describe('Touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('a tap toggles the entry and leaves the chart unfaded', async ({ page }) => {
    const { legend, shapes } = await TARGETS[0]!.open(page);
    await toggle(legend, 'Invested').tap();
    await expect(toggle(legend, 'Invested')).toHaveAttribute('aria-pressed', 'false');
    await expect(dimmed(shapes, 'stroke-opacity')).toHaveCount(0);

    const donut = await TARGETS[1]!.open(page);
    await donut.legend.getByRole('button').first().tap();
    await expect(donut.legend.getByRole('button').first()).toHaveAttribute('aria-pressed', 'false');
    await expect(dimmed(donut.shapes, 'fill-opacity')).toHaveCount(0);
  });
});

test.describe('Layout', () => {
  for (const width of [1440, 390, 320]) {
    for (const target of [TARGETS[0]!, TARGETS[1]!, TARGETS[2]!, TARGETS[5]!, TARGETS[6]!]) {
      test(`hovering a legend entry never makes the page scroll sideways at ${width}px: ${target.name}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const { legend } = await target.open(page);
        await entryOf(legend, target.entry).hover();
        expect(await overflow(page)).toBeLessThanOrEqual(1);
        await page.mouse.move(2, 2);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
      });
    }
  }
});
