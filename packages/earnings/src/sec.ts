/**
 * The SEC's public EDGAR endpoints (free, keyless): the ticker to CIK table, a company's recent filings, a filing's file list and the
 * documents themselves. Fair-access rules (https://www.sec.gov/os/webmaster-faq#developers): every request declares a `User-Agent`
 * with contact information (the owner's `SEC_CONTACT`), at most about five requests per second (a token bucket here), gzip accepted,
 * and 403 or 429 means "slow down": the caller backs off for a long time instead of retrying.
 */
import { TokenBucket } from '@portfolio/prices';

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_CHARS = 2_500_000;
/** Capacity and refill of the token bucket: at most 4 requests per second, bursts of 3. */
const BUCKET_CAPACITY = 3;
const BUCKET_RATE_PER_SECOND = 4;
const BUCKET_MAX_WAIT_MS = 5000;

/** The SEC answered 403 or 429: stop for a long while. */
export class SecBlockedError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`The SEC answered ${status}`);
    this.name = 'SecBlockedError';
  }
}

/** Any other failure: a status code, a timeout, a body that is not what was expected. */
export class SecError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SecError';
  }
}

export class SecNotFoundError extends SecError {
  constructor(what: string) {
    super(`${what} was not found at the SEC`, 404);
    this.name = 'SecNotFoundError';
  }
}

export interface SecClientOptions {
  /** The complete `User-Agent` (the owner's `SEC_CONTACT`). */
  userAgent: string;
  /** The alarm's counted `fetch`. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface SecFiling {
  accession: string;
  filingDate: string;
  /** The filing's report date (for an 8-K the date of the event, i.e. the release). */
  reportDate: string;
  form: string;
  items: string[];
  primaryDocument: string;
}

export interface SecTicker {
  cik: string;
  title: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const padCik = (cik: string | number): string => String(cik).replace(/^0+/, '').padStart(10, '0');
export const archiveCik = (cik: string | number): string => String(Number(cik));
export const accessionPath = (accession: string): string => accession.replaceAll('-', '');

/** `company_tickers.json`: `{ "0": { cik_str, ticker, title }, ... }` into ticker (upper case) to CIK and company title. */
export function parseTickerMap(json: unknown): Map<string, SecTicker> {
  const map = new Map<string, SecTicker>();
  if (!isRecord(json)) throw new SecError('The ticker file is not an object');
  for (const entry of Object.values(json)) {
    if (!isRecord(entry)) continue;
    const ticker = text(entry.ticker).toUpperCase();
    const cik = entry.cik_str;
    if (ticker !== '' && (typeof cik === 'number' || typeof cik === 'string') && !map.has(ticker)) map.set(ticker, { cik: archiveCik(cik), title: text(entry.title) });
  }
  if (map.size === 0) throw new SecError('The ticker file has no entries');
  return map;
}

/** The recent filings of a submissions document, newest first (the SEC lists them that way). */
export function parseSubmissions(json: unknown): SecFiling[] {
  const recent = isRecord(json) && isRecord(json.filings) ? json.filings.recent : undefined;
  if (!isRecord(recent) || !Array.isArray(recent.accessionNumber)) throw new SecError('The submissions document has no recent filings');
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const [accession, filingDate, reportDate, form, items, primary] = ['accessionNumber', 'filingDate', 'reportDate', 'form', 'items', 'primaryDocument'].map(column);
  const filings: SecFiling[] = [];
  for (let index = 0; index < accession!.length && index < 200; index++) {
    const filed = text(filingDate![index]);
    if (text(accession![index]) === '' || !/^\d{4}-\d{2}-\d{2}$/.test(filed)) continue;
    const reported = text(reportDate![index]);
    filings.push({
      accession: text(accession![index]),
      filingDate: filed,
      reportDate: /^\d{4}-\d{2}-\d{2}$/.test(reported) ? reported : filed,
      form: text(form![index]),
      items: text(items![index])
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
      primaryDocument: text(primary![index]),
    });
  }
  return filings;
}

/** The filings that can be a results release: 8-Ks with item 2.02, and 6-Ks (which declare no items). */
export function resultsFilings(filings: readonly SecFiling[]): SecFiling[] {
  return filings.filter((filing) => (filing.form === '8-K' && filing.items.includes('2.02')) || filing.form === '6-K');
}

/** File names of a filing's `index.json`. */
export function parseIndex(json: unknown): string[] {
  const directory = isRecord(json) ? json.directory : undefined;
  const items = isRecord(directory) && Array.isArray(directory.item) ? directory.item : undefined;
  if (items === undefined) throw new SecError('The filing index has no file list');
  return items.map((item) => (isRecord(item) ? text(item.name) : '')).filter((name) => name !== '');
}

const DOCUMENT_EXTENSION = /\.(?:htm|html|txt)$/i;
const EXHIBIT_99 = /(?:ex|exhibit)[-_ ]?99(?:[-_.]?\d{1,2})?(?![0-9])/i;
const EXHIBIT_99_1 = /(?:ex|exhibit)[-_ ]?99[-_.]?0?1(?![0-9])/i;

/**
 * The files that can hold the press release, best first: exhibit 99.1, other 99.x exhibits, then the primary document. The file names of
 * exhibits vary by filer (`ex99_1.htm`, `lmt-20260930xex991.htm`, `d12345dex991.htm`); the text is checked afterwards anyway.
 */
export function chooseDocuments(names: readonly string[], primaryDocument: string, form: string): string[] {
  const documents = names.filter((name) => DOCUMENT_EXTENSION.test(name)).toSorted((a, b) => a.localeCompare(b));
  const first = documents.filter((name) => EXHIBIT_99_1.test(name));
  const others = documents.filter((name) => EXHIBIT_99.test(name) && !first.includes(name));
  const primary = primaryDocument !== '' && DOCUMENT_EXTENSION.test(primaryDocument) ? [primaryDocument] : [];
  return [...new Set([...first, ...others, ...(form === '6-K' || first.length + others.length === 0 ? primary : [])])].slice(0, 3);
}

/** A results release is never shorter than this (a cover page of an 8-K is). */
const MIN_RELEASE_CHARS = 700;
const RESULT_WORDS = /\b(?:revenues?|net sales|net income|earnings per share|operating income|operating profit|quarter)\b/gi;

/** A cheap deterministic check before any AI is spent: does this text read like a quarterly results release? */
export function looksLikeResults(releaseText: string): boolean {
  if (releaseText.length < MIN_RELEASE_CHARS) return false;
  const words = releaseText.match(RESULT_WORDS)?.length ?? 0;
  const figures = releaseText.match(/\d[\d,]*\.?\d*/g)?.length ?? 0;
  return words >= 4 && figures >= 12;
}

export class SecClient {
  readonly #options: SecClientOptions;
  readonly #bucket: TokenBucket;

