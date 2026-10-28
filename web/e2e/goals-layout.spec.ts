import { expect, test, type Page } from '@playwright/test';

const KEY = 'portfolio-tracker.layout.goals.desktop';

const cardOrder = (page: Page) => page.locator('[data-card-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-id')));
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

test.describe('Goals page layout (mock mode, layouts kept in this browser)', () => {
  test('customize, move a card, reload: the order persists; reset brings the default back', async ({ page }) => {
    await page.goto('/goals');
    await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Goal settings' })).toBeVisible();
    expect(await cardOrder(page)).toEqual(['goal-form', 'goal-results']);
    await expect(page.locator('[data-card-id="goal-form"]')).toHaveAttribute('data-width', 'third');
    await expect(page.locator('[data-card-id="goal-results"]')).toHaveAttribute('data-width', 'twothirds');
    expect(await stored(page)).toBeNull();

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Move Goal settings down' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(['goal-results', 'goal-form']);
    await expect.poll(() => stored(page)).toContain('"order":["goal-results","goal-form"]');

    await page.reload();
    await expect(page.getByRole('form', { name: 'Goal settings' })).toBeVisible();
    await expect.poll(() => cardOrder(page)).toEqual(['goal-results', 'goal-form']);

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => cardOrder(page)).toEqual(['goal-form', 'goal-results']);
    await expect.poll(() => stored(page)).toBeNull();
  });

  test('typed form values survive hiding and showing the form card', async ({ page }) => {
    await page.goto('/goals');
    const form = page.getByRole('form', { name: 'Goal settings' });
    const target = form.getByRole('textbox', { name: /^Target / });
    await expect(target).toBeVisible();
    await target.fill('123456');
    await expect(target).toHaveValue('123456');
    await expect(page.getByText('Preview of unsaved changes')).toBeVisible();

    await page.getByRole('button', { name: 'Customize layout' }).click();
    await page.getByRole('button', { name: 'Hide Goal settings' }).click();
    await expect(page.getByRole('form', { name: 'Goal settings' })).toHaveCount(0);
    await expect.poll(() => cardOrder(page)).toEqual(['goal-results']);

    await page.getByRole('button', { name: 'Show Goal settings' }).click();
    await expect(page.getByRole('form', { name: 'Goal settings' }).getByRole('textbox', { name: /^Target / })).toHaveValue('123456');
    await expect.poll(() => cardOrder(page)).toEqual(['goal-form', 'goal-results']);
  });
});
