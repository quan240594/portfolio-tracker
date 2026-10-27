import { expect, test } from '@playwright/test';
import { gotoViaNav } from './nav';

const VERDICT = /Achievable in \d+ years? \(by \d{4}\)|Not reached within the horizon|Goal already reached/;

test.describe('Goals (mock mode)', () => {
  test('plan a goal: results, preview, save, CSV download and reset', async ({ page }) => {
    await page.goto('/');
    await gotoViaNav(page, 'Goals');
    await expect(page).toHaveURL(/\/goals$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();

    const form = page.getByRole('form', { name: 'Goal settings' });
    const verdict = page.locator('output').filter({ hasText: VERDICT });
    await expect(verdict).toBeVisible();
    await expect(page.getByTestId('goal-chart')).toBeVisible();
    await expect(page.getByRole('table', { name: /Annual income per year/ })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Insights' }).getByRole('listitem').first()).toBeVisible();
    await expect(form.getByRole('button', { name: 'Reset' })).toBeDisabled();

    // Keyboard: the goal type is a native radio group.
    await form.getByRole('radio', { name: 'Passive income' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(form.getByRole('radio', { name: 'Portfolio value' })).toBeChecked();
    await expect(form.getByLabel('Target portfolio value (€)')).toHaveValue('500000');
    await expect(page.getByText('Preview of unsaved changes')).toBeVisible();
    await expect(page.getByRole('table', { name: /Portfolio value per year/ })).toBeVisible();

    await form.getByRole('button', { name: 'Returns and inflation' }).click();
    await form.getByLabel('Monthly contribution (€)').fill('1500');
    await form.getByLabel('Inflation per year (%)').fill('3');
    await form.getByRole('button', { name: 'Save and calculate' }).click();
    await expect(form.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText('Preview of unsaved changes')).toBeHidden();
    await expect(page.getByRole('columnheader', { name: /Contributions/ })).toContainText('1.500/month');
    await expect(page.getByText('Goal reached').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    expect((await download).suggestedFilename()).toBe('goal-projection.csv');

    await page.getByText('All parameters and scenarios').click();
    await expect(page.getByRole('table', { name: 'Parameters used per scenario' })).toBeVisible();

    // The goal is per scope: another portfolio starts from the defaults.
    await page.getByLabel('Scope', { exact: true }).selectOption({ label: 'Trading 212' });
    await expect(form.getByLabel('Target annual passive income (€)')).toHaveValue('24000');
    await page.getByLabel('Scope', { exact: true }).selectOption({ label: 'All portfolios' });
    await expect(form.getByLabel('Target portfolio value (€)')).toHaveValue('500000');

    await form.getByRole('button', { name: 'Reset' }).click();
    await expect(form.getByLabel('Target annual passive income (€)')).toHaveValue('24000');
    await expect(form.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  test('validates the form inline', async ({ page }) => {
    await page.goto('/goals');
    const form = page.getByRole('form', { name: 'Goal settings' });
    await expect(page.locator('output').filter({ hasText: VERDICT })).toBeVisible();
    await form.getByLabel('Target annual passive income (€)').fill('0');
    await form.getByRole('button', { name: 'Save and calculate' }).click();
    await expect(form.getByText(/Target amount must be a number between 1 and/)).toBeVisible();
    await expect(form.getByLabel('Target annual passive income (€)')).toHaveAttribute('aria-invalid', 'true');
  });

  test('stacks the form above the results on a phone without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/goals');
    const form = page.getByRole('form', { name: 'Goal settings' });
    await expect(page.locator('output').filter({ hasText: VERDICT })).toBeVisible();
    const formBox = (await form.boundingBox())!;
    const resultsBox = (await page.getByRole('region', { name: 'Goal summary' }).boundingBox())!;
    expect(resultsBox.y).toBeGreaterThan(formBox.y + formBox.height);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('works in dark mode', async ({ page }) => {
    await page.goto('/goals');
    await page.getByRole('button', { name: 'Dark mode' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByTestId('goal-chart')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Goal summary' })).toBeVisible();
  });

  test('helpers suggest growth, yield and inflation from the demo portfolio and the mock ECB series, with explanations', async ({ page }) => {
    await page.goto('/goals');
    const form = page.getByRole('form', { name: 'Goal settings' });
    await expect(page.locator('output').filter({ hasText: VERDICT })).toBeVisible();
    await form.getByRole('button', { name: 'Returns and inflation' }).click();

    // The demo portfolio yields under 1% with five or more payers: a goal nobody saved starts on "Dividend payers only".
    await expect(form.getByRole('radio', { name: /Dividend payers only/ })).toBeChecked();
    await expect(form.getByLabel('Yield on new money (%)')).not.toHaveValue('3,5');
    await expect(form.getByText(/divided by the market value of only the \d+ holdings? that pay dividends/)).toBeVisible();
    await form.getByRole('radio', { name: /Portfolio forward yield/ }).check({ force: true });
    await expect(form.getByText(/divided by the market value of all holdings/)).toBeVisible();

    await form.getByRole('radio', { name: /From my portfolio/ }).check({ force: true });
    await expect(form.getByText(/dividend-paying holdings?/)).toBeVisible();

    await form.getByRole('radio', { name: /ECB history/ }).check({ force: true });
    await expect(form.getByText(/average over the last 10 years/)).toBeVisible();
    await expect(form.getByLabel('Inflation per year (%)')).not.toHaveValue('2');
    await form.getByLabel('Inflation period').selectOption('20y');
    await expect(form.getByText(/average over the last 20 years/)).toBeVisible();
    await form.getByRole('radio', { name: /ECB target/ }).check({ force: true });
    await expect(form.getByLabel('Inflation per year (%)')).toHaveValue('2');

    await form.getByLabel('Inflation per year (%)').fill('3');
    await expect(form.getByRole('radio', { name: 'Manual' }).nth(2)).toBeChecked();

    const tip = form.getByText('i', { exact: true }).first();
    await tip.click();
    await expect(form.getByText(/compound annual growth rate of the dividend paid per share/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(form.getByText(/compound annual growth rate of the dividend paid per share/)).toBeHidden();
  });
});
