import type { ClassificationImportResponse, ClassificationInstrument, GetAllocationResponse } from '@portfolio/shared';
import { apiUrl } from '../api/client';
import { resetDb } from './db';

const call = (method: string, path: string, body?: unknown) =>
  fetch(apiUrl(path), { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const list = async () => ((await (await call('GET', '/classification')).json()) as { instruments: ClassificationInstrument[] }).instruments;
const slices = async (by: string) => ((await (await call('GET', `/allocation?by=${by}`)).json()) as GetAllocationResponse).slices;

describe('mock classification API (mirrors services/api)', () => {
  it('lists the held securities with the profile as effective and base values', async () => {
    const all = await list();
    expect(all.map((i) => i.symbol)).toEqual(all.map((i) => i.symbol).toSorted((a, b) => a.localeCompare(b)));
    expect(all.find((i) => i.symbol === 'AAPL')).toMatchObject({ source: 'provider', isin: 'US0378331005', currency: 'USD', override: null, held: true, updatedAt: null });
    expect(all.some((i) => i.symbol === 'NVDA')).toBe(false);
  });

  it('stores an override that wins in the list and in the allocation, and removes it again', async () => {
    const put = await call('PUT', '/classification/aapl', { sector: 'Invented Sector' });
    expect(put.status).toBe(200);
    expect((await put.json()) as ClassificationInstrument).toMatchObject({ symbol: 'AAPL', override: { sector: 'Invented Sector' }, effective: { sector: 'Invented Sector' }, base: { sector: 'Technology' } });
    expect((await slices('sector')).map((s) => s.key)).toContain('Invented Sector');

    expect((await call('DELETE', '/classification/AAPL')).status).toBe(204);
    expect((await list()).find((i) => i.symbol === 'AAPL')?.override).toBeNull();
    expect((await slices('sector')).map((s) => s.key)).not.toContain('Invented Sector');
  });

  it('lists an override of a symbol that is not held, and refuses unknown symbols and invalid bodies', async () => {
    await call('PUT', '/classification/NVDA', { country: 'Invented Land' });
    expect((await list()).find((i) => i.symbol === 'NVDA')).toMatchObject({ held: false, override: { country: 'Invented Land' } });
    expect((await call('PUT', '/classification/NOPE', { sector: 'X' })).status).toBe(404);
    expect((await call('PUT', '/classification/AAPL', {})).status).toBe(400);
    expect((await call('PUT', '/classification/AAPL', null)).status).toBe(400);
    expect((await call('DELETE', '/classification/NOPE')).status).toBe(204);
  });

  it('previews an import without storing, then stores the matched rows', async () => {
    const rows = [
      { ticker: 'AAPL', sector: 'Invented Sector' },
      { ticker: 'VWRL', isin: 'IE00INVENT01', country: 'Invented Land' },
      { ticker: 'ZZZZ', sector: 'Utilities' },
    ];
    const dry = (await (await call('POST', '/classification/import', { dryRun: true, rows })).json()) as ClassificationImportResponse;
    expect(dry).toMatchObject({ dryRun: true, applied: 0 });
    expect(dry.matched.map((m) => [m.symbol, m.matchedBy])).toEqual([['AAPL', 'ticker']]);
    expect(dry.unmatched.map((u) => [u.ticker, u.reason])).toEqual([['VWRL', 'isin-mismatch'], ['ZZZZ', 'not-held']]);
    expect((await list()).every((i) => i.override === null)).toBe(true);

    const applied = (await (await call('POST', '/classification/import', { dryRun: false, rows })).json()) as ClassificationImportResponse;
    expect(applied).toMatchObject({ dryRun: false, applied: 1 });
    expect((await list()).find((i) => i.symbol === 'AAPL')?.override).toEqual({ sector: 'Invented Sector' });
  });

  it('validates the import body', async () => {
    expect((await call('POST', '/classification/import', { dryRun: true, rows: [] })).status).toBe(400);
    expect((await call('POST', '/classification/import', null)).status).toBe(400);
  });

  it('forgets the overrides when the demo data is reset', async () => {
    await call('PUT', '/classification/AAPL', { sector: 'Invented Sector' });
    resetDb();
    expect((await list()).find((i) => i.symbol === 'AAPL')?.override).toBeNull();
  });
});
