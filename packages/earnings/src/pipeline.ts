/**
 * One release, end to end: find the press release document of a filing, turn it into text, extract the figures with Workers AI, verify them
 * against the text, add the EPS estimate, and derive the summary. Nothing here stores anything: the job decides what to do with the result.
 * Every outcome names the stage it ended in (`EarningsRunStage`) and a short sanitised reason, which is what the Earnings page shows.
 */
import { sequentially, type EarningsHolding, type EarningsOrigin, type EarningsRunStage, type EarningsSummary } from '@portfolio/shared';
import type { TextExtractor } from './ai.js';
import { deriveSummary } from './derive.js';
import type { EstimateOutcome, EstimateSource } from './estimates.js';
import { SecError, chooseDocuments, looksLikeResults, type SecClient } from './sec.js';
import { htmlToText } from './text.js';
import { hasHeadline, verifyExtraction } from './verify.js';

export interface ReleaseRef {
  symbol: string;
  cik: string;
  accession: string;
  form: '8-K' | '6-K';
  /** The filing's report date: the release date shown to the user. */
  reportDate: string;
  primaryDocument: string;
  origin: EarningsOrigin;
}

export interface PipelineDeps {
  sec: Pick<SecClient, 'fileNames' | 'document' | 'documentUrl'>;
  extractor: TextExtractor;
  estimates?: EstimateSource;
  now: () => Date;
}

export type ReleaseOutcome =
  | { status: 'stored'; summary: EarningsSummary; estimate: EstimateOutcome['status'] | 'not-asked'; neurons: number; dropped: number }
  | { status: 'not-results'; stage: Extract<EarningsRunStage, 'exhibit' | 'text'>; detail: string }
  | { status: 'unreadable'; stage: Extract<EarningsRunStage, 'ai' | 'verify'>; reason: string; detail: string; neurons: number; dropped?: number }
  | { status: 'ai-allowance'; neurons: number }
  | { status: 'ai-error'; neurons: number; detail: string }
  | { status: 'sec-error'; stage: 'exhibit'; detail: string };

type ReleaseDocument = { text: string; file: string };

/** The first of the candidate documents that reads like a results release, as text; else how many were read (none is `0`). */
async function releaseText(deps: PipelineDeps, ref: ReleaseRef): Promise<ReleaseDocument | { read: number }> {
  const names = await deps.sec.fileNames(ref.cik, ref.accession);
  const candidates = chooseDocuments(names, ref.primaryDocument, ref.form);
  // One document after the other, stopping at the first that is a results release: each one is an SEC request.
  const read = async (file: string) => ({ file, text: htmlToText(await deps.sec.document(ref.cik, ref.accession, file)) });
  for await (const document of sequentially(candidates, read)) {
    if (looksLikeResults(document.text, ref.form)) return document;
  }
  return { read: candidates.length };
}

const sanitized = (message: string): string => message.replaceAll(/https?:\/\/\S+/gi, '').slice(0, 100);

/** The filing was found but holds no results release: no document at all, or documents that do not read like one. */
function notResults(read: number): ReleaseOutcome {
  if (read === 0) return { status: 'not-results', stage: 'exhibit', detail: 'the filing has no press release document' };
  return { status: 'not-results', stage: 'text', detail: `${read} document(s) read, none reads like a results release` };
}

type FailedExtraction = Extract<Awaited<ReturnType<PipelineDeps['extractor']['extract']>>, { ok: false }>;

/** The model call did not produce an extraction: the daily allowance, a platform error, or an answer that was not valid JSON. */
function failedExtraction(outcome: FailedExtraction): ReleaseOutcome {
  if (outcome.reason === 'allowance') return { status: 'ai-allowance', neurons: outcome.neurons };
  if (outcome.reason === 'ai-error') return { status: 'ai-error', neurons: outcome.neurons, detail: outcome.detail ?? 'the model call failed' };
  const why = outcome.detail === undefined ? '' : ` (${outcome.detail})`;
  return { status: 'unreadable', stage: 'ai', reason: 'The model did not return valid JSON', detail: `invalid JSON${why}`, neurons: outcome.neurons };
}

/**
 * Reads the release of `ref`. `previous` is the newest stored summary of the symbol older than the release (for quarter-over-quarter). The
 * SEC and the model are called in sequence (a handful of subrequests); every failure is an outcome, only SEC blocks and subrequest limits are thrown.
 */
export async function processRelease(deps: PipelineDeps, ref: ReleaseRef, holding: EarningsHolding, previous: EarningsSummary | undefined): Promise<ReleaseOutcome> {
  let release: ReleaseDocument | { read: number };
  try {
    release = await releaseText(deps, ref);
  } catch (error) {
    if (error instanceof SecError) return { status: 'sec-error', stage: 'exhibit', detail: sanitized(error.message) };
    throw error;
  }
  if (!('text' in release)) return notResults(release.read);
  const outcome = await deps.extractor.extract({ text: release.text, template: holding.template, company: holding.name });
  if (!outcome.ok) return failedExtraction(outcome);
  const { verified, dropped } = verifyExtraction(outcome.extraction, release.text, holding.template);
  if (!hasHeadline(verified)) {
    return { status: 'unreadable', stage: 'verify', reason: 'No headline figure could be verified in the release', detail: `no headline figure was found in the text (${dropped.length} dropped)`, neurons: outcome.neurons, dropped: dropped.length };
  }
  const wantsEstimate = verified.epsAdjusted !== undefined || verified.epsGaap !== undefined;
  const estimate = wantsEstimate && deps.estimates !== undefined ? await deps.estimates.epsEstimate(ref.symbol, ref.reportDate) : undefined;
  const summary = deriveSummary({
    verified,
    dropped,
    symbol: ref.symbol,
    name: holding.name,
    template: holding.template,
    filing: { url: deps.sec.documentUrl(ref.cik, ref.accession, release.file), accession: ref.accession, form: ref.form, reportDate: ref.reportDate },
    origin: ref.origin,
    fallbackCurrency: holding.currency,
    model: outcome.model,
    neurons: outcome.neurons,
    calls: outcome.calls,
    now: deps.now(),
    estimate: estimate?.status === 'ok' ? estimate.estimate : undefined,
    previous,
  });
  return { status: 'stored', summary, estimate: estimate?.status ?? 'not-asked', neurons: outcome.neurons, dropped: dropped.length };
}
