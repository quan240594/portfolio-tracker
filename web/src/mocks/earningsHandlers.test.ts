import { server } from './server';
import { earningsHandlers } from './earningsHandlers';
import { apiUrl } from '../api/client';

describe('mock earnings API (the demo)', () => {
  beforeEach(() => server.use(...earningsHandlers));
  afterEach(() => sessionStorage.clear());

  it('answers status, list (newest first, limit, symbol filter) and a single summary', async () => {
    const status = await (await fetch(apiUrl('/earnings/status'))).json();
    expect(status).toMatchObject({ available: true, configured: true });

    const list = await (await fetch(apiUrl('/earnings'))).json();
    expect(list.summaries).toHaveLength(2);
    expect(list.symbols).toEqual([...list.symbols].sort((a: string, b: string) => a.localeCompare(b)));
    const [first, second] = list.summaries;
    expect(first.reportDate >= second.reportDate).toBe(true);

    const one = await (await fetch(apiUrl(`/earnings?symbol=${first.symbol.toLowerCase()}&limit=1`))).json();
    expect(one.summaries.map((s: { symbol: string }) => s.symbol)).toEqual([first.symbol]);

    const found = await fetch(apiUrl(`/earnings/${first.symbol}/${first.reportDate}`));
    expect((await found.json()).symbol).toBe(first.symbol);
    expect((await fetch(apiUrl('/earnings/NOPE/2026-01-01'))).status).toBe(404);
    expect((await fetch(apiUrl(`/earnings/${first.symbol}/refresh`), { method: 'POST' })).status).toBe(202);
  });

  it('serves one summary per KPI template when the Playwright flag is on', async () => {
    sessionStorage.setItem('earnings-demo-templates', 'on');
    const list = await (await fetch(apiUrl('/earnings'))).json();
    expect(list.summaries.map((s: { template: string }) => s.template).toSorted()).toEqual(['bank', 'generic', 'infra', 'reit', 'saas']);
  });
});
