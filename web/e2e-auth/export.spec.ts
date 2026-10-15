import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const CLIENT_ID = 'e2eclientid0123456789';
const COGNITO = 'https://cognito-idp.eu-west-1.amazonaws.com/';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const CSV = 'date,type,symbol,quantity,price,fee,currency,note,fxRate\n';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** An unsigned JWT: the app only decodes the payload (email, expiry) and forwards the token. */
const fakeJwt = (claims: object) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;

const ID_TOKEN = fakeJwt({ email: 'me@example.com', exp: 4_102_444_800, iat: 1_700_000_000 });
const ACCESS_TOKEN = fakeJwt({ username: 'me', exp: 4_102_444_800, iat: 1_700_000_000 });

/** A returning user: only the refresh token survives a reload, so the app exchanges it for fresh ID/access tokens. */
async function signedInSession(page: Page) {
  await page.addInitScript(
    ([clientId]) => {
      localStorage.setItem(`CognitoIdentityServiceProvider.${clientId}.LastAuthUser`, 'me');
      localStorage.setItem(`CognitoIdentityServiceProvider.${clientId}.me.refreshToken`, 'refresh-token');
    },
    [CLIENT_ID],
  );
  await page.route(COGNITO, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/x-amz-json-1.1' },
      body: JSON.stringify({ AuthenticationResult: { IdToken: ID_TOKEN, AccessToken: ACCESS_TOKEN, ExpiresIn: 3600, TokenType: 'Bearer' } }),
    });
  });
}

/** The API behind the Cognito build: an empty portfolio whose CSV export is recorded. */
async function fakeApi(page: Page, exportStatus: number) {
  const exports: (string | undefined)[] = [];
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/export/transactions') {
      exports.push(route.request().headers().authorization);
      if (exportStatus !== 200) return route.fulfill({ status: exportStatus, json: { error: { code: 'EXPORT_FAILED', message: 'Export is not available.' } } });
      return route.fulfill({ status: 200, contentType: 'text/csv', body: CSV });
    }
    if (pathname === '/api/portfolios') return route.fulfill({ json: { portfolios: [] } });
    if (pathname === '/api/transactions') return route.fulfill({ json: { transactions: [] } });
    return route.fulfill({ json: {} });
  });
  return exports;
}

test.describe('Portfolio Tracker (Cognito build, signed in)', () => {
  test('the CSV export sends the ID token and saves the file', async ({ page }) => {
    await signedInSession(page);
    const exports = await fakeApi(page, 200);
    await page.goto('/transactions');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).first().click()]);
    expect(download.suggestedFilename()).toBe('transactions-all.csv');
    expect(await readFile(await download.path(), 'utf8')).toBe(CSV);
    expect(exports).toEqual([`Bearer ${ID_TOKEN}`]);
  });

  test('a rejected export shows an error instead of saving an empty file', async ({ page }) => {
    await signedInSession(page);
    await fakeApi(page, 403);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.goto('/transactions');

    await page.getByRole('button', { name: 'Export CSV' }).first().click();
    await expect(page.getByRole('alert')).toHaveText('Export is not available.');
    expect(downloads).toEqual([]);
  });
});
