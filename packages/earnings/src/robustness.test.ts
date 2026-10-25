import { describe, expect, it } from 'vitest';
import { SecBlockedError, SecClient, chooseDocuments, headKeywordScore, isRateLimitPage, looksLikeResults, parseSubmissions } from './sec.js';
import { htmlToText } from './text.js';
import { FakeAi, type AiCall } from './testing/fake-ai.js';
import type { FilingSpec } from './testing/fake-sec.js';
import { FakeSec } from './testing/fake-sec.js';
import { GENERIC_RELEASE, type FixtureRelease } from './testing/fixtures.js';
import { earningsHarness, NOW, type EarningsHarness } from './testing/harness.js';
import { FOREIGN_TEXT_RELEASE } from './testing/messy-fixtures.js';

const client = (sec: FakeSec) => new SecClient({ userAgent: 'PortfolioTracker/1.0 (owner@example.invalid)', fetch: sec.fetch, now: () => NOW, sleep: () => Promise.resolve() });

describe('what EDGAR really sends', () => {
  it('the HTML "Request Rate Threshold" page with status 200 is a block, for JSON and for documents', async () => {
    const sec = new FakeSec([{ release: GENERIC_RELEASE }], { LMFG: { cik: 1000101, title: 'Lumen Forge' } });
    sec.rateLimitPage = true;
    await expect(client(sec).tickers()).rejects.toBeInstanceOf(SecBlockedError);
    await expect(client(sec).submissions('1000101')).rejects.toBeInstanceOf(SecBlockedError);
    await expect(client(sec).document('1000101', GENERIC_RELEASE.accession, 'ex99_1.htm')).rejects.toMatchObject({ status: 429 });
    expect(isRateLimitPage('<html>SEC.gov | Request Rate Threshold Exceeded</html>')).toBe(true);
    expect(isRateLimitPage(`${'x'.repeat(30_000)} Request Rate Threshold`)).toBe(false);
    expect(isRateLimitPage('<html>Quarterly results</html>')).toBe(false);
  });

  it('declares the User-Agent and accepts gzip on every request, and uses the archive path without dashes and without zero padding', async () => {
    const sec = new FakeSec([{ release: GENERIC_RELEASE }], { LMFG: { cik: 1000101, title: 'Lumen Forge' } });
    const sec1 = client(sec);
    await sec1.tickers();
    await sec1.submissions('1000101');
    await sec1.fileNames('0001000101', GENERIC_RELEASE.accession);
    expect(sec.urls).toEqual([
      'https://www.sec.gov/files/company_tickers.json',
      'https://data.sec.gov/submissions/CIK0001000101.json',
      'https://www.sec.gov/Archives/edgar/data/1000101/000100010126000007/index.json',
    ]);
    expect(sec.requests.every((request) => request.userAgent === 'PortfolioTracker/1.0 (owner@example.invalid)' && request.acceptEncoding?.includes('gzip'))).toBe(true);
  });

  it('a submissions list of a frequent 6-K filer is read beyond 200 filings', () => {
    const count = 450;
    const column = (make: (index: number) => string) => Array.from({ length: count }, (_, index) => make(index));
    const filings = parseSubmissions({ filings: { recent: { accessionNumber: column((index) => `0000000000-26-${String(index).padStart(6, '0')}`), filingDate: column(() => '2026-10-01'), reportDate: column(() => ''), form: column(() => '6-K'), items: column(() => ''), primaryDocument: column(() => 'a.htm') } } });
    expect(filings).toHaveLength(count);
  });
});

describe('finding the press release in a filing', () => {
  it('prefers exhibit 99.1, then other 99.x, then names that say press release or results, then the primary document', () => {
    expect(chooseDocuments(['primary.htm', 'q3-earnings-release.htm', 'R2.htm', 'FilingSummary.xml', '0001-index.htm', 'logo.jpg'], 'primary.htm', '8-K')).toEqual(['q3-earnings-release.htm']);
    expect(chooseDocuments(['primary.htm', 'a-ex992.htm', 'a-ex991.htm', 'press-release.htm'], 'primary.htm', '8-K')).toEqual(['a-ex991.htm', 'a-ex992.htm', 'press-release.htm']);
    expect(chooseDocuments(['cover.htm', 'misc.htm'], 'cover.htm', '8-K')).toEqual(['cover.htm']);
    expect(chooseDocuments(['cover.htm', 'results-q3.htm'], 'cover.htm', '6-K')).toEqual(['results-q3.htm', 'cover.htm']);
    expect(chooseDocuments(['a.htm', 'b-ex991.htm', 'c-ex992.htm', 'd-ex993.htm', 'e-ex994.htm', 'f-ex995.htm'], 'a.htm', '8-K')).toHaveLength(4);
  });

  it('a 6-K must show its results in its first 3,000 characters, an 8-K item 2.02 is trusted by its item', () => {
    const notice = `${'Notice of the extraordinary general meeting of shareholders to approve a resolution. '.repeat(50)}\nRevenue quarter net income ${Array.from({ length: 20 }, (_, index) => `${index}.5`).join(' ')} quarter revenue net income operating income`;
    expect(looksLikeResults(notice, '8-K')).toBe(true);
    expect(looksLikeResults(notice, '6-K')).toBe(false);
    expect(headKeywordScore(htmlToText(FOREIGN_TEXT_RELEASE.html))).toBeGreaterThanOrEqual(3);
    expect(looksLikeResults(htmlToText(FOREIGN_TEXT_RELEASE.html), '6-K')).toBe(true);
  });
});

