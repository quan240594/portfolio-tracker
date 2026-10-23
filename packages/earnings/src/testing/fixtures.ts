/**
 * INVENTED press releases for the tests: fictional companies, made-up numbers, six different layouts (generic tech, REIT, bank, SaaS,
 * infrastructure, a foreign issuer's 6-K exhibit). Each comes with the JSON a well-behaved model would extract from it. No real
 * company's text appears here.
 */
import type { KpiTemplateId } from '@portfolio/shared';

export interface FixtureRelease {
  symbol: string;
  name: string;
  template: KpiTemplateId;
  form: '8-K' | '6-K';
  cik: string;
  accession: string;
  filingDate: string;
  exhibit: string;
  html: string;
  /** What a faithful model extracts from `html`. */
  extraction: Record<string, unknown>;
}

const TABLE_STYLE = 'border="1" cellpadding="2"';

export const GENERIC_RELEASE: FixtureRelease = {
  symbol: 'LMFG',
  name: 'Lumen Forge Technologies',
  template: 'generic',
  form: '8-K',
  cik: '1000101',
  accession: '0001000101-26-000007',
  filingDate: '2026-10-21',
  exhibit: 'ex99_1.htm',
  html: `<html><head><title>Lumen Forge</title><style>.x{color:red}</style><script>var hidden = "revenue of $777 billion";</script></head><body>
<h1>Lumen Forge Reports Third Quarter 2026 Results</h1>
<p>Revenue of $4.82 billion, up 12% year over year; GAAP diluted EPS of $1.45; non-GAAP diluted EPS of $1.98</p>
<p>SAN JOSE, Calif., October 21, 2026 &mdash; Lumen Forge Technologies (NASDAQ: LMFG) today announced results for the quarter ended September 30, 2026.</p>
<p>&ldquo;We delivered a strong quarter with record cloud demand and expanded margins,&rdquo; said Dana Whitfield, chief executive officer.</p>
<ul><li>Operating income was $1.02 billion, or 21.2% of revenue.</li>
<li>Net cash provided by operating activities was $1.31 billion and capital expenditures were $310 million.</li>
<li>Record cloud demand lifted bookings across every region.</li>
<li>The board authorized a new $5 billion share repurchase program.</li></ul>
<h2>Outlook</h2>
<p>For fiscal year 2026, the company expects revenue between $18.9 billion and $19.1 billion.</p>
<p>(in millions, except per share data)</p>
<table ${TABLE_STYLE}>
<tr><th></th><th>Q3 2026</th><th>Q3 2025</th></tr>
<tr><td>Revenue</td><td>$&nbsp;4,820</td><td>$&nbsp;4,303</td></tr>
<tr><td>Operating income</td><td>1,022</td><td>905</td></tr>
<tr><td>Net income</td><td>1,098</td><td>940</td></tr>
<tr><td>GAAP diluted earnings per share</td><td>$1.45</td><td>$1.22</td></tr>
<tr><td>Non-GAAP diluted earnings per share</td><td>$1.98</td><td>$1.71</td></tr>
<tr><td>Diluted weighted-average shares</td><td>758</td><td>770</td></tr>
<tr><td>Net cash provided by operating activities</td><td>1,310</td><td>1,150</td></tr>
<tr><td>Purchases of property and equipment</td><td>(310)</td><td>(295)</td></tr>
</table>
<!-- internal note: revenue of $555 billion -->
<p>About Lumen Forge: Lumen Forge builds software and hardware for data centers. Forward-looking statements involve risks and uncertainties.</p>
</body></html>`,
  extraction: {
    period: 'Q3 2026',
    currency: 'USD',
    epsAdjusted: { value: '$1.98', yearAgo: '$1.71' },
    epsGaap: { value: '$1.45', yearAgo: '$1.22' },
    revenue: { value: '$4.82 billion', yearAgo: '4,303 million' },
    operatingIncome: { value: '$1.02 billion', yearAgo: '905 million' },
    netIncome: { value: '1,098 million', yearAgo: '940 million' },
    operatingCashFlow: { value: '$1.31 billion', yearAgo: '1,150 million' },
    capex: { value: '$310 million', yearAgo: '295 million' },
    dilutedShares: { value: '758 million', yearAgo: '770 million' },
    guidance: [{ label: 'Revenue fiscal year 2026', period: 'fiscal year 2026', low: '$18.9 billion', high: '$19.1 billion' }],
    keyUpdates: ['Record cloud demand lifted bookings across every region', 'The board authorized a new $5 billion share repurchase program'],
    quote: { text: 'We delivered a strong quarter with record cloud demand and expanded margins', speaker: 'Dana Whitfield, chief executive officer' },
  },
};

