import type { InstrumentProfile } from '@portfolio/shared';

/**
 * Optional company details of the demo instruments (description, ISIN, market cap, EPS, beta, P/E). Sample figures for the
 * demo only. ETFs carry no earnings figures and crypto has no profile details, like the real providers.
 */
export type AssetDetails = Pick<InstrumentProfile, 'description' | 'isin' | 'marketCap' | 'eps' | 'beta' | 'peRatio'>;

export const ASSET_DETAILS: Readonly<Record<string, AssetDetails>> = {
  AAPL: {
    description: 'Designs and sells consumer electronics, software and online services, from phones and laptops to subscriptions for music, storage and payments.',
    isin: 'US0378331005',
    marketCap: 3_450_000_000_000,
    eps: 6.42,
    beta: 1.24,
    peRatio: 35.6,
  },
  MSFT: {
    description: 'Builds business and consumer software, cloud infrastructure and gaming platforms, and sells them mostly as subscriptions.',
    isin: 'US5949181045',
    marketCap: 3_110_000_000_000,
    eps: 11.8,
    beta: 0.9,
    peRatio: 35.4,
  },
  KO: {
    description: 'Makes and distributes soft drinks, juices and bottled water, selling syrups and concentrates to a global network of bottlers.',
    isin: 'US1912161007',
    marketCap: 301_000_000_000,
    eps: 2.46,
    beta: 0.58,
    peRatio: 28.4,
  },
  JNJ: {
    description: 'Healthcare group with pharmaceuticals and medical devices, focused on oncology, immunology and surgery.',
    isin: 'US4781601046',
    marketCap: 381_000_000_000,
    eps: 5.1,
    beta: 0.52,
    peRatio: 31.1,
  },
  'ASML.AS': {
    description: 'Dutch maker of the lithography machines that print the finest circuit patterns on chips, supplying most of the world’s chip factories.',
    isin: 'NL0010273215',
    marketCap: 280_000_000_000,
    eps: 20.1,
    beta: 1.35,
    peRatio: 35.4,
  },
  'SAP.DE': {
    description: 'German developer of enterprise software for finance, supply chains and human resources, increasingly sold as cloud subscriptions.',
    isin: 'DE0007164600',
    marketCap: 270_000_000_000,
    eps: 3.9,
    beta: 1.05,
    peRatio: 59.5,
  },
  NVDA: {
    description: 'Designs graphics processors and the software around them, now mostly for data-centre computing and artificial intelligence.',
    isin: 'US67066G1040',
    marketCap: 3_220_000_000_000,
    eps: 2.53,
    beta: 1.7,
    peRatio: 51.9,
  },
  'VWRL.AS': {
    description: 'Distributing UCITS ETF that follows a global index of large and mid-sized companies in developed and emerging markets.',
    isin: 'IE00B3RBWM25',
  },
  'IWDA.AS': {
    description: 'Accumulating UCITS ETF that follows an index of large and mid-sized companies in developed markets.',
    isin: 'IE00B4L5Y983',
  },
};