function harness(release: FixtureRelease, extra: Partial<FilingSpec> = {}, options: Partial<Parameters<typeof earningsHarness>[0]> = {}): EarningsHarness {
  return earningsHarness({
    filings: [{ release, ...extra }],
    tickers: { [release.symbol]: { cik: Number(release.cik), title: release.name } },
    holdings: [{ symbol: release.symbol, name: release.name, template: release.template, currency: 'USD' }],
    calendar: { [release.symbol]: [release.filingDate] },
    ai: new FakeAi((call: AiCall) => (call.input.messages[1]!.content.includes(release.name) ? release.extraction : undefined)),
    ...options,
  });
}

const watch = async (h: EarningsHarness): Promise<void> => {
  await h.queue.enqueue({ job: 'watchEarnings', payload: { trigger: 'scheduled' } });
  await h.queue.drain();
};

describe('every outcome leaves a structured run on the symbol', () => {
  it('stored: stage ok with the filing, the dropped numbers and the neurons', async () => {
    const h = harness(GENERIC_RELEASE);
    await watch(h);
    expect((await h.repo.getState('LMFG'))!.lastRun).toEqual({ at: expect.any(String), stage: 'ok', detail: 'summary stored', filing: { form: '8-K', date: '2026-10-21', accession: GENERIC_RELEASE.accession }, droppedNumbers: 0, neurons: h.meter.spent });
  });

  it('the filing has no press release document at all: stage exhibit', async () => {
    const h = harness(GENERIC_RELEASE);
    h.sec.documents.set(GENERIC_RELEASE.exhibit, 'x');
    await h.repo.patchState('LMFG', { cik: '1000101' }, NOW);
    await h.queue.enqueue({ job: 'fetchEarningsSummary', payload: { symbol: 'LMFG', cik: '1000101', accession: GENERIC_RELEASE.accession, form: '8-K', filingDate: '2026-10-21', primaryDocument: 'primary.htm', origin: 'live' } });
    await h.queue.drain();
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'text', detail: expect.stringContaining('none reads like a results release') });
    expect(h.ai.calls).toHaveLength(0);
  });

  it('the filing index is not found or the SEC fails: stage exhibit with the reason, backed off', async () => {
    const h = harness(GENERIC_RELEASE, {}, {});
    await h.repo.patchState('LMFG', { cik: '1000101' }, NOW);
    await h.queue.enqueue({ job: 'fetchEarningsSummary', payload: { symbol: 'LMFG', cik: '1000101', accession: '0001000101-26-999999', form: '8-K', filingDate: '2026-10-21', primaryDocument: 'primary.htm', origin: 'live' } });
    await h.queue.drain();
    expect((await h.repo.getState('LMFG'))!).toMatchObject({ lastResult: 'failed', lastRun: { stage: 'exhibit', detail: 'The filing index was not found at the SEC' } });
  });

  it('the model reads nothing it can verify: stage verify with the count of dropped numbers', async () => {
    const h = harness(GENERIC_RELEASE, {}, { ai: new FakeAi({ revenue: { value: '$777 billion' }, epsGaap: { value: '$55.55' } }) });
    await watch(h);
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'verify', detail: 'no headline figure was found in the text (2 dropped)', droppedNumbers: 2 });
  });

  it('the model answers nothing usable: stage ai, invalid JSON', async () => {
    const h = harness(GENERIC_RELEASE, {}, { ai: new FakeAi({ raw: 'I am sorry' }) });
    await watch(h);
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'ai', detail: 'invalid JSON (no-json)', filing: { form: '8-K', date: '2026-10-21' } });
  });

  it('the daily allowance is used up: stage budget', async () => {
    const h = harness(GENERIC_RELEASE, {}, { allowance: 5 });
    await watch(h);
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'budget', detail: expect.stringContaining('00:00 UTC') });
  });

  it('the SEC blocks while reading: stage sec-blocked; a symbol the SEC does not know: stage ticker-map', async () => {
    const h = harness(GENERIC_RELEASE);
    await h.repo.patchState('LMFG', { cik: '1000101' }, NOW);
    await h.queue.enqueue({ job: 'fetchEarningsSummary', payload: { symbol: 'LMFG', cik: '1000101', accession: GENERIC_RELEASE.accession, form: '8-K', filingDate: '2026-10-21', primaryDocument: 'primary.htm', origin: 'live' } });
    h.sec.rateLimitPage = true;
    await h.queue.drain();
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'sec-blocked', detail: 'blocked by the SEC (HTTP 429)' });
    const unknown = earningsHarness({ filings: [], tickers: { OTHER: { cik: 5, title: 'Other Inc.' } }, holdings: [{ symbol: 'ZZZZ.AS', name: 'Zed', template: 'generic' }] });
    await watch(unknown);
    expect((await unknown.repo.getState('ZZZZ.AS'))!.lastRun).toMatchObject({ stage: 'ticker-map' });
  });

  it('the SEC list cannot be read: stage submissions', async () => {
    const h = harness(GENERIC_RELEASE);
    await h.repo.patchState('LMFG', { cik: '1000101' }, NOW);
    h.sec.forceStatus = 500;
    await watch(h);
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'submissions', detail: 'The submissions list: the SEC answered 500' });
  });
});