export const REIT_RELEASE: FixtureRelease = {
  symbol: 'HSRT',
  name: 'Harborstone Realty Trust',
  template: 'reit',
  form: '8-K',
  cik: '1000202',
  accession: '0001000202-26-000011',
  filingDate: '2026-10-22',
  exhibit: 'hsrt-20260930xex991.htm',
  html: `<html><body><div>
<div><b>HARBORSTONE REALTY TRUST ANNOUNCES THIRD QUARTER 2026 RESULTS</b></div>
<div>Third quarter revenue of $412.5 million, AFFO of $1.12 per diluted share, occupancy of 97.4%</div>
<div>DENVER, October 22, 2026 &ndash; Harborstone Realty Trust (NYSE: HSRT), a real estate investment trust, reported results for the quarter ended September 30, 2026.</div>
<div>Third quarter highlights:</div>
<div>Total revenue was $412.5 million compared with $389.0 million in the third quarter of 2025.</div>
<div>Nareit FFO was $1.08 per diluted share; AFFO was $1.12 per diluted share compared with $1.05 per diluted share a year ago.</div>
<div>Net income attributable to common stockholders was $0.31 per diluted share compared with $0.27 per diluted share.</div>
<div>Portfolio occupancy was 97.4% at quarter end. Same-store net operating income grew 3.1% over the prior-year quarter.</div>
<div>The company acquired three distribution properties for $210 million during the quarter.</div>
<div>2026 guidance: the company now expects AFFO of $4.38 to $4.44 per diluted share.</div>
<div>Revenues | $412.5 | $389.0</div>
<div>Property operating expenses | $118.7 | $112.4</div>
<div>General and administrative | $24.3 | $23.1</div>
<div>Net income | $64.2 | $55.9</div>
<div>Diluted weighted-average shares outstanding (in millions) | 207.1 | 207.0</div>
<div>Funds from operations per share | $1.08 | $1.01</div>
</div></body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    revenue: { value: '$412.5 million', yearAgo: '$389.0 million' },
    epsGaap: { value: '$0.31', yearAgo: '$0.27' },
    kpis: [
      { key: 'affoPerShare', value: '$1.12', yearAgo: '$1.05' },
      { key: 'ffoPerShare', value: '$1.08', yearAgo: '$1.01' },
      { key: 'occupancy', value: '97.4%' },
      { key: 'sameStoreNoi', value: '3.1%' },
    ],
    guidance: [{ label: '2026 guidance AFFO per diluted share', period: '2026', low: '$4.38', high: '$4.44' }],
    keyUpdates: ['The company acquired three distribution properties for $210 million'],
  },
};

export const BANK_RELEASE: FixtureRelease = {
  symbol: 'MTBC',
  name: 'Meridian Trust Bancorp',
  template: 'bank',
  form: '8-K',
  cik: '1000303',
  accession: '0001000303-26-000005',
  filingDate: '2026-10-15',
  exhibit: 'd45678dex991.htm',
  html: `<html><body>
<p><strong>Meridian Trust Bancorp Reports Third Quarter 2026 Earnings of $4.12 per Share</strong></p>
<p>Return on tangible common equity of 18.5%; CET1 capital ratio of 13.2%</p>
<p>CHARLOTTE, N.C. (October 15, 2026) &#8211; Meridian Trust Bancorp (NYSE: MTBC) reported third quarter 2026 net income of $1.9 billion, or $4.12 per diluted share, compared with $1.7 billion, or $3.70 per diluted share, in the third quarter of 2025.</p>
<p>Total net revenue was $5.2 billion. Net interest income was $3.1 billion compared with $2.9 billion a year ago. The efficiency ratio was 56.0%.</p>
<p>The provision for credit losses was $210 million compared with $180 million in the prior-year quarter.</p>
<p>Return on tangible common equity (ROTCE) was 18.5% compared with 17.1%. Tangible book value per share was $38.40, up from $34.90.</p>
<p>The Common Equity Tier 1 (CET1) capital ratio was 13.2%.</p>
<p>&quot;Our customers remained resilient and our balance sheet is strong,&quot; said Priya Raman, chair and chief executive officer.</p>
<p>(dollars in millions, except per share data)</p>
<table><tr><td>Net interest income</td><td>3,100</td><td>2,900</td></tr><tr><td>Noninterest income</td><td>2,100</td><td>2,050</td></tr><tr><td>Total net revenue</td><td>5,200</td><td>4,950</td></tr><tr><td>Provision for credit losses</td><td>210</td><td>180</td></tr><tr><td>Net income</td><td>1,900</td><td>1,700</td></tr><tr><td>Diluted earnings per share</td><td>$4.12</td><td>$3.70</td></tr></table>
</body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    epsGaap: { value: '$4.12', yearAgo: '$3.70' },
    revenue: { value: '$5.2 billion', yearAgo: '4,950 million' },
    netIncome: { value: '$1.9 billion', yearAgo: '$1.7 billion' },
    kpis: [
      { key: 'rotce', value: '18.5%', yearAgo: '17.1%' },
      { key: 'tbvps', value: '$38.40', yearAgo: '$34.90' },
      { key: 'cet1', value: '13.2%' },
      { key: 'netInterestIncome', value: '$3.1 billion', yearAgo: '$2.9 billion' },
      { key: 'efficiencyRatio', value: '56.0%' },
      { key: 'provisionForCreditLosses', value: '$210 million', yearAgo: '$180 million' },
    ],
    quote: { text: 'Our customers remained resilient and our balance sheet is strong', speaker: 'Priya Raman, chair and chief executive officer' },
  },
};

