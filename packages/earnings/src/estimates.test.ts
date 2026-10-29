import { describe, expect, it } from 'vitest';
import { DailyQuota, MemoryQuotaLedger } from '@portfolio/prices';
import { AlphaVantageEstimates, pickEstimate } from './estimates.js';

const quarters = {
  symbol: 'LMFG',
  quarterlyEarnings: [
    { fiscalDateEnding: '2026-06-30', reportedDate: '2026-07-22', reportedEPS: '1.80', estimatedEPS: '1.70', surprise: '0.1' },
    { fiscalDateEnding: '2026-09-30', reportedDate: '2026-10-22', reportedEPS: '1.98', estimatedEPS: '1.85' },
    { fiscalDateEnding: '2026-09-30', reportedDate: '2026-10-21', reportedEPS: 'None', estimatedEPS: '1.86' },
    { reportedDate: 'bad', estimatedEPS: '1' },
    { reportedDate: '2026-10-20', estimatedEPS: 'None' },
    'x',
  ],
};

const quota = (limit = 25) => new DailyQuota(new MemoryQuotaLedger(), 'alphavantage', limit, () => '2026-10-21');
const respond = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('pickEstimate', () => {
  it('takes the entry reported closest to the release date, within four days', () => {
    expect(pickEstimate(quarters, '2026-10-21')).toEqual({ estimate: 1.86 });
    expect(pickEstimate(quarters, '2026-10-23')).toEqual({ estimate: 1.85, reportedEps: 1.98 });
    expect(pickEstimate(quarters, '2026-11-30')).toBeUndefined();
    expect(pickEstimate({}, '2026-10-21')).toBeUndefined();
    expect(pickEstimate(null, '2026-10-21')).toBeUndefined();
  });
});

describe('AlphaVantageEstimates', () => {
  it('reports why there is no estimate without calling anything', async () => {
    const calls: string[] = [];
    const record = (url: string) => {
      calls.push(url);
      return respond(quarters)();
    };
    expect(await new AlphaVantageEstimates({ apiKey: undefined, fetch: record, quota: quota() }).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'no-key' });
    expect(await new AlphaVantageEstimates({ apiKey: '', fetch: record, quota: quota() }).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'no-key' });
    expect(await new AlphaVantageEstimates({ apiKey: 'k', fetch: record, quota: quota() }).epsEstimate('ASML.AS', '2026-10-21')).toEqual({ status: 'not-listed' });
    expect(await new AlphaVantageEstimates({ apiKey: 'k', fetch: record, quota: quota(0) }).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'quota' });
    expect(calls).toEqual([]);
  });

  it('spends one call of the shared daily quota and returns the estimate', async () => {
    const urls: string[] = [];
    const shared = quota(1);
    const source = new AlphaVantageEstimates({ apiKey: 'secret-key', fetch: (url) => { urls.push(url); return respond(quarters)(); }, quota: shared });
    expect(await source.epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'ok', estimate: { estimate: 1.86 } });
    expect(urls[0]).toContain('function=EARNINGS&symbol=LMFG');
    expect(await source.epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'quota' });
    expect(urls).toHaveLength(1);
  });

  it('answers no-entry, quota (AV notes), and error without throwing', async () => {
    const make = (fetch: (url: string) => Promise<Response>) => new AlphaVantageEstimates({ apiKey: 'k', fetch, quota: quota() });
    expect(await make(respond({ quarterlyEarnings: [] })).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'no-entry' });
    expect(await make(respond({ Information: 'rate limit' })).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'quota' });
    expect(await make(respond({}, 500)).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'error' });
    expect(await make(() => Promise.reject(new Error('net'))).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'error' });
    expect(await make(() => Promise.resolve(new Response('not json'))).epsEstimate('LMFG', '2026-10-21')).toEqual({ status: 'error' });
  });

  it('waits for the pacer before it sends', async () => {
    const events: string[] = [];
    const source = new AlphaVantageEstimates({
      apiKey: 'k',
      quota: quota(),
      fetch: () => {
        events.push('fetch');
        return respond(quarters)();
      },
      pace: () => {
        events.push('pace');
        return Promise.resolve(0);
      },
    });
    expect(await source.epsEstimate('LMFG', '2026-10-21')).toMatchObject({ status: 'ok' });
    expect(events).toEqual(['pace', 'fetch']);
  });

  it('passes a subrequest limit through', async () => {
    const limit = Object.assign(new Error('budget'), { name: 'SubrequestLimitError' });
    await expect(new AlphaVantageEstimates({ apiKey: 'k', fetch: () => Promise.reject(limit), quota: quota() }).epsEstimate('LMFG', '2026-10-21')).rejects.toBe(limit);
  });
});
