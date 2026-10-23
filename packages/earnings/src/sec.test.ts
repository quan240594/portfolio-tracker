import { describe, expect, it } from 'vitest';
import { SecBlockedError, SecClient, SecError, SecNotFoundError, accessionPath, archiveCik, chooseDocuments, isSubrequestError, looksLikeResults, padCik, parseIndex, parseSubmissions, parseTickerMap, resultsFilings } from './sec.js';
import { FakeSec } from './testing/fake-sec.js';
import { BANK_RELEASE, FOREIGN_RELEASE, GENERIC_RELEASE } from './testing/fixtures.js';
import { htmlToText } from './text.js';

const UA = 'PortfolioTracker/1.0 (personal use; owner@example.invalid)';
const client = (sec: FakeSec, options: Partial<ConstructorParameters<typeof SecClient>[0]> = {}) => {
  let now = Date.parse('2026-10-21T19:30:00Z');
  return new SecClient({
    userAgent: UA,
    fetch: sec.fetch,
    now: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    ...options,
  });
};

describe('parsers', () => {
  it('pads and unpads CIKs and accessions', () => {
    expect(padCik('1000101')).toBe('0001000101');
    expect(padCik(320193)).toBe('0000320193');
    expect(archiveCik('0001000101')).toBe('1000101');
    expect(accessionPath('0001000101-26-000007')).toBe('000100010126000007');
  });

  it('parses the ticker table', () => {
    const map = parseTickerMap({ '0': { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' }, '1': { cik_str: '789019', ticker: 'MSFT', title: 'MICROSOFT CORP' }, '2': { cik_str: 1, ticker: 'AAPL', title: 'dup' }, '3': 'bad', '4': { ticker: '', cik_str: 5 } });
    expect([...map.keys()]).toEqual(['AAPL', 'MSFT']);
    expect(map.get('AAPL')).toEqual({ cik: '320193', title: 'Apple Inc.' });
    expect(() => parseTickerMap([])).toThrow(SecError);
    expect(() => parseTickerMap({})).toThrow('no entries');
  });

  it('parses submissions, skipping rows without a valid date and defaulting the report date', () => {
    const filings = parseSubmissions({
      filings: { recent: { accessionNumber: ['a-1', 'a-2', '', 'a-4'], filingDate: ['2026-10-21', 'bad', '2026-10-01', '2026-09-01'], reportDate: ['2026-10-20', '', '', ''], form: ['8-K', '8-K', '8-K', '6-K'], items: ['2.02, 9.01', '', '', ''], primaryDocument: ['x.htm', 'y.htm', 'z.htm', 'w.htm'] } },
    });
    expect(filings).toEqual([
      { accession: 'a-1', filingDate: '2026-10-21', reportDate: '2026-10-20', form: '8-K', items: ['2.02', '9.01'], primaryDocument: 'x.htm' },
      { accession: 'a-4', filingDate: '2026-09-01', reportDate: '2026-09-01', form: '6-K', items: [], primaryDocument: 'w.htm' },
    ]);
    expect(() => parseSubmissions({})).toThrow('no recent filings');
    expect(() => parseSubmissions({ filings: { recent: {} } })).toThrow(SecError);
    expect(parseSubmissions({ filings: { recent: { accessionNumber: ['a'] } } })).toEqual([]);
  });

  it('keeps 8-Ks with item 2.02 and every 6-K', () => {
    const base = { accession: 'a', filingDate: '2026-10-21', reportDate: '2026-10-21', primaryDocument: 'p' };
    const filings = [
      { ...base, form: '8-K', items: ['5.02'] },
      { ...base, form: '8-K', items: ['2.02', '9.01'] },
      { ...base, form: '6-K', items: [] },
      { ...base, form: '10-Q', items: ['2.02'] },
    ];
    expect(resultsFilings(filings).map((filing) => filing.form)).toEqual(['8-K', '6-K']);
  });

  it('parses the file list of a filing index', () => {
    expect(parseIndex({ directory: { item: [{ name: 'a.htm' }, { name: '' }, 'x', { name: 'b.jpg' }] } })).toEqual(['a.htm', 'b.jpg']);
    expect(() => parseIndex({})).toThrow('no file list');
  });
});

describe('chooseDocuments', () => {
  it('prefers exhibit 99.1 in its many spellings, then other 99.x, then the primary document for a 6-K', () => {
    expect(chooseDocuments(['primary.htm', 'ex99_1.htm', 'ex99_2.htm', 'logo.jpg'], 'primary.htm', '8-K')).toEqual(['ex99_1.htm', 'ex99_2.htm']);
    for (const name of ['lmt-20260930xex991.htm', 'd12345dex991.htm', 'ex99-1.htm', 'exhibit99.1.htm', 'a8-kex9912026.htm'.replace('9912026', '991')]) {
      expect(chooseDocuments(['primary.htm', name], 'primary.htm', '8-K')).toEqual([name]);
    }
    expect(chooseDocuments(['q.htm', 'ex-99.htm'], 'q.htm', '8-K')).toEqual(['ex-99.htm']);
    expect(chooseDocuments(['primary.htm', 'ex99_1.htm'], 'primary.htm', '6-K')).toEqual(['ex99_1.htm', 'primary.htm']);
  });

  it('falls back to the primary document only when no exhibit exists, and ignores non-documents', () => {
    expect(chooseDocuments(['primary.htm', 'x.jpg', 'x.xml'], 'primary.htm', '8-K')).toEqual(['primary.htm']);
    expect(chooseDocuments(['x.jpg'], '', '8-K')).toEqual([]);
    expect(chooseDocuments(['a.htm', 'ex9910.htm', 'ex99100.htm'], 'a.htm', '8-K')).toEqual(['ex9910.htm']);
  });
});

describe('looksLikeResults', () => {
  it('accepts a results release and rejects a cover page and short text', () => {
    expect(looksLikeResults(htmlToText(GENERIC_RELEASE.html))).toBe(true);
    expect(looksLikeResults(htmlToText(BANK_RELEASE.html))).toBe(true);
    expect(looksLikeResults('Item 2.02 Results of Operations. See Exhibit 99.1.')).toBe(false);
    expect(looksLikeResults(`${'The quarter revenue net income. '.repeat(10)}`)).toBe(false);
  });
});

describe('SecClient', () => {
  const sec = () => new FakeSec([{ release: GENERIC_RELEASE }, { release: FOREIGN_RELEASE }], { LMFG: { cik: 1000101, title: 'Lumen Forge Technologies Inc.' } });

  it('declares a User-Agent with contact information and accepts gzip on every request', async () => {
    const fake = sec();
    const c = client(fake);
    expect((await c.tickers()).get('LMFG')?.cik).toBe('1000101');
    expect((await c.submissions('1000101'))[0]!.accession).toBe(GENERIC_RELEASE.accession);
    expect(await c.fileNames('1000101', GENERIC_RELEASE.accession)).toContain('ex99_1.htm');
    expect(await c.document('1000101', GENERIC_RELEASE.accession, 'ex99_1.htm')).toContain('Lumen Forge');
    expect(fake.requests).toHaveLength(4);
    expect(fake.requests.every((request) => request.userAgent === UA && request.acceptEncoding?.includes('gzip'))).toBe(true);
    expect(fake.urls[1]).toBe('https://data.sec.gov/submissions/CIK0001000101.json');
    expect(fake.urls[2]).toBe('https://www.sec.gov/Archives/edgar/data/1000101/000100010126000007/index.json');
    expect(c.documentUrl('0001000101', GENERIC_RELEASE.accession, 'a b.htm')).toBe('https://www.sec.gov/Archives/edgar/data/1000101/000100010126000007/a%20b.htm');
  });

  it('treats 403 and 429 as blocked (with Retry-After), 404 as not found and other statuses as errors', async () => {
    const fake = sec();
    fake.forceStatus = 429;
    await expect(client(fake).tickers()).rejects.toMatchObject({ name: 'SecBlockedError', status: 429, retryAfterMs: 120_000 });
    fake.forceStatus = 403;
    await expect(client(fake).submissions('1')).rejects.toBeInstanceOf(SecBlockedError);
    fake.forceStatus = 500;
    await expect(client(fake).tickers()).rejects.toMatchObject({ name: 'SecError', status: 500 });
    fake.forceStatus = undefined;
    await expect(client(fake).submissions('999')).rejects.toBeInstanceOf(SecNotFoundError);
    await expect(client(fake).document('1000101', GENERIC_RELEASE.accession, 'missing.htm')).rejects.toBeInstanceOf(SecNotFoundError);
  });

  it('turns a network failure and a non-JSON body into SecError, but passes subrequest limits through', async () => {
    await expect(client(sec(), { fetch: () => Promise.reject(new Error('socket')) }).tickers()).rejects.toThrow('the request failed');
    const html = new FakeSec([], {});
    html.documents.set('x', 'x');
    await expect(client(html, { fetch: () => Promise.resolve(new Response('<html>', { status: 200 })) }).tickers()).rejects.toThrow('is not JSON');
    const limit = Object.assign(new Error('budget'), { name: 'SubrequestLimitError' });
    await expect(client(sec(), { fetch: () => Promise.reject(limit) }).tickers()).rejects.toBe(limit);
    expect(isSubrequestError(limit)).toBe(true);
    expect(isSubrequestError(new Error('x'))).toBe(false);
  });

  it('ignores an absurd Retry-After and caps a huge document', async () => {
    const big = client(sec(), { fetch: () => Promise.resolve(new Response('x'.repeat(2_600_000), { status: 200 })) });
    expect((await big.document('1', 'a-b-c', 'd.htm')).length).toBe(2_500_000);
    const odd = client(sec(), { fetch: () => Promise.resolve(new Response('no', { status: 429, headers: { 'retry-after': 'soon' } })) });
    await expect(odd.tickers()).rejects.toMatchObject({ retryAfterMs: undefined });
    const long = client(sec(), { fetch: () => Promise.resolve(new Response('no', { status: 429, headers: { 'retry-after': '999999' } })) });
    await expect(long.tickers()).rejects.toMatchObject({ retryAfterMs: 86_400_000 });
  });

  it('keeps under five requests per second: a burst waits for tokens', async () => {
    const sleeps: number[] = [];
    let now = 0;
    const fake = sec();
    const c = new SecClient({ userAgent: UA, fetch: fake.fetch, now: () => new Date(now), sleep: (ms) => { sleeps.push(ms); now += ms; return Promise.resolve(); } });
    for (let index = 0; index < 8; index++) await c.submissions('1000101');
    expect(sleeps.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(8);
    const duration = now;
    expect(8 / (duration / 1000 + 0.75)).toBeLessThanOrEqual(5);
  });
});
