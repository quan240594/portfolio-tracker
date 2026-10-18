import { expect, type Locator } from '@playwright/test';

/**
 * The number of shapes once it has stopped changing: charts draw in several passes (the forecast bars arrive with a second request),
 * so a count read right after the first shape appears can be too low and make later "fewer than before" checks flaky.
 */
export async function settledCount(shapes: Locator): Promise<number> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const now = await shapes.count();
        const stable = now > 0 && now === previous;
        previous = now;
        return stable;
      },
      { intervals: [250], timeout: 10_000 },
    )
    .toBe(true);
  return shapes.count();
}
