/**
 * Which KPI template an earnings summary uses for a symbol: the owner's override first, then a short curated table of well-known
 * tickers, then the sector of the stored profile; everything else (and everything uncertain) is `generic`.
 *
 * Banks, SaaS and infrastructure names are only recognised by the table: a sector such as "Financial Services" also holds insurers
 * and brokers, and "Technology" holds everything from chips to hardware, so the sector alone would guess wrong.
 */
import { baseTicker } from './classification.js';
import { isKpiTemplateId, type KpiTemplateId } from './earnings.js';
import type { AssetClass } from './types.js';

const REIT = ['O', 'PLD', 'AMT', 'SPG', 'WELL', 'PSA', 'DLR', 'VICI', 'NNN', 'ADC', 'STAG', 'REXR', 'EXR', 'CCI', 'MAA', 'AVB', 'EQR', 'ARE', 'VTR', 'IRM', 'WPC', 'GLPI', 'KIM', 'REG', 'FR', 'EPRT'];
// The German (Xetra) spellings of US companies the owner holds are listed next to their tickers: FOO is Salesforce, ADB Adobe, CMC JPMorgan, MSF Microsoft, AMZ Amazon, ABEA Alphabet, NVD Nvidia.
const BANK = ['CMC', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC', 'TFC', 'BK', 'STT', 'FITB', 'KEY', 'RF', 'HBAN', 'MTB', 'CFG', 'COF', 'ALLY', 'ZION', 'CMA'];
const SAAS = ['FOO', 'ADB', 'CRM', 'NOW', 'ADBE', 'WDAY', 'SNOW', 'DDOG', 'TEAM', 'HUBS', 'ZM', 'DOCU', 'CRWD', 'NET', 'MDB', 'OKTA', 'TWLO', 'ZS', 'TTD', 'VEEV', 'PAYC', 'BILL', 'ESTC', 'GTLB', 'U', 'DBX', 'BOX', 'MNDY'];
const INFRA = ['MSF', 'AMZ', 'ABEA', 'NVD', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'ORCL', 'NVDA', 'AVGO', 'ANET', 'SMCI', 'DELL', 'CRWV', 'NBIS', 'VRT', 'EQIX', 'IBM', 'AKAM', 'FSLY', 'NTAP', 'PSTG', 'MU'];

const TABLE: ReadonlyMap<string, KpiTemplateId> = new Map([
  ...REIT.map((ticker): [string, KpiTemplateId] => [ticker, 'reit']),
  ...BANK.map((ticker): [string, KpiTemplateId] => [ticker, 'bank']),
  ...SAAS.map((ticker): [string, KpiTemplateId] => [ticker, 'saas']),
  ...INFRA.map((ticker): [string, KpiTemplateId] => [ticker, 'infra']),
]);

const REIT_SECTORS = new Set(['real estate', 'reits', 'reit']);

export interface KpiTemplateInput {
  symbol: string;
  assetClass?: AssetClass;
  sector?: string;
  /** The name of the instrument, used only when the asset class is not known. */
  name?: string;
  /** The owner's choice on the classification override. */
  override?: string;
}

const FUND_NAME = /\b(?:etf|etn|etc|fund|ucits|index|ishares|vanguard|spdr|xtrackers|amundi|lyxor|wisdomtree|vaneck|invesco|physical|bitcoin|ethereum|crypto)\b/i;

/**
 * Only companies report quarterly results: funds, crypto, bonds, cash and the like have no earnings. An instrument whose class is not
 * known (no profile yet, or the placeholder `OTHER`) counts when its name does not read like a fund: a missing profile must not hide a company.
 */
export function hasEarnings(assetClass: AssetClass | undefined, name?: string): boolean {
  if (assetClass === 'STOCK') return true;
  return (assetClass === undefined || assetClass === 'OTHER') && !FUND_NAME.test(name ?? '');
}

/** The template for the symbol, or `null` when the instrument has no earnings (an ETF, crypto, ...). */
export function kpiTemplateFor(input: KpiTemplateInput): KpiTemplateId | null {
  if (!hasEarnings(input.assetClass, input.name)) return null;
  if (isKpiTemplateId(input.override)) return input.override;
  const fromTable = TABLE.get(baseTicker(input.symbol));
  if (fromTable !== undefined) return fromTable;
  if (input.sector !== undefined && REIT_SECTORS.has(input.sector.trim().toLowerCase())) return 'reit';
  return 'generic';
}

/** Number of tickers in the curated table (for the documentation and its test). */
export const CURATED_TEMPLATE_TICKERS = TABLE.size;