export const SAAS_RELEASE: FixtureRelease = {
  symbol: 'SKLN',
  name: 'Skylane Cloud',
  template: 'saas',
  form: '8-K',
  cik: '1000404',
  accession: '0001000404-26-000003',
  filingDate: '2026-10-20',
  exhibit: 'a2026q3ex991.htm',
  html: `<html><body>
<h2>Skylane Cloud Announces Third Quarter Fiscal 2027 Financial Results</h2>
<p>Total revenue of $1.64 billion, up 24% year over year. Remaining performance obligations of $6.2 billion.</p>
<ul>
<li>Subscription revenue grew 25% to $1.52 billion.</li>
<li>Remaining performance obligations (RPO) were $6.2 billion, and current RPO grew 22% year over year.</li>
<li>Net revenue retention rate was 118%.</li>
<li>Paid seats grew 17% year over year to 41 million.</li>
<li>Non-GAAP diluted EPS was $0.92 compared with $0.71 in the prior year.</li>
<li>Free cash flow was $412 million compared with $318 million in the third quarter of fiscal 2026.</li>
</ul>
<p>Operating cash flow was $455 million and capital expenditures were $43 million. Diluted weighted-average shares were 301 million.</p>
<p>Guidance for the fourth quarter of fiscal 2027: total revenue of $1.71 billion to $1.73 billion.</p>
<p>"Customers are standardizing on our platform," said Omar Haddad, chief executive officer.</p>
<p>Fiscal year 2027 quarter revenue table (in thousands): Total revenue 1,640,000 | 1,322,000. Operating income 266,000 | 198,000.</p>
</body></html>`,
  extraction: {
    period: 'Q3 fiscal 2027',
    currency: 'USD',
    epsAdjusted: { value: '$0.92', yearAgo: '$0.71' },
    revenue: { value: '$1.64 billion', yearAgo: '1,322,000 thousand' },
    operatingIncome: { value: '266,000 thousand', yearAgo: '198,000 thousand' },
    freeCashFlow: { value: '$412 million', yearAgo: '$318 million' },
    operatingCashFlow: { value: '$455 million' },
    capex: { value: '$43 million' },
    dilutedShares: { value: '301 million' },
    kpis: [
      { key: 'rpo', value: '$6.2 billion' },
      { key: 'crpo', value: '22%' },
      { key: 'nrr', value: '118%' },
      { key: 'seats', value: '17%' },
    ],
    guidance: [{ label: 'Total revenue fourth quarter of fiscal 2027', period: 'Q4 fiscal 2027', low: '$1.71 billion', high: '$1.73 billion' }],
    keyUpdates: ['Subscription revenue grew 25% to $1.52 billion'],
  },
};

