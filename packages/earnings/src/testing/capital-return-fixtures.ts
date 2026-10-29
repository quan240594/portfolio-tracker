/**
 * INVENTED releases about dividends and share repurchases, written for the tests (fictional companies, made-up numbers; the wording is
 * original, no real release is copied): a REIT that raises its quarterly dividend and reports repurchases, a company with no dividend,
 * a repurchase-only company, a dividend cut, and a release worded messily (year-less dates, a rounded amount, no previous amount printed).
 * Each comes with the JSON a faithful model extracts from it.
 */
import type { FixtureRelease } from './fixtures.js';

export const DIVIDEND_RAISE_RELEASE: FixtureRelease = {
  symbol: 'MGPR',
  name: 'Meridian Gaming Properties',
  template: 'reit',
  form: '8-K',
  cik: '1000801',
  accession: '0001000801-26-000004',
  filingDate: '2026-10-28',
  exhibit: 'mgpr-20261028xex991.htm',
  html: `<html><body><div>
<div><b>MERIDIAN GAMING PROPERTIES ANNOUNCES THIRD QUARTER 2026 RESULTS AND INCREASES QUARTERLY DIVIDEND</b></div>
<div>Third quarter revenue of $1.02 billion, AFFO of $0.57 per diluted share, occupancy of 99.8%</div>
<div>LAS VEGAS, October 28, 2026 &ndash; Meridian Gaming Properties (NYSE: MGPR), a real estate investment trust, today reported results for the quarter ended September 30, 2026.</div>
<div>Third quarter highlights:</div>
<div>Total revenues were $1.02 billion compared with $0.96 billion in the third quarter of 2025.</div>
<div>AFFO was $0.57 per diluted share compared with $0.54 per diluted share a year ago. Nareit FFO was $0.55 per diluted share.</div>
<div>Net income attributable to common stockholders was $0.38 per diluted share compared with $0.35 per diluted share.</div>
<div>Portfolio occupancy was 99.8% at quarter end. Same-store net operating income grew 2.1% over the prior-year quarter.</div>
<div>Dividend: On October 27, 2026, the Board of Directors declared a quarterly dividend of $0.45 per common share, an increase of 4.7% over the prior quarter's dividend of $0.43 per share. The dividend is payable on January 15, 2027 to stockholders of record on January 2, 2027, the ex-dividend date.</div>
<div>Share repurchases: During the quarter the company repurchased 1.8 million shares of common stock for $120 million under its $1.0 billion share repurchase program. As of September 30, 2026, $880 million remained authorized under the program.</div>
<div>Revenues | $1,020.0 | $960.0</div>
<div>Property operating expenses | $84.4 | $80.1</div>
<div>Net income | $392.8 | $361.5</div>
<div>Diluted weighted-average shares outstanding (in millions) | 1,033.0 | 1,032.0</div>
</div></body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    revenue: { value: '$1.02 billion', yearAgo: '$0.96 billion' },
    epsGaap: { value: '$0.38', yearAgo: '$0.35' },
    kpis: [
      { key: 'affoPerShare', value: '$0.57', yearAgo: '$0.54' },
      { key: 'ffoPerShare', value: '$0.55' },
      { key: 'occupancy', value: '99.8%' },
      { key: 'sameStoreNoi', value: '2.1%' },
    ],
    dividend: { announced: true, perShare: '$0.45', previousPerShare: '$0.43', action: 'increased', frequency: 'quarterly', exDate: 'January 2, 2027', recordDate: 'January 2, 2027', payDate: 'January 15, 2027' },
    buyback: { mentioned: true, authorization: '$1.0 billion', repurchased: '$120 million', repurchasedShares: '1.8 million', remaining: '$880 million' },
  },
};

export const NO_DIVIDEND_RELEASE: FixtureRelease = {
  symbol: 'NGTI',
  name: 'Northgate Instruments',
  template: 'generic',
  form: '8-K',
  cik: '1000802',
  accession: '0001000802-26-000006',
  filingDate: '2026-10-22',
  exhibit: 'ngti-ex99.htm',
  html: `<html><body>
<h1>Northgate Instruments Reports Third Quarter 2026 Results</h1>
<p>Revenue of $2.31 billion, up 8% year over year; GAAP diluted EPS of $0.92; non-GAAP diluted EPS of $1.31</p>
<p>PORTLAND, Ore., October 22, 2026 &mdash; Northgate Instruments (NASDAQ: NGTI) today announced results for the quarter ended September 30, 2026.</p>
<ul><li>Operating income was $410 million, or 17.7% of revenue.</li>
<li>Net cash provided by operating activities was $520 million and capital expenditures were $140 million.</li>
<li>Orders grew in every region.</li></ul>
<p>(in millions, except per share data)</p>
<table border="1">
<tr><th></th><th>Q3 2026</th><th>Q3 2025</th></tr>
<tr><td>Revenue</td><td>$2,310</td><td>$2,139</td></tr>
<tr><td>Operating income</td><td>410</td><td>372</td></tr>
<tr><td>Net income</td><td>288</td><td>251</td></tr>
<tr><td>GAAP diluted earnings per share</td><td>$0.92</td><td>$0.80</td></tr>
<tr><td>Non-GAAP diluted earnings per share</td><td>$1.31</td><td>$1.18</td></tr>
<tr><td>Net cash provided by operating activities</td><td>520</td><td>470</td></tr>
<tr><td>Purchases of property and equipment</td><td>(140)</td><td>(133)</td></tr>
</table>
<p>About Northgate Instruments: the company builds measurement systems. Forward-looking statements involve risks and uncertainties.</p>
</body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    epsAdjusted: { value: '$1.31', yearAgo: '$1.18' },
    epsGaap: { value: '$0.92', yearAgo: '$0.80' },
    revenue: { value: '$2.31 billion', yearAgo: '$2,139 million' },
    operatingIncome: { value: '$410 million', yearAgo: '372' },
    netIncome: { value: '288 million', yearAgo: '251 million' },
    operatingCashFlow: { value: '$520 million', yearAgo: '470 million' },
    capex: { value: '$140 million', yearAgo: '133 million' },
  },
};

