import type { FixtureRelease } from './fixtures.js';

export interface RecordedRequest {
  url: string;
  userAgent: string | undefined;
  acceptEncoding: string | undefined;
}

export interface FilingSpec {
  release: FixtureRelease;
  /** Defaults to the release's `filingDate`. */
  reportDate?: string;
  /** Extra form types on the same submissions list, newest first. */
  items?: string;
}

/** A scripted SEC: the ticker table, submissions, filing indexes and documents of the fixture releases. No network, no timers. */
export class FakeSec {
  readonly requests: RecordedRequest[] = [];
  /** `{status}` answers every request with that status (403 and 429 are the SEC's "slow down"). */
  forceStatus: number | undefined;
  /** Replaces the body of a document by file name. */
  readonly documents = new Map<string, string>();
  private readonly filings: FilingSpec[];
  private readonly tickers: Record<string, { cik: number; title: string }>;

  constructor(filings: readonly FilingSpec[], tickers: Record<string, { cik: number; title: string }> = {}) {
    this.filings = [...filings];
    this.tickers = tickers;
  }

  addFiling(filing: FilingSpec): void {
    this.filings.unshift(filing);
  }

  get urls(): string[] {
    return this.requests.map((request) => request.url);
  }

  readonly fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    this.requests.push({ url, userAgent: headers.get('user-agent') ?? undefined, acceptEncoding: headers.get('accept-encoding') ?? undefined });
    if (this.forceStatus !== undefined) return Promise.resolve(new Response('blocked', { status: this.forceStatus, headers: { 'retry-after': '120' } }));
    return Promise.resolve(this.route(url));
  };

  private route(url: string): Response {
    if (url === 'https://www.sec.gov/files/company_tickers.json') return json(this.tickerTable());
    const submissions = /^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (submissions) return this.submissions(Number(submissions[1]));
    const archive = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/(.+)$/.exec(url);
    if (!archive) return new Response('not found', { status: 404 });
    const [, cik, accession, file] = archive;
    const spec = this.filings.find((candidate) => Number(candidate.release.cik) === Number(cik) && candidate.release.accession.replaceAll('-', '') === accession);
    if (!spec) return new Response('not found', { status: 404 });
    if (file === 'index.json') return json({ directory: { name: `/Archives/edgar/data/${cik}/${accession}`, item: [{ name: 'primary.htm', type: 'text.gif', size: '1000' }, { name: spec.release.exhibit, type: 'text.gif', size: '9000' }, { name: 'image.jpg', type: 'image.gif', size: '10' }] } });
    const name = decodeURIComponent(file!);
    if (this.documents.has(name)) return new Response(this.documents.get(name), { status: 200 });
    if (name === spec.release.exhibit) return new Response(spec.release.html, { status: 200 });
    if (name === 'primary.htm') return new Response('<html><body>Item 2.02 Results of Operations. See Exhibit 99.1.</body></html>', { status: 200 });
    return new Response('not found', { status: 404 });
  }

  private tickerTable(): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    const entries = Object.entries(this.tickers);
    entries.forEach(([ticker, entry], index) => {
      table[String(index)] = { cik_str: entry.cik, ticker, title: entry.title };
    });
    return table;
  }

  private submissions(cik: number): Response {
    const own = this.filings.filter((spec) => Number(spec.release.cik) === cik);
    if (own.length === 0) return new Response('not found', { status: 404 });
    const column = <T>(pick: (spec: FilingSpec) => T): T[] => own.map(pick);
    return json({
      cik: String(cik),
      filings: {
        recent: {
          accessionNumber: column((spec) => spec.release.accession),
          filingDate: column((spec) => spec.release.filingDate),
          reportDate: column((spec) => spec.reportDate ?? spec.release.filingDate),
          form: column((spec) => spec.release.form),
          items: column((spec) => spec.items ?? (spec.release.form === '8-K' ? '2.02,9.01' : '')),
          primaryDocument: column(() => 'primary.htm'),
        },
      },
    });
  }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
