import { expect, type Locator, type Page } from '@playwright/test';

const TOP_LEVEL = new Set(['Dashboard', 'Analytics']);

export const mainNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });
export const portfolioTrigger = (page: Page): Locator => mainNav(page).getByRole('button', { name: 'Portfolio' });

/** Opens the header's Portfolio menu (no-op when already open) and returns its trigger. */
export async function openPortfolioMenu(page: Page): Promise<Locator> {
  const trigger = portfolioTrigger(page);
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return trigger;
}

/** Clicks a header navigation link, opening the Portfolio menu first when the page lives in it. */
export async function gotoViaNav(page: Page, label: string): Promise<void> {
  if (!TOP_LEVEL.has(label)) await openPortfolioMenu(page);
  await mainNav(page).getByRole('link', { name: label, exact: true }).click();
}