export const BUYBACK_ONLY_RELEASE: FixtureRelease = {
  symbol: 'BWOC',
  name: 'Brightwater Outdoor',
  template: 'generic',
  form: '8-K',
  cik: '1000803',
  accession: '0001000803-26-000008',
  filingDate: '2026-10-23',
  exhibit: 'bwoc-ex991.htm',
  html: `<html><body>
<h1>Brightwater Outdoor Reports Third Quarter 2026 Results and Announces New Share Repurchase Program</h1>
<p>Net sales of $3.05 billion, up 5%; diluted EPS of $2.40 compared with $2.15</p>
<p>BOISE, Idaho, October 23, 2026 &mdash; Brightwater Outdoor (NYSE: BWOC) reported results for the quarter ended September 30, 2026.</p>
<ul><li>Operating income was $530 million compared with $488 million.</li>
<li>Net income was $371 million, or $2.40 per diluted share.</li>
<li>The Board of Directors authorized a new $2.0 billion share repurchase program, which replaces the previous program. The company repurchased $350 million of its common stock in the quarter.</li></ul>
<p>(in millions, except per share data)</p>
<table border="1">
<tr><th></th><th>Q3 2026</th><th>Q3 2025</th></tr>
<tr><td>Net sales</td><td>$3,050</td><td>$2,905</td></tr>
<tr><td>Operating income</td><td>530</td><td>488</td></tr>
<tr><td>Net income</td><td>371</td><td>334</td></tr>
<tr><td>Diluted earnings per share</td><td>$2.40</td><td>$2.15</td></tr>
<tr><td>Net cash provided by operating activities</td><td>610</td><td>540</td></tr>
<tr><td>Purchases of property and equipment</td><td>(95)</td><td>(90)</td></tr>
</table>
</body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    epsGaap: { value: '$2.40', yearAgo: '$2.15' },
    revenue: { value: '$3.05 billion', yearAgo: '$2,905 million' },
    operatingIncome: { value: '$530 million', yearAgo: '$488 million' },
    netIncome: { value: '$371 million', yearAgo: '334 million' },
    buyback: { mentioned: true, authorization: '$2.0 billion', repurchased: '$350 million', action: 'new' },
  },
};

export const DIVIDEND_CUT_RELEASE: FixtureRelease = {
  symbol: 'CFEN',
  name: 'Coalfield Energy',
  template: 'generic',
  form: '8-K',
  cik: '1000804',
  accession: '0001000804-26-000002',
  filingDate: '2026-10-27',
  exhibit: 'cfen-ex991.htm',
  html: `<html><body>
<h1>Coalfield Energy Reports Third Quarter 2026 Results and Resets Dividend</h1>
<p>Revenue of $1.48 billion; net income of $96 million, or $0.41 per diluted share</p>
<p>TULSA, Okla., October 27, 2026 &mdash; Coalfield Energy (NYSE: CFEN) reported results for the quarter ended September 30, 2026.</p>
<ul><li>Revenue was $1.48 billion compared with $1.71 billion in the prior-year quarter.</li>
<li>Net income was $96 million compared with $188 million; diluted earnings per share were $0.41 compared with $0.80.</li>
<li>Operating income was $210 million. Net cash provided by operating activities was $330 million and capital expenditures were $240 million.</li>
<li>The Board declared a quarterly dividend of $0.30 per share, a reduction from the $0.60 per share paid in the prior quarter, payable on December 12, 2026 to shareholders of record as of November 20, 2026.</li></ul>
<p>(in millions, except per share data)</p>
<table border="1">
<tr><th></th><th>Q3 2026</th><th>Q3 2025</th></tr>
<tr><td>Revenue</td><td>$1,480</td><td>$1,710</td></tr>
<tr><td>Operating income</td><td>210</td><td>340</td></tr>
<tr><td>Net income</td><td>96</td><td>188</td></tr>
<tr><td>Diluted earnings per share</td><td>$0.41</td><td>$0.80</td></tr>
<tr><td>Net cash provided by operating activities</td><td>330</td><td>410</td></tr>
<tr><td>Purchases of property and equipment</td><td>(240)</td><td>(260)</td></tr>
</table>
</body></html>`,
  extraction: {
    period: 'third quarter 2026',
    currency: 'USD',
    epsGaap: { value: '$0.41', yearAgo: '$0.80' },
    revenue: { value: '$1.48 billion', yearAgo: '$1.71 billion' },
    operatingIncome: { value: '$210 million', yearAgo: '340' },
    netIncome: { value: '$96 million', yearAgo: '$188 million' },
    operatingCashFlow: { value: '$330 million', yearAgo: '410 million' },
    capex: { value: '$240 million', yearAgo: '260 million' },
    dividend: { announced: true, perShare: '$0.30', previousPerShare: '$0.60', action: 'reduced', frequency: 'quarterly', recordDate: 'November 20, 2026', payDate: 'December 12, 2026' },
  },
};

/** Year-less dates, an amount printed with four decimals, a share count with digits, no previous amount in the release. */
export const MESSY_CAPITAL_RELEASE: FixtureRelease = {
  symbol: 'HRTD',
  name: 'Heartland Distribution',
  template: 'generic',
  form: '8-K',
  cik: '1000805',
  accession: '0001000805-26-000009',
  filingDate: '2026-10-26',
  exhibit: 'hrtd-ex99.htm',
  html: `<html><body>
<p><b>HEARTLAND DISTRIBUTION REPORTS RESULTS FOR THE THIRD QUARTER OF 2026</b></p>
<p>OMAHA, Neb. (October 26, 2026) - Heartland Distribution (NYSE: HRTD) announced its results for the quarter ended September 30, 2026. Revenue was $4.10 billion and diluted earnings per share were $1.12 compared with $1.01 in the third quarter of 2025.</p>
<p>Operating income was $380 million versus $344 million. Net income was $210 million versus $190 million. Net cash provided by operating activities was $450 million.</p>
<p>Capital returns. The Board approved an increase in the regular quarterly cash dividend to $0.4500 per common share, payable January 15 to holders of record at the close of business on January 2.</p>
<p>In the quarter Heartland bought back 1,800,000 shares at an average price of $66.67 per share for a total of $120.0 million; approximately $880.0 million remained available under the repurchase program at quarter end.</p>
<p>Forward-looking statements involve risks. Quarter results are unaudited.</p>
<table><tr><td>Revenue</td><td>$4,100</td><td>$3,820</td></tr><tr><td>Net income</td><td>210</td><td>190</td></tr></table>
</body></html>`,
  extraction: {
    period: 'third quarter of 2026',
    currency: 'USD',
    revenue: { value: '$4.10 billion' },
    epsGaap: { value: '$1.12', yearAgo: '$1.01' },
    operatingIncome: { value: '$380 million', yearAgo: '$344 million' },
    netIncome: { value: '$210 million', yearAgo: '$190 million' },
    operatingCashFlow: { value: '$450 million' },
    dividend: { announced: true, perShare: '$0.4500', action: 'increase', frequency: 'quarterly', recordDate: 'January 2', payDate: 'January 15' },
    buyback: { mentioned: true, repurchased: '$120.0 million', repurchasedShares: '1,800,000 shares', remaining: '$880.0 million' },
  },
};

export const CAPITAL_RETURN_RELEASES: readonly FixtureRelease[] = [DIVIDEND_RAISE_RELEASE, NO_DIVIDEND_RELEASE, BUYBACK_ONLY_RELEASE, DIVIDEND_CUT_RELEASE, MESSY_CAPITAL_RELEASE];
