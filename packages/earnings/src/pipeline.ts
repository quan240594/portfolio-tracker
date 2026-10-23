/**
 * One release, end to end: find the press release document of a filing, turn it into text, extract the figures with Workers AI, verify them
 * against the text, add the EPS estimate, and derive the summary. Nothing here stores anything: the job decides what to do with the result.
 */
import type { EarningsHolding, EarningsSummary, EarningsOrigin } from '@portfolio/shared';
import type { TextExtractor } from './ai.js';
import { deriveSummary } from './derive.js';
import type { EstimateOutcome, EstimateSource } from './estimates.js';
import { chooseDocuments, looksLikeResults, type SecClient } from './sec.js';
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
  | { status: 'stored'; summary: EarningsSummary; estimate: EstimateOutcome['status'] | 'not-asked' }
  | { status: 'not-results' }
  | { status: 'unreadable'; reason: string; neurons: number }
  | { status: 'ai-allowance'; neurons: number }
  | { status: 'ai-error'; neurons: number };

/** The first of the candidate documents that reads like a results release, as text. */
async function releaseText(deps: PipelineDeps, ref: ReleaseRef): Promise<{ text: string; file: string } | undefined> {
  const names = await deps.sec.fileNames(ref.cik, ref.accession);
  for (const file of chooseDocuments(names, ref.primaryDocument, ref.form)) {
    const text = htmlToText(await deps.sec.document(ref.cik, ref.accession, file));
    if (looksLikeResults(text)) return { text, file };
  }
  return undefined;
}

/**
 * Reads the release of `ref`. `previous` is the newest stored summary of the symbol (for quarter-over-quarter). The SEC and the model are
 * called in sequence (a handful of subrequests); every failure is an outcome, only SEC blocks and subrequest limits are thrown.
 */
export async function processRelease(deps: PipelineDeps, ref: ReleaseRef, holding: EarningsHolding, previous: EarningsSummary | undefined): Promise<ReleaseOutcome> {
  const release = await releaseText(deps, ref);
  if (release === undefined) return { status: 'not-results' };
  const outcome = await deps.extractor.extract({ text: release.text, template: holding.template, company: holding.name });
  if (!outcome.ok) {
    if (outcome.reason === 'allowance') return { status: 'ai-allowance', neurons: outcome.neurons };
    if (outcome.reason === 'ai-error') return { status: 'ai-error', neurons: outcome.neurons };
    return { status: 'unreadable', reason: 'The model did not return valid JSON', neurons: outcome.neurons };
  }
  const { verified, dropped } = verifyExtraction(outcome.extraction, release.text, holding.template);
  if (!hasHeadline(verified)) return { status: 'unreadable', reason: 'No headline figure could be verified in the release', neurons: outcome.neurons };
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
  return { status: 'stored', summary, estimate: estimate?.status ?? 'not-asked' };
}
