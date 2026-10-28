import {
  ECB_INFLATION_TARGET_PCT,
  YIELD_PRESET_LABELS,
  type InflationBasis,
  type InflationSuggestion,
  type PortfolioGrowthBasis,
  type DividendGrowthSuggestion,
  type YieldBasis,
} from '@portfolio/shared';
import { formatDate, formatMoney, formatMonthYear, formatPercent } from '../../lib/format';

/** Text of a suggested number as the goal inputs show it (Dutch decimal comma, no thousands separator): `3,5`. */
export const inputText = (value: number): string => String(value).replace('.', ',');

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const years = (min: number, max: number): string => (min === max ? plural(min, 'full year') : `${min} to ${max} full years`);

/** "5 of 14 dividend-paying holdings (82% of your forward income), dividend per share over 2 to 4 full years". */
export function growthBasisText(basis: PortfolioGrowthBasis): string {
  if (basis.method === 'INCOME') {
    return `total dividends received, ${basis.fromYear} to ${basis.toYear} (${years(basis.minYears, basis.maxYears)}); this includes the effect of buying or selling shares`;
  }
  return `${basis.holdings} of ${plural(basis.payers, 'dividend-paying holding')} (${basis.coveragePct}% of your forward income), dividend per share over ${years(basis.minYears, basis.maxYears)}`;
}

/** Why no growth figure can be calculated, ending in what to do. */
export function growthUnavailableText(suggestion: Extract<DividendGrowthSuggestion, { available: false }>): string {
  if (suggestion.reason === 'NO_PAYERS') return 'No dividend-paying holdings yet, so there is nothing to calculate. Enter a value yourself.';
  return `Not enough history: ${suggestion.withHistory} of ${plural(suggestion.payers, 'dividend payer')} has a full year of dividends per share to compare. Enter a value yourself.`;
}

/** "Calculated 31,2%, limited to 30,0% (the range this field accepts)." when the range changed the figure; empty otherwise. */
export function clampText(rawPct: number, pct: number, clamped: boolean, digits: number): string {
  if (!clamped) return '';
  return `Calculated ${formatPercent(rawPct, { digits })}, limited to ${formatPercent(pct, { digits })} (the range this field accepts).`;
}

/** What a yield preset divides by what, with the figures of the user's portfolio. */
export function yieldBasisText(basis: YieldBasis, currency: string): string {
  const income = formatMoney(basis.forward12m, currency, { maxDigits: 0 });
  if (basis.preset === 'payers') return `forward 12-month income of ${income} divided by the market value of only the ${plural(basis.payers, 'holding')} that pay dividends`;
  if (basis.preset === 'cost') return `forward 12-month income of ${income} divided by what you paid for all holdings`;
  return `forward 12-month income of ${income} divided by the market value of all holdings, the Yield shown on the Dividends page`;
}

export const yieldPresetName = (basis: Pick<YieldBasis, 'preset'>): string => YIELD_PRESET_LABELS[basis.preset];

/** "average over the last 10 years (September 2016 to September 2026), compounded". */
export function inflationBasisText(basis: InflationBasis): string {
  return `average over the last ${plural(basis.years, 'year')} (${formatMonthYear(basis.fromMonth)} to ${formatMonthYear(basis.toMonth)}), compounded`;
}

export function inflationUnavailableText(suggestion: Extract<InflationSuggestion, { available: false }>): string {
  return `The ECB series covers only ${plural(suggestion.availableYears, 'full year')}: choose a shorter period or enter a value yourself.`;
}

export const ecbTargetText = `The ECB's medium-term target (${formatPercent(ECB_INFLATION_TARGET_PCT, { digits: 1 })}), a reference value, not a measurement.`;

/** "cached from 27-10-2026" for a stored series (the fetch date is read as a calendar date, so no time zone can shift it). */
export const cachedFromText = (fetchedAt: string): string => `cached from ${formatDate(fetchedAt.slice(0, 10))}`;
