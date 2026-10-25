import { deriveSummary } from '../derive.js';
import { extractionSchema } from '../schema.js';
import { htmlToText } from '../text.js';
import { verifyExtraction } from '../verify.js';
import type { FixtureRelease } from './fixtures.js';

/** A release turned into its summary the way the pipeline does (no AI, no SEC): text, verification, derivation. */
export function buildReleaseSummary(release: FixtureRelease, now = new Date('2026-10-29T08:00:00.000Z')) {
  const text = htmlToText(release.html);
  const { verified, dropped } = verifyExtraction(extractionSchema.parse(release.extraction), text, release.template);
  const summary = deriveSummary({
    verified,
    dropped,
    symbol: release.symbol,
    name: release.name,
    template: release.template,
    filing: { url: 'https://www.sec.gov/Archives/edgar/data/1/1/x.htm', accession: release.accession, form: release.form, reportDate: release.filingDate },
    origin: 'live',
    model: 'test-model',
    neurons: 100,
    calls: 1,
    now,
  });
  return { text, verified, dropped, summary };
}
