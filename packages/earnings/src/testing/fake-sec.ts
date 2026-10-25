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
  /** More documents of the filing (name to HTML), listed in its index next to the exhibit. */
  files?: Record<string, string>;
  /** Defaults to `primary.htm` (a cover page that is no results release). */
  primaryDocument?: string;
}

/** A scripted SEC: the ticker table, submissions, filing indexes and documents of the fixture releases. No network, no timers. */
export class FakeSec {
  readonly requests: RecordedRequest[] = [];
  /** `{status}` answers every request with that status (403 and 429 are the SEC's "slow down"). */
  forceStatus: number | undefined;
  /** Answers every request with the SEC's HTML "Request Rate Threshold Exceeded" page and status 200. */
  rateLimitPage = false;
  /** Answers requests whose URL contains the key with that status (`index.json` to 404, for example). */
  readonly statusFor = new Map<string, number>();
  /** The next request whose URL contains `needle` fails with `error` (once), like the host's subrequest limit does. */
  readonly rejections: { needle: string; error: Error }[] = [];
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

  /** Answers a request as plain data (so a host with its own response type can wrap it) and records it. */
  handle(url: string, userAgent?: string, acceptEncoding?: string): PlainReply {
    this.requests.push({ url, userAgent, acceptEncoding });
    if (this.forceStatus !== undefined) return { status: this.forceStatus, body: 'blocked', headers: { 'retry-after': '120' } };
    for (const [needle, status] of this.statusFor) if (url.includes(needle)) return { status, body: 'error', headers: {} };
    if (this.rateLimitPage) return text('<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head><body><h1>Your Request Originates from an Undeclared Automated Tool</h1><p>To allow for equitable access to all users, SEC reserves the right to limit requests originating from undeclared automated tools.</p></body></html>');
    return this.route(url);
  }

  readonly fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const rejection = this.rejections.findIndex((entry) => url.includes(entry.needle));
    if (rejection !== -1) return Promise.reject(this.rejections.splice(rejection, 1)[0]!.error);
    const headers = new Headers(init?.headers);
    const reply = this.handle(url, headers.get('user-agent') ?? undefined, headers.get('accept-encoding') ?? undefined);
    return Promise.resolve(new Response(reply.body, { status: reply.status, headers: reply.headers }));
  };

  private route(url: string): PlainReply {
    if (url === 'https://www.sec.gov/files/company_tickers.json') return json(this.tickerTable());
    const submissions = /^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (submissions) return this.submissions(Number(submissions[1]));
    const archive = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/(.+)$/.exec(url);
    if (!archive) return notFound();
    const [, cik, accession, file] = archive;
    const spec = this.filings.find((candidate) => Number(candidate.release.cik) === Number(cik) && candidate.release.accession.replaceAll('-', '') === accession);
    if (!spec) return notFound();
    const extra = Object.keys(spec.files ?? {});
    const primary = spec.primaryDocument ?? 'primary.htm';
    if (file === 'index.json') return json({ directory: { name: `/Archives/edgar/data/${cik}/${accession}`, item: [primary, spec.release.exhibit, ...extra, 'image.jpg'].map((name) => ({ name, type: 'text.gif', size: '1000' })) } });
    const name = decodeURIComponent(file!);
    if (this.documents.has(name)) return text(this.documents.get(name)!);
    if (spec.files?.[name] !== undefined) return text(spec.files[name]);
    if (name === spec.release.exhibit) return text(spec.release.html);
    if (name === primary) return text('<html><body>Item 2.02 Results of Operations. See Exhibit 99.1.</body></html>');
    return notFound();
  }

  private tickerTable(): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    const entries = Object.entries(this.tickers);
    entries.forEach(([ticker, entry], index) => {
      table[String(index)] = { cik_str: entry.cik, ticker, title: entry.title };
    });
    return table;
  }

  private submissions(cik: number): PlainReply {
    const own = this.filings.filter((spec) => Number(spec.release.cik) === cik);
    if (own.length === 0) return notFound();
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
          primaryDocument: column((spec) => spec.primaryDocument ?? 'primary.htm'),
        },
      },
    });
  }
}

export interface PlainReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const json = (body: unknown): PlainReply => ({ status: 200, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const text = (body: string): PlainReply => ({ status: 200, body, headers: { 'content-type': 'text/html' } });
const notFound = (): PlainReply => ({ status: 404, body: 'not found', headers: {} });
