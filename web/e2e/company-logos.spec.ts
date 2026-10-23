import { expect, test, type Page } from '@playwright/test';

/**
 * Company logos in the calendar. The default mock server (the demo build) shows the neutral monogram and never calls /api/logos;
 * the second mock server of playwright.config.ts starts with VITE_LOGOS=on and serves a drawn stand-in for AAPL and KO through MSW
 * (404 for every other symbol), which covers the image path and its fallback in one page.
 */
// The second mock server of playwright.config.ts: one port above the first.
const LOGOS_ON = `http://localhost:${Number(process.env.E2E_PORT ?? 5174) + 1}`;

const events = (page: Page) => page.getByRole('region', { name: 'Events' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const logoRequests = (page: Page): string[] => {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/logos/')) urls.push(request.url());
  });
  return urls;
};

for (const width of [320, 1280]) {
  test.describe(`Calendar logos at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the demo shows the monogram, asks for no logo and does not overflow', async ({ page }) => {
      const requested = logoRequests(page);
      await page.goto('/calendar?range=year');
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const rows = events(page).getByRole('listitem');
      await expect(rows.first()).toBeVisible();
      await expect(events(page).locator('img')).toHaveCount(0);
      const monograms = events(page).locator('[data-logo="monogram"]');
      expect(await monograms.count()).toBeGreaterThan(2);
      await expect(monograms.first().locator('[data-monogram]')).toHaveAttribute('data-monogram', /^[A-Z0-9]{1,2}$/);
      // The type is still told apart without the letter badge: a marker, the words and the accessible name.
      const first = rows.first().getByRole('button');
      await expect(first).toHaveAccessibleName(/^[^,]+, (Ex-dividend|Dividend payment|Earnings|Stock split|Corporate action), /);
      await expect(first.locator('svg[data-shape]')).toHaveCount(1);
      expect(requested).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('with logos on, a known symbol shows its image, the others the monogram, and nothing overflows', async ({ page }) => {
      await page.goto(`${LOGOS_ON}/calendar?range=year`);
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const apple = events(page).getByRole('button', { name: /^AAPL,/ }).first();
      await expect(apple).toBeVisible();
      await apple.scrollIntoViewIfNeeded();
      const image = apple.locator('img');
      await expect(image).toHaveAttribute('src', '/api/logos/AAPL?v=2');
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expect(image).toHaveAttribute('alt', '');

      // MSFT has no stand-in (404): once its image fails the row falls back to the monogram, in a box of the same size.
      const microsoft = events(page).getByRole('button', { name: /^MSFT,/ }).first();
      await microsoft.scrollIntoViewIfNeeded();
      await expect(microsoft.locator('[data-logo="monogram"] [data-monogram]')).toHaveAttribute('data-monogram', 'MS');
      await expect(microsoft.locator('img')).toHaveCount(0);
      const sizes = await Promise.all([apple, microsoft].map((row) => row.locator('[data-logo]').first().evaluate((box) => `${box.getBoundingClientRect().width}x${box.getBoundingClientRect().height}`)));
      expect(sizes[0]).toBe(sizes[1]);

      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('Calendar month grid with logos', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows the logo image on a chip next to the symbol and keeps the type in its name', async ({ page }) => {
    await page.goto(`${LOGOS_ON}/calendar`);
    const grid = events(page).getByRole('table');
    await expect(grid).toBeVisible();
    const chips = grid.getByRole('button', { name: /^(AAPL|KO),/ });
    if ((await chips.count()) === 0) await page.getByRole('button', { name: 'Next month' }).click();
    const chip = chips.first();
    await expect(chip).toBeVisible();
    await expect(chip.locator('img')).toHaveAttribute('src', /\/api\/logos\/(AAPL|KO)\?v=2$/);
    await expect(chip).toHaveAccessibleName(/(Ex-dividend|Dividend payment|Earnings|Stock split|Corporate action)/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RowGeometry {
  rows: number;
  problems: string[];
}

/**
 * The geometry of every list row, measured in the page: the logo and its marker, and every line box of the title and the detail line
 * (Range rects, so a wrapped line counts as many). Each line must start at or right of the logo and marker, all lines must start at the
 * same left edge (one text column), and no line box may intersect the logo or the marker.
 */
function measureRows(page: Page): Promise<RowGeometry> {
  return page.evaluate(() => {
    const box = (rect: DOMRect): Box => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    const meets = (a: Box, b: Box) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    const lineRects = (line: Element) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    };
    const rectProblems = (name: string, rect: DOMRect, edge: number, avoid: Box[]): string[] => {
      const found: string[] = [];
      if (rect.left < edge - 0.5) found.push(`${name}: a text box starts at ${rect.left} left of the logo edge ${edge}`);
      if (avoid.some((other) => meets(box(rect), other))) found.push(`${name}: a text box intersects the logo or its marker`);
      return found;
    };
    const rowProblems = (row: Element): string[] => {
      const name = row.querySelector('button')?.getAttribute('aria-label') ?? '?';
      const logo = row.querySelector('[data-logo]');
      const marker = row.querySelector('[data-logo-marker]');
      const lines = Array.from(row.querySelectorAll('[data-row-line]'));
      if (!logo || !marker || lines.length === 0) return [`${name}: missing logo, marker or lines`];
      const avoid = [box(logo.getBoundingClientRect()), box(marker.getBoundingClientRect())];
      const edge = Math.max(...avoid.map((other) => other.right));
      const rects = lines.map((line) => lineRects(line));
      const lefts = rects.map((list) => Math.min(...list.map((rect) => rect.left)));
      const found = rects.flatMap((list) => list.flatMap((rect) => rectProblems(name, rect, edge, avoid)));
      if (Math.max(...lefts) - Math.min(...lefts) > 1) found.push(`${name}: the lines do not share a left edge (${lefts.join(', ')})`);
      return found;
    };
    const rows = Array.from(document.querySelectorAll('[aria-label="Events"] li'));
    return { rows: rows.length, problems: rows.flatMap((row) => rowProblems(row)) };
  });
}

for (const width of [320, 1280]) {
  test.describe(`Calendar row layout with logos at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the logo, the text column and the amount sit side by side: every line starts right of the logo and its marker', async ({ page }) => {
      await page.goto(`${LOGOS_ON}/calendar?range=year`);
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const apple = events(page).getByRole('button', { name: /^AAPL,/ }).first();
      await expect(apple).toBeVisible();
      await expect.poll(() => apple.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      const geometry = await measureRows(page);
      expect(geometry.rows).toBeGreaterThan(5);
      expect(geometry.problems).toEqual([]);

      // The logo is a circle of a fixed size, the marker stays inside the row.
      const circle = await apple.locator('[data-logo]').evaluate((element) => {
        const frame = element.firstElementChild as HTMLElement;
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, radius: getComputedStyle(frame).borderTopLeftRadius, clipped: getComputedStyle(frame).overflow };
      });
      expect(circle).toMatchObject({ width: 32, height: 32, clipped: 'hidden' });
      expect(Number.parseFloat(circle.radius)).toBeGreaterThanOrEqual(16);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('the event dialog header keeps the name right of the logo and its marker', async ({ page }) => {
      await page.goto(`${LOGOS_ON}/calendar?range=year`);
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      await events(page).getByRole('button', { name: /^AAPL,/ }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const header = await dialog.evaluate((element) => {
        const logo = element.querySelector('[data-logo]')!.getBoundingClientRect();
        const marker = element.querySelector('[data-logo-marker]')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element.querySelector('[data-logo]')!.nextElementSibling!);
        const lefts = Array.from(range.getClientRects()).map((rect) => rect.left);
        return { edge: Math.max(logo.right, marker.right), lefts };
      });
      expect(header.lefts.length).toBeGreaterThan(0);
      for (const left of header.lefts) expect(left).toBeGreaterThanOrEqual(header.edge - 0.5);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('Calendar month grid chips with logos', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the symbol starts right of the logo and its marker, and the chip does not overflow', async ({ page }) => {
    await page.goto(`${LOGOS_ON}/calendar`);
    const grid = events(page).getByRole('table');
    const chips = grid.getByRole('button', { name: /^(AAPL|KO),/ });
    if ((await chips.count()) === 0) await page.getByRole('button', { name: 'Next month' }).click();
    const chip = chips.first();
    await expect(chip).toBeVisible();
    const geometry = await chip.evaluate((element) => {
      const logo = element.querySelector('[data-logo]')!.getBoundingClientRect();
      const marker = element.querySelector('[data-logo-marker]')!.getBoundingClientRect();
      const symbol = element.querySelector('.truncate')!.getBoundingClientRect();
      const chipBox = element.getBoundingClientRect();
      return { edge: Math.max(logo.right, marker.right), symbolLeft: symbol.left, logoWidth: logo.width, chipRight: chipBox.right, symbolRight: symbol.right };
    });
    expect(geometry.logoWidth).toBe(18);
    expect(geometry.symbolLeft).toBeGreaterThanOrEqual(geometry.edge - 0.5);
    expect(geometry.symbolRight).toBeLessThanOrEqual(geometry.chipRight + 0.5);
  });
});

for (const [name, path] of [
  ['the dashboard top holdings', '/'],
  ['the holdings table and cards', '/holdings?portfolio=all'],
  ['the asset header', '/assets/AAPL?portfolio=all'],
] as const) {
  test.describe(`${name} with logos at 320px`, () => {
    test.use({ viewport: { width: 320, height: 900 } });

    test('shows round logos next to the text and does not overflow', async ({ page }) => {
      await page.goto(`${LOGOS_ON}${path}`);
      const logos = page.locator('[data-logo]:visible');
      await expect(logos.first()).toBeVisible();
      const shapes = await logos.evaluateAll((elements) =>
        elements.map((element) => {
          const frame = element.firstElementChild as HTMLElement;
          const rect = element.getBoundingClientRect();
          return { square: Math.abs(rect.width - rect.height) < 0.5, radius: Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius), half: rect.width / 2, inView: rect.right <= document.documentElement.clientWidth + 0.5 };
        }),
      );
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        expect(shape.square).toBe(true);
        expect(shape.radius).toBeGreaterThanOrEqual(shape.half - 0.5);
        expect(shape.inView).toBe(true);
      }
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
