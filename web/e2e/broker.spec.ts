import { expect, test } from '@playwright/test';
import { gotoViaNav } from './nav';

test.describe('Trading 212 connection (mock mode, simulated)', () => {
  test('connects with masked fields, syncs and disconnects without persisting the secret', async ({ page }) => {
    await page.goto('/');
    await gotoViaNav(page, 'Brokers');
    await expect(page).toHaveTitle(/Trading 212 · Portfolio Tracker/);
    await expect(page.getByText('Demo mode: the connection is simulated')).toBeVisible();

    const key = page.getByLabel('API key');
    const secret = page.getByLabel('API secret');
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill('e2e-key');
    await secret.fill('e2e-secret');
    await page.getByRole('button', { name: 'Test & connect' }).click();

    const card = page.getByRole('region', { name: 'Trading 212 status' });
    await expect(card.getByTestId('sync-status')).toHaveText('Up to date');
    await expect(card.getByRole('table', { name: 'Instruments that were not imported' })).toContainText('EXAMPLE_EQ');

    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('e2e-secret');
    expect(stored).not.toContain('e2e-key');

    await card.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByLabel('API key')).toBeVisible();
  });

  test('shows the rejection message for a key Trading 212 would refuse', async ({ page }) => {
    await page.goto('/brokers');
    await page.getByLabel('API key').fill('invalid');
    await page.getByLabel('API secret').fill('x');
    await page.getByRole('button', { name: 'Test & connect' }).click();
    await expect(page.getByRole('alert')).toContainText('Trading 212 rejected the credentials');
  });
});
