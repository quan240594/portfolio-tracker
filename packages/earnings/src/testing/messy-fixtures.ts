/**
 * More INVENTED releases, messier than the first set: markup as real filing agents produce it (inline XBRL with a hidden header, layout tables
 * inside layout tables, signs and currency marks in cells of their own, `display:none` blocks, entities), figures in thousands and millions,
 * and a foreign issuer's 6-K in another layout. Fictional companies and made-up numbers; no real company's text appears here.
 */
import type { FixtureRelease } from './fixtures.js';

const HIDDEN_HEADER = `<div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="c1">0001000202</ix:nonNumeric><ix:nonNumeric name="dei:AmendmentFlag" contextRef="c1">false</ix:nonNumeric></ix:hidden>
<ix:references><link:schemaRef xlink:href="kd-20260930.xsd"/></ix:references>
<ix:resources><xbrli:context id="c1"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001000202</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:hidden>Revenues 999,999,999 EarningsPerShareDiluted 88.88 quarter results revenue net income</xbrli:hidden></ix:resources></ix:header></div>`;

/** Inline XBRL with a hidden header, nested layout tables, a table in thousands with signs split over cells. */
export const IXBRL_RELEASE: FixtureRelease = {
  symbol: 'KRNL',
  name: 'Kernel Dynamics',
  template: 'generic',
  form: '8-K',
  cik: '1000702',
  accession: '0001000702-26-000031',
  filingDate: '2026-10-28',
  exhibit: 'krnl-20261028xex991.htm',
  html: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><head><meta charset="utf-8"/><title>krnl-ex991</title>
<style type="text/css">.c1{font-family:Arial;font-size:10pt}.c2{display:none}td{padding:0}</style></head><body>${HIDDEN_HEADER}
<table style="width:100%"><tr><td style="width:5%">&#160;</td><td><div style="text-align:center"><span class="c1"><b>Kernel Dynamics Announces Fiscal Third Quarter 2026 Results</b></span></div>
<div class="c2" style="display:none"><p>Tracking pixel text: revenue of $999 billion, earnings per share of $77.00, net income quarter results</p></div>
<p><span class="c1">AUSTIN, Texas, October 28, 2026 &#8211; Kernel Dynamics (NASDAQ: KRNL) today reported results for the quarter ended September 30, 2026.</span></p>
<ul><li>Total revenue of <ix:nonFraction name="us-gaap:Revenues" contextRef="c1" unitRef="usd" decimals="-5" scale="6">$812.4 million</ix:nonFraction>, up 9% from the prior year</li>
<li>Net income of $96.2 million, or $0.62 per diluted share, compared with $0.55 per diluted share a year ago</li>
<li>Operating cash flow of $140.3 million for the quarter</li></ul>
<p>&#8220;Customers keep consolidating their build pipelines on our platform,&#8221; said Priya Natarajan, chief executive officer.</p>
<table><tr><td><table style="width:100%;border-collapse:collapse">
<tr><td colspan="4"><b>KERNEL DYNAMICS</b></td></tr><tr><td colspan="4">Condensed Consolidated Statements of Operations</td></tr>
<tr><td colspan="4">(in thousands, except per share amounts)</td></tr>
<tr><td>&#160;</td><td colspan="2">Three Months Ended September 30,</td><td>&#160;</td></tr>
<tr><td>&#160;</td><td>2026</td><td>2025</td><td>&#160;</td></tr>
<tr><td>Revenue</td><td>$</td><td>812,400</td><td>$</td><td>745,300</td></tr>
<tr><td>Operating income</td><td>&#160;</td><td>118,900</td><td>&#160;</td><td>101,250</td></tr>
<tr><td>Net income</td><td>$</td><td>96,200</td><td>$</td><td>85,100</td></tr>
<tr><td>Diluted earnings per share</td><td>$</td><td>0.62</td><td>$</td><td>0.55</td></tr>
<tr><td>Weighted-average diluted shares</td><td>&#160;</td><td>155,100</td><td>&#160;</td><td>154,700</td></tr>
<tr><td>Net cash provided by operating activities</td><td>&#160;</td><td>140,300</td><td>&#160;</td><td>122,900</td></tr>
<tr><td>Purchases of property and equipment</td><td>&#160;</td><td>(</td><td>31,200</td><td>)</td><td>&#160;</td><td>(</td><td>28,400</td><td>)</td></tr>
</table></td></tr></table>
<p><span class="c1">Forward-looking statements involve risks. This release is a company statement of quarterly results.</span></p></td></tr></table></body></html>`,
  extraction: {
    period: 'fiscal third quarter 2026',
    currency: 'USD',
    revenue: { value: '$812.4 million', yearAgo: '745,300 thousand' },
    operatingIncome: { value: '118,900 thousand', yearAgo: '101,250 thousand' },
    netIncome: { value: '$96.2 million', yearAgo: '85,100 thousand' },
    epsGaap: { value: '$0.62', yearAgo: '$0.55' },
    dilutedShares: { value: '155,100 thousand', yearAgo: '154,700 thousand' },
    operatingCashFlow: { value: '$140.3 million', yearAgo: '122,900 thousand' },
    capex: { value: '31,200 thousand', yearAgo: '28,400 thousand' },
    keyUpdates: ['Customers keep consolidating their build pipelines on our platform'],
    quote: { text: 'Customers keep consolidating their build pipelines on our platform', speaker: 'Priya Natarajan, chief executive officer' },
  },
};

/** A foreign issuer's 6-K in a different layout: a plain-text press release in a `pre` block, euro amounts in prose, no tables. */
export const FOREIGN_TEXT_RELEASE: FixtureRelease = {
  symbol: 'DSVX.AS',
  name: 'Delft Semiconductor Systems N.V.',
  template: 'generic',
  form: '6-K',
  cik: '1000703',
  accession: '0001000703-26-000012',
  filingDate: '2026-10-14',
  exhibit: 'dsvx_pressrelease_q3.htm',
  html: `<html><body><pre>
DELFT SEMICONDUCTOR SYSTEMS REPORTS THIRD QUARTER 2026 RESULTS

Q3 net sales of EUR 7.12 billion, net income of EUR 2.05 billion
Gross margin 51.8 percent; net bookings EUR 5.4 billion

DELFT, the Netherlands, October 14, 2026 - Delft Semiconductor Systems N.V. (Euronext Amsterdam and Nasdaq: DSVX) today published its results
for the third quarter ended September 27, 2026.

- Net sales were EUR 7.12 billion, compared with EUR 6.55 billion in the third quarter of 2025.
- Net income was EUR 2.05 billion, compared with EUR 1.88 billion in the third quarter of 2025.
- Earnings per share (diluted) was EUR 5.21, compared with EUR 4.76 in the third quarter of 2025.
- Operating income was EUR 2.61 billion, or 36.7 percent of net sales.

"Demand for our lithography platforms remained resilient across every customer segment," said the chief executive officer.

Outlook: we expect fourth quarter 2026 net sales between EUR 7.2 billion and EUR 7.6 billion.

About Delft Semiconductor Systems: the company builds chip manufacturing equipment. Statements about the future involve risk.
</pre></body></html>`,
  extraction: {
    period: 'Q3 2026',
    currency: 'EUR',
    revenue: { value: 'EUR 7.12 billion', yearAgo: 'EUR 6.55 billion' },
    netIncome: { value: 'EUR 2.05 billion', yearAgo: 'EUR 1.88 billion' },
    epsGaap: { value: 'EUR 5.21', yearAgo: 'EUR 4.76' },
    operatingIncome: { value: 'EUR 2.61 billion' },
    operatingMargin: { value: '36.7 percent' },
    guidance: [{ label: 'Net sales fourth quarter 2026', period: 'fourth quarter 2026', low: 'EUR 7.2 billion', high: 'EUR 7.6 billion' }],
    keyUpdates: ['Demand for our lithography platforms remained resilient across every customer segment'],
  },
};

/** A bank in inline XBRL: millions, parentheses and dollar signs in cells of their own, a CET1 ratio in prose. */
export const IXBRL_BANK_RELEASE: FixtureRelease = {
  symbol: 'BKNL',
  name: 'Bankone National Corporation',
  template: 'bank',
  form: '8-K',
  cik: '1000704',
  accession: '0001000704-26-000044',
  filingDate: '2026-10-14',
  exhibit: 'bknl-20261014xex991.htm',
  html: `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><body>${HIDDEN_HEADER}
<div><b>Bankone National Corporation Reports Third Quarter 2026 Net Income of $13.4 billion</b></div>
<p>NEW YORK, October 14, 2026 - Bankone National Corporation (NYSE: BKNL) reported third quarter 2026 results.</p>
<p>Third quarter net revenue of $46.2 billion, net income of $13.4 billion and earnings per share of $4.69, compared with $4.37 a year ago. Return on tangible common equity was 21% and the CET1 capital ratio was 15.3%.</p>
<table><tr><td>(in millions, except per share data)</td><td>3Q26</td><td>3Q25</td></tr>
<tr><td>Net revenue</td><td>$</td><td>46,210</td><td>$</td><td>42,650</td></tr>
<tr><td>Net interest income</td><td>$</td><td>24,100</td><td>$</td><td>23,350</td></tr>
<tr><td>Provision for credit losses</td><td>$</td><td>2,780</td><td>$</td><td>3,100</td></tr>
<tr><td>Net income</td><td>$</td><td>13,400</td><td>$</td><td>12,900</td></tr>
<tr><td>Diluted earnings per share</td><td>$</td><td>4.69</td><td>$</td><td>4.37</td></tr>
<tr><td>Return on tangible common equity</td><td></td><td>21</td><td>%</td><td>20</td><td>%</td></tr></table>
<p>&#8220;The franchise delivered another quarter of solid growth across lending and payments,&#8221; said the chairman and chief executive officer.</p>
<p>Results for the quarter include the effect of a reserve release.</p></body></html>`,
  extraction: {
    period: '3Q26',
    currency: 'USD',
    revenue: { value: '$46.2 billion', yearAgo: '42,650 million' },
    netIncome: { value: '$13.4 billion', yearAgo: '12,900 million' },
    epsGaap: { value: '$4.69', yearAgo: '$4.37' },
    kpis: [
      { key: 'cet1', value: '15.3%' },
      { key: 'rotce', value: '21%', yearAgo: '20%' },
    ],
    keyUpdates: ['The franchise delivered another quarter of solid growth across lending and payments'],
  },
};

/** A REIT whose tables are in thousands, with FFO and AFFO per share in the prose and in a table of its own. */
export const MESSY_REIT_RELEASE: FixtureRelease = {
  symbol: 'MPLR',
  name: 'Meridian Plaza Realty',
  template: 'reit',
  form: '8-K',
  cik: '1000705',
  accession: '0001000705-26-000019',
  filingDate: '2026-10-27',
  exhibit: 'ex99_1.htm',
  html: `<html><body><center><font size="2"><b>MERIDIAN PLAZA REALTY ANNOUNCES THIRD QUARTER 2026 RESULTS</b></font></center>
<p><font size="2">Third quarter revenues were $412.8 million, net income attributable to common stockholders was $104.6 million, or $0.43 per diluted share. Funds from operations (FFO) were $1.52 per diluted share and adjusted FFO (AFFO) was $1.47 per diluted share, compared with $1.40 a year ago. Same-property net operating income grew 3.1%. Occupancy was 96.4% at quarter end.</font></p>
<p><font size="2">The board raised the regular quarterly dividend by 4%.</font></p>
<table width="100%"><tr><td colspan="3">(amounts in thousands, except per share data)</td></tr>
<tr><td></td><td>Q3 2026</td><td>Q3 2025</td></tr>
<tr><td>Total revenues</td><td>$412,800</td><td>$388,150</td></tr>
<tr><td>Net income attributable to common stockholders</td><td>$104,600</td><td>$96,300</td></tr>
<tr><td>Diluted earnings per share</td><td>$0.43</td><td>$0.40</td></tr>
<tr><td>FFO per diluted share</td><td>$1.52</td><td>$1.44</td></tr>
<tr><td>AFFO per diluted share</td><td>$1.47</td><td>$1.40</td></tr>
<tr><td>Occupancy</td><td>96.4%</td><td>95.8%</td></tr></table>
<p><font size="2">Guidance: AFFO per diluted share for 2026 of $5.80 to $5.88.</font></p></body></html>`,
  extraction: {
    period: 'Q3 2026',
    currency: 'USD',
    revenue: { value: '$412.8 million', yearAgo: '$388,150 thousand' },
    netIncome: { value: '$104.6 million', yearAgo: '96,300 thousand' },
    epsGaap: { value: '$0.43', yearAgo: '$0.40' },
    kpis: [
      { key: 'ffoPerShare', value: '$1.52', yearAgo: '$1.44' },
      { key: 'affoPerShare', value: '$1.47', yearAgo: '$1.40' },
      { key: 'occupancy', value: '96.4%', yearAgo: '95.8%' },
    ],
    guidance: [{ label: 'AFFO per diluted share 2026', period: '2026', low: '$5.80', high: '$5.88' }],
  },
};

/** A SaaS release with spans around every number and a "billion" in prose only, no tables. */
export const PROSE_SAAS_RELEASE: FixtureRelease = {
  symbol: 'CLDM',
  name: 'Cloudmesh Software',
  template: 'saas',
  form: '8-K',
  cik: '1000706',
  accession: '0001000706-26-000008',
  filingDate: '2026-10-22',
  exhibit: 'd9981dex991.htm',
  html: `<html><body><h1>Cloudmesh Software Reports Third Quarter Fiscal 2027 Results</h1>
<p>Total revenue was <span>$</span><span>5.46</span><span> billion</span>, up 11% year over year. Subscription revenue was <span>$</span><span>5.05</span> billion. GAAP diluted EPS was <span>$</span><span>3.97</span> and non-GAAP diluted EPS was <span>$</span><span>4.82</span>, compared with <span>$4.38</span> a year ago.</p>
<p>Current remaining performance obligation was $29.5 billion, up 10% year over year. Operating cash flow was $2.1 billion. GAAP operating margin was 20.3% and non-GAAP operating margin was 33.1%, compared to 32.4% last year.</p>
<p>&ldquo;Our customers are adopting agents across every cloud,&rdquo; said Marcus Hale, chief executive officer. The company repurchased $1.8 billion of its stock during the quarter. Net income was $3.9 billion.</p>
<p>Guidance for fourth quarter fiscal 2027: revenue of $5.9 billion to $6.0 billion; non-GAAP diluted EPS of $4.96 to $5.01.</p></body></html>`,
  extraction: {
    period: 'third quarter fiscal 2027',
    currency: 'USD',
    revenue: { value: '$5.46 billion' },
    epsGaap: { value: '$3.97' },
    epsAdjusted: { value: '$4.82', yearAgo: '$4.38' },
    netIncome: { value: '$3.9 billion' },
    operatingCashFlow: { value: '$2.1 billion' },
    operatingMargin: { value: '33.1%', yearAgo: '32.4%' },
    kpis: [{ key: 'rpo', value: '$29.5 billion' }, { key: 'crpo', value: '10%' }],
    guidance: [{ label: 'Revenue fourth quarter fiscal 2027', period: 'fourth quarter fiscal 2027', low: '$5.9 billion', high: '$6.0 billion' }],
    quote: { text: 'Our customers are adopting agents across every cloud', speaker: 'Marcus Hale, chief executive officer' },
  },
};

export const MESSY_RELEASES: readonly FixtureRelease[] = [IXBRL_RELEASE, FOREIGN_TEXT_RELEASE, IXBRL_BANK_RELEASE, MESSY_REIT_RELEASE, PROSE_SAAS_RELEASE];