export const INFRA_RELEASE: FixtureRelease = {
  symbol: 'IRBC',
  name: 'Ironbridge Compute',
  template: 'infra',
  form: '8-K',
  cik: '1000505',
  accession: '0001000505-26-000009',
  filingDate: '2026-10-23',
  exhibit: 'irbc_ex99-1.htm',
  html: `<html><body>
<center><b>IRONBRIDGE COMPUTE REPORTS RECORD THIRD QUARTER REVENUE</b></center>
<p>Revenue was $9.31 billion, up 38% year over year, led by cloud and data center demand.</p>
<p>AUSTIN, Texas, October 23, 2026 -- Ironbridge Compute Inc. (NASDAQ: IRBC) announced financial results for the third quarter ended September 30, 2026.</p>
<p>Cloud revenue was $3.90 billion, up 41% from a year ago. Remaining performance obligations reached $52.4 billion.</p>
<p>Diluted earnings per share were $2.30 (non-GAAP $2.62). Operating income was $2.71 billion.</p>
<p>Net cash provided by operating activities was $3.12 billion. Capital expenditures were $2.41 billion for the quarter.</p>
<p>Outlook: Revenue for the fourth quarter is expected to be $10.0 billion plus or minus 2%.</p>
<p>Diluted shares used in per share computation were 1,020 million.</p>
<p>Prior-year comparatives: revenue $6.75 billion, diluted earnings per share $1.54, cloud revenue $2.77 billion, operating income $1.89 billion.</p>
</body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    epsGaap: { value: '$2.30', yearAgo: '$1.54' },
    epsAdjusted: { value: '$2.62' },
    revenue: { value: '$9.31 billion', yearAgo: '$6.75 billion' },
    operatingIncome: { value: '$2.71 billion', yearAgo: '$1.89 billion' },
    operatingCashFlow: { value: '$3.12 billion' },
    capex: { value: '$2.41 billion' },
    dilutedShares: { value: '1,020 million' },
    kpis: [
      { key: 'rpo', value: '$52.4 billion' },
      { key: 'cloudRevenue', value: '$3.90 billion', yearAgo: '$2.77 billion' },
      { key: 'cloudGrowth', value: '41%' },
      { key: 'capexKpi', value: '$2.41 billion' },
    ],
    guidance: [{ label: 'Revenue fourth quarter', period: 'fourth quarter 2026', point: '$10.0 billion' }],
  },
};

export const FOREIGN_RELEASE: FixtureRelease = {
  symbol: 'NRDV.AS',
  name: 'Nordvik Instruments N.V.',
  template: 'generic',
  form: '6-K',
  cik: '1000606',
  accession: '0001000606-26-000002',
  filingDate: '2026-07-15',
  exhibit: 'nrdv-ex99_1.htm',
  html: `<html><body><pre>
NORDVIK INSTRUMENTS REPORTS SECOND QUARTER 2026 RESULTS

Veldhoven, the Netherlands, July 15, 2026 - Nordvik Instruments N.V. today published its results for the second quarter of 2026.

- Second quarter net sales of EUR 6.2 billion, net income of EUR 1.9 billion
- Diluted earnings per share of EUR 4.85, up from EUR 4.20 in the second quarter of 2025
- Gross margin of 52.0 percent; operating margin of 33.0 percent
- Net bookings of EUR 5.5 billion in the quarter, of which EUR 3.1 billion was for advanced systems

Outlook: For the third quarter of 2026, we expect net sales between EUR 6.4 billion and EUR 6.8 billion.

Amounts in EUR millions
Net sales                        6,200     5,540
Gross profit                     3,224     2,880
Operating income                 2,046     1,745
Net income                       1,900     1,610
Diluted EPS (EUR)                 4.85      4.20
</pre></body></html>`,
  extraction: {
    period: 'second quarter 2026',
    currency: 'EUR',
    epsGaap: { value: 'EUR 4.85', yearAgo: 'EUR 4.20' },
    revenue: { value: 'EUR 6.2 billion', yearAgo: '5,540 million' },
    operatingIncome: { value: '2,046 million', yearAgo: '1,745 million' },
    operatingMargin: { value: '33.0 percent' },
    netIncome: { value: 'EUR 1.9 billion', yearAgo: '1,610 million' },
    guidance: [{ label: 'Net sales third quarter of 2026', period: 'Q3 2026', low: 'EUR 6.4 billion', high: 'EUR 6.8 billion' }],
    keyUpdates: ['Net bookings of EUR 5.5 billion in the quarter'],
  },
};

export const ALL_RELEASES: readonly FixtureRelease[] = [GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE, SAAS_RELEASE, INFRA_RELEASE, FOREIGN_RELEASE];
