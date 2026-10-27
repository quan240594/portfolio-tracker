/** MSW handlers of /classification: the owner's overrides live in memory and feed the demo holdings, allocation and analytics. */
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  classificationImportSchema,
  classificationPutSchema,
  classificationValues,
  hasClassification,
  matchClassificationRows,
  sourceOf,
  type ClassificationImportResponse,
  type ClassificationInstrument,
  type ClassificationListResponse,
  type ClassificationTarget,
} from '@portfolio/shared';
import { ASSET_DETAILS } from './assetDetails';
import { effectiveProfiles, overridesOf, setOverride } from './classification-db';
import * as db from './db';
import { MockHttpError, api, guard, latency } from './utils';

/** Held securities (those with a profile; cash and custom assets are not classified here) and every symbol that has an override. */
function instruments(): ClassificationInstrument[] {
  const seed = db.getSeed();
  const overrides = overridesOf(seed);
  const effective = effectiveProfiles(seed);
  const held = new Set(db.getHoldings().holdings.map((h) => h.symbol).filter((symbol) => symbol in seed.profiles));
  const symbols = [...new Set([...held, ...overrides.keys()])].toSorted((a, b) => a.localeCompare(b));
  return symbols.map((symbol) => {
    const profile = seed.profiles[symbol];
    const stored = overrides.get(symbol);
    return {
      symbol,
      effective: classificationValues(effective[symbol], symbol),
      base: classificationValues(profile, symbol),
      source: profile === undefined ? 'none' : sourceOf(profile),
      isin: ASSET_DETAILS[symbol]?.isin ?? profile?.isin ?? null,
      currency: profile?.currency ?? null,
      override: stored?.fields ?? null,
      held: held.has(symbol),
      updatedAt: stored?.updatedAt ?? null,
    };
  });
}

const targetsOf = (list: readonly ClassificationInstrument[]): ClassificationTarget[] =>
  list.map((i) => ({ symbol: i.symbol, ...(i.isin === null ? {} : { isin: i.isin }), ...(i.currency === null ? {} : { currency: i.currency }), current: i.effective }));

function knownSymbol(raw: unknown): string {
  const symbol = String(raw).toUpperCase();
  if (!(symbol in db.getSeed().profiles)) throw new MockHttpError(404, 'NOT_FOUND', `No data for ${symbol}`);
  return symbol;
}

export const classificationHandlers: HttpHandler[] = [
  http.get(api('/classification'), async () => {
    await latency();
    return guard(() => HttpResponse.json<ClassificationListResponse>({ instruments: instruments() }))();
  }),

  http.post(api('/classification/import'), async ({ request }) => {
    await latency();
    return guard(async () => {
      const parsed = classificationImportSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid import', parsed.error.issues);
      const { dryRun, rows } = parsed.data;
      const { matched, unmatched } = matchClassificationRows(rows, targetsOf(instruments()));
      if (!dryRun) {
        const now = new Date().toISOString();
        for (const match of matched) setOverride(db.getSeed(), match.symbol, match.fields, now);
      }
      return HttpResponse.json<ClassificationImportResponse>({ dryRun, matched, unmatched, applied: dryRun ? 0 : matched.length });
    })();
  }),

  http.put(api('/classification/:symbol'), async ({ request, params }) => {
    await latency();
    return guard(async () => {
      const symbol = knownSymbol(params.symbol);
      const parsed = classificationPutSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid classification', parsed.error.issues);
      // Like the API: a body that only clears the price history symbol leaves nothing to override.
      if (hasClassification(parsed.data)) setOverride(db.getSeed(), symbol, parsed.data, new Date().toISOString());
      else overridesOf(db.getSeed()).delete(symbol);
      return HttpResponse.json<ClassificationInstrument>(instruments().find((i) => i.symbol === symbol)!);
    })();
  }),

  http.delete(api('/classification/:symbol'), async ({ params }) => {
    await latency();
    return guard(() => {
      overridesOf(db.getSeed()).delete(String(params.symbol).toUpperCase());
      return new HttpResponse(null, { status: 204 });
    })();
  }),
];