  constructor(options: SecClientOptions) {
    this.#options = options;
    this.#bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_RATE_PER_SECOND, () => options.now().getTime(), options.sleep, BUCKET_MAX_WAIT_MS);
  }

  async tickers(): Promise<Map<string, SecTicker>> {
    return parseTickerMap(await this.#json(SEC_TICKERS_URL, 'The ticker list'));
  }

  async submissions(cik: string): Promise<SecFiling[]> {
    return parseSubmissions(await this.#json(`${SUBMISSIONS_BASE}/CIK${padCik(cik)}.json`, 'The submissions list'));
  }

  async fileNames(cik: string, accession: string): Promise<string[]> {
    return parseIndex(await this.#json(`${ARCHIVES_BASE}/${archiveCik(cik)}/${accessionPath(accession)}/index.json`, 'The filing index'));
  }

  /** URL of a file of a filing (also what the summary links to as its source). */
  documentUrl(cik: string, accession: string, file: string): string {
    return `${ARCHIVES_BASE}/${archiveCik(cik)}/${accessionPath(accession)}/${encodeURIComponent(file)}`;
  }

  async document(cik: string, accession: string, file: string): Promise<string> {
    const body = await this.#get(this.documentUrl(cik, accession, file), 'The document');
    return body.length > MAX_DOCUMENT_CHARS ? body.slice(0, MAX_DOCUMENT_CHARS) : body;
  }

  async #json(url: string, what: string): Promise<unknown> {
    const body = await this.#get(url, what);
    try {
      return JSON.parse(body);
    } catch {
      throw new SecError(`${what} is not JSON`);
    }
  }

  async #get(url: string, what: string): Promise<string> {
    await this.#bucket.acquire(1);
    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        headers: { 'User-Agent': this.#options.userAgent, 'Accept-Encoding': 'gzip, deflate', Accept: '*/*' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'follow',
      });
    } catch (error) {
      if (isSubrequestError(error)) throw error;
      throw new SecError(`${what}: the request failed`);
    }
    if (response.status === 403 || response.status === 429) throw new SecBlockedError(response.status, retryAfterMs(response));
    if (response.status === 404) throw new SecNotFoundError(what);
    if (!response.ok) throw new SecError(`${what}: the SEC answered ${response.status}`, response.status);
    return response.text();
  }
}

/** Running out of subrequests is the host's budget, not a problem with the SEC: it is passed on untouched. */
export const isSubrequestError = (error: unknown): boolean => error instanceof Error && error.name.startsWith('Subrequest');

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) * 1000 : undefined;
}
