import { describe, expect, it } from 'vitest';
import type { EarningsHolding } from '@portfolio/shared';
import { BACKFILL_STEP_SUBREQUESTS } from './backfill.js';
import { FakeAi, type AiCall } from './testing/fake-ai.js';
import type { FilingSpec } from './testing/fake-sec.js';
import { GENERIC_RELEASE, type FixtureRelease } from './testing/fixtures.js';
import { earningsHarness } from './testing/harness.js';

interface Company {
  symbol: string;
  name: string;
  secTicker: string;
}

/** 20 US companies plus the listings the owner holds that need mapping: Xetra spellings and an Amsterdam listing of a foreign issuer. */
const COMPANIES: Company[] = [
  ...Array.from({ length: 20 }, (_, index): Company => ({ symbol: `US${String(index).padStart(2, '0')}`, name: `Company ${String(index).padStart(2, '0')} Inc.`, secTicker: `US${String(index).padStart(2, '0')}` })),
  { symbol: 'FOO.DE', name: 'Salesforce', secTicker: 'CRM' },
  { symbol: 'M4I.DE', name: 'Mastercard', secTicker: 'MA' },
  { symbol: 'NFC.DE', name: 'Netflix', secTicker: 'NFLX' },
  { symbol: 'ADB.DE', name: 'Adobe', secTicker: 'ADBE' },
  { symbol: 'ASML.AS', name: 'ASML Holding', secTicker: 'ASML' },
  { symbol: 'VWRL.L', name: 'Vanguard FTSE All-World UCITS ETF', secTicker: 'NONE' },
];

const DATES = ['2026-10-14', '2026-07-15', '2026-04-15', '2026-01-14', '2025-10-14'];

const releaseOf = (company: Company, index: number): FixtureRelease => ({
  ...GENERIC_RELEASE,
  symbol: company.symbol,
  name: company.name,
  cik: String(3_000_000 + index),
  accession: `000${3_000_000 + index}-26-000001`,
});

describe('the first run for a 26-company portfolio (owner scenario, fakes only)', () => {
  const eligible = COMPANIES.filter((company) => company.secTicker !== 'NONE');
  const releases = eligible.map((company, index) => releaseOf(company, index));
  const filings: FilingSpec[] = releases.flatMap((release) => DATES.map((date, index) => ({ release: { ...release, filingDate: date, accession: `${release.accession.slice(0, 14)}${String(900 + index).padStart(6, '0')}` } })));
  const holdings: EarningsHolding[] = COMPANIES.map((company) => ({ symbol: company.symbol, name: company.name, template: 'generic', currency: 'EUR' }));
  const tickers = Object.fromEntries(eligible.map((company, index) => [company.secTicker, { cik: 3_000_000 + index, title: company.name.toUpperCase() }]));
  const ai = () => new FakeAi((call: AiCall) => releases.find((release) => call.input.messages[1]!.content.includes(`Company: ${release.name}`))?.extraction);

  it('reads four quarters of every company that files with the SEC, within the daily allowance, over two days, silently', async () => {
    const h = earningsHarness({ filings, tickers, holdings, ai: ai(), allowance: 6000, env: { EARNINGS_BACKFILL_QUARTERS: '4' } });
    const steps: number[] = [];
    const original = h.registry.backfillEarnings!;
    h.registry.backfillEarnings = async (invocation) => {
      const before = h.sec.requests.length;
      const step = await original(invocation);
      steps.push(h.sec.requests.length - before);
      return step;
    };
    await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger: 'scheduled' } });
    await h.queue.drain();
    const first = await h.repo.getBackfill();
    expect(first).toMatchObject({ status: 'running', waitReason: 'allowance', quarters: 4, planned: 25, companies: 26 });
    expect(first!.stored).toBeGreaterThan(70);
    expect(h.meter.spent).toBeLessThanOrEqual(6000);
    const day1 = first!.stored;

    h.clock.advance(24 * 3_600_000);
    h.meter.spent = 0;
    await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger: 'scheduled' } });
    await h.queue.drain();
    const done = await h.repo.getBackfill();
    expect(done).toMatchObject({ status: 'complete', stored: 100, total: 100, failed: 0 });
    expect(done!.stored).toBeGreaterThan(day1);
    expect(Math.max(...steps)).toBeLessThanOrEqual(BACKFILL_STEP_SUBREQUESTS);
    // Every company has its four newest releases, the foreign listing and the Xetra spellings included.
    for (const company of eligible) expect((await h.repo.latest(company.symbol, 8)).map((summary) => summary.reportDate)).toEqual(DATES.slice(0, 4));
    // Older than 48 hours: all silent. Only the newest release of a company published within two days could notify.
    expect((await h.repo.latest('FOO.DE', 1))[0]).toMatchObject({ origin: 'backfill' });
    expect(h.queue.enqueued.filter((message) => message.job === 'notifyDividends')).toHaveLength(0);
    expect(await h.repo.getState('VWRL.L')).toMatchObject({ lastRun: { stage: 'ticker-map' } });
    expect(await h.repo.getState('FOO.DE')).toMatchObject({ cik: String(3_000_020), lastRun: { stage: 'ok' } });
    expect(await h.repo.getState('ASML.AS')).toMatchObject({ cik: String(3_000_024) });
  });
});
