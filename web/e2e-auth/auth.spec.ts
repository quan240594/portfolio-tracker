import { expect, test, type Page } from '@playwright/test';

const COGNITO = 'https://cognito-idp.eu-west-1.amazonaws.com/';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/** Answers every Cognito call with NotAuthorizedException and records the requests. */
async function rejectCognito(page: Page) {
  const calls: { target: string | undefined; body: string }[] = [];
  await page.route(COGNITO, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ target: request.headers()['x-amz-target'], body: request.postData() ?? '' });
    return route.fulfill({
      status: 400,
      headers: { ...CORS, 'content-type': 'application/x-amz-json-1.1' },
      body: JSON.stringify({ __type: 'NotAuthorizedException', message: 'Incorrect username or password.' }),
    });
  });
  return calls;
}

test.describe('Portfolio Tracker (Cognito build, signed out)', () => {
  test('shows the sign-in screen instead of the dashboard and calls no API', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname.startsWith('/api')) apiCalls.push(req.url());
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveTitle(/Sign in · Portfolio Tracker/);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByText('Demo mode')).toHaveCount(0);
    expect(apiCalls).toEqual([]);
  });

  test('guards deep links', async ({ page }) => {
    for (const path of ['/holdings', '/transactions', '/dividends', '/nope']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByRole('main').getByRole('heading', { name: 'Holdings' })).toHaveCount(0);
    }
  });

  test('signs in with SRP (the password is never sent) and shows a friendly error when rejected', async ({ page }) => {
    const calls = await rejectCognito(page);
    await page.goto('/');
    await page.getByLabel('Email').fill('me@example.com');
    await page.getByLabel('Password').fill('Sup3r-Secret-Pass!');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(calls[0]!.body).toContain('USER_SRP_AUTH');
    expect(calls[0]!.body).not.toContain('Sup3r-Secret-Pass!');
  });

  test('offers the forgot-password flow', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('me@example.com');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue('me@example.com');
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
