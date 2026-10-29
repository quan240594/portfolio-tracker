import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleDemoSummaries, sampleSummary, type EarningsSummary } from '@portfolio/shared';
import { renderWithProviders, sp } from '../../test/utils';
import { EarningsCard } from './EarningsCard';

const [bank, saas] = sampleDemoSummaries() as [EarningsSummary, EarningsSummary];
const renderCard = (summary: EarningsSummary, variant: 'full' | 'compact' = 'full') => renderWithProviders(<EarningsCard summary={summary} variant={variant} />);

describe('the header', () => {
  it('shows the company, period, release date as dd-mm-yyyy, the source link and the disclaimer', () => {
    renderCard(sampleSummary());
    expect(screen.getByRole('heading', { name: 'Northwind Aerospace Corporation · Q3 2026' })).toBeInTheDocument();
    expect(screen.getByText('21-10-2026')).toBeInTheDocument();
    const source = screen.getByRole('link', { name: /Source: SEC filing/ });
    expect(source).toHaveAttribute('href', 'https://www.sec.gov/Archives/edgar/data/1000001/000100000126000001/ex99_1.htm');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    expect(source).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Auto-generated from the company's press release; every number was checked against the text\. Check the source before acting\./)).toBeInTheDocument();
  });

  it('says how many model values could not be verified', () => {
    renderCard(sampleSummary({ verification: { dropped: 2, droppedFields: ['quote', 'revenue.yearAgo'], model: 'm', neuronsEstimate: 1, calls: 1 } }));
    expect(screen.getByText(/2 values the model returned could not be found in the text and were left out/)).toBeInTheDocument();
    renderCard(sampleSummary({ symbol: 'ONE', verification: { dropped: 1, droppedFields: ['quote'], model: 'm', neuronsEstimate: 1, calls: 1 } }));
    expect(screen.getByText(/1 value the model returned could not be found in the text and was left out/)).toBeInTheDocument();
  });

  it('links the title to the page of the symbol in the full card only', () => {
    renderCard(sampleSummary());
    expect(screen.getByRole('link', { name: /Northwind Aerospace Corporation/ })).toHaveAttribute('href', '/earnings/NWND');
  });

  it('the compact card has no details and no title link', () => {
    renderCard(sampleSummary(), 'compact');
    expect(screen.queryByRole('link', { name: /Northwind Aerospace Corporation/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Results')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('the scorecard', () => {
  it('is a table with expected, actual and beat or miss, and a text-and-icon verdict', () => {
    renderCard(sampleSummary());
    const table = screen.getByRole('table', { name: /Northwind Aerospace/ });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Figure', 'Expected', 'Actual', 'Beat/Miss']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const eps = within(rows[0]!);
    expect(eps.getByRole('rowheader')).toHaveTextContent('EPS');
    expect(eps.getByText('adjusted')).toBeInTheDocument();
    expect(eps.getByText(/6,45/)).toBeInTheDocument();
    expect(eps.getByText(/6,92/)).toBeInTheDocument();
    const chip = eps.getByText(/^Beat by/).closest('[data-verdict]')!;
    expect(chip).toHaveAttribute('data-verdict', 'beat');
    expect(sp(chip.textContent ?? '')).toBe('Beat by US$ 0,47 (7,3%)');
    expect(chip.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const revenue = within(rows[1]!);
    expect(revenue.getByText('$20.71B')).toBeInTheDocument();
    expect(revenue.getAllByText('no estimate available').length).toBeGreaterThan(0);
  });

  it('shows miss and in line verdicts with their own word', () => {
    renderCard(bank);
    expect(screen.getAllByText('In line')[0]!.closest('[data-verdict]')).toHaveAttribute('data-verdict', 'inline');
    renderCard(sampleSummary({ symbol: 'MISS', headline: { eps: { value: 1, unit: 'perShare', estimate: 1.2, verdict: 'miss', surprisePct: -16.7 } } }));
    expect(sp(screen.getAllByText(/^Missed by/)[0]!.closest('[data-verdict]')!.textContent ?? '')).toBe('Missed by US$ 0,20 (16,7%)');
  });

  it('shows the consensus with its range, the analysts and the source, and the beat or miss in words and amounts', () => {
    renderCard(saas);
    const table = screen.getByRole('table', { name: /Cloudvale Software/ });
    const [eps, revenue] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(sp(eps.textContent ?? '')).toContain('US$ 1,95');
    expect(sp(eps.textContent ?? '')).toContain('(31 analysts)');
    expect(sp(eps.textContent ?? '')).toContain('Range US$ 1,88 to US$ 2,02');
    expect(within(eps).getByText('Consensus: Alpha Vantage')).toBeInTheDocument();
    expect(sp(within(eps).getByText(/^Beat by/).textContent ?? '')).toBe('Beat by US$ 0,15 (7,7%)');
    expect(within(revenue).getByText('$3.18B')).toBeInTheDocument();
    expect(within(revenue).getByText('(27 analysts)')).toBeInTheDocument();
    const miss = within(revenue).getByText(/^Missed by/);
    expect(miss.textContent).toBe('Missed by $60M (1,9%)');
    expect(miss.closest('[data-verdict]')).toHaveAttribute('data-verdict', 'miss');
  });

  it('says n/a in the expected and beat/miss cells of a figure without an estimate, and the reason once under the table', () => {
    renderCard(bank);
    const table = screen.getByRole('table', { name: /Harbor Bancorp/ });
    const revenue = within(within(table).getAllByRole('row')[2]!);
    expect(revenue.getAllByText('n/a')).toHaveLength(2);
    expect(revenue.queryByText('no estimate available')).not.toBeInTheDocument();
    expect(screen.getAllByText('Revenue: The data provider has no estimate for this figure')).toHaveLength(1);
    expect(within(table).queryByText(/The data provider has no estimate/)).not.toBeInTheDocument();
  });

  it('says the reason of a rate limit once for the whole card, with the time of the next try and none of the provider\u2019s words', () => {
    const retryAt = new Date(2026, 9, 29, 14, 20).toISOString();
    const limited = { ...sampleSummary({ headline: { eps: { value: 1, unit: 'perShare' }, revenue: { value: 2, unit: 'money' } } }), consensus: { provider: 'Alpha Vantage' as const, reason: 'rate-limited' as const, detail: 'Please contact premium@alphavantage.co if you are targeting a higher API call volume.', retryAt } };
    renderCard(limited);
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('n/a')).toHaveLength(4);
    expect(screen.getAllByText(/Alpha Vantage is limiting requests right now; the app retries automatically \(next try after /)).toHaveLength(1);
    expect(screen.queryByText(/premium@alphavantage\.co/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The last attempt to fetch it failed/)).not.toBeInTheDocument();
  });

  it('says the free plan has no estimates, once', () => {
    const premium = { ...sampleSummary({ headline: { eps: { value: 1, unit: 'perShare' }, revenue: { value: 2, unit: 'money' } } }), consensus: { provider: 'Alpha Vantage' as const, reason: 'premium' as const } };
    renderCard(premium);
    expect(screen.getAllByText('The free Alpha Vantage plan does not include estimates')).toHaveLength(1);
    expect(within(screen.getByRole('table')).getAllByText('n/a')).toHaveLength(4);
  });

  it('says not disclosed for a figure the release did not state', () => {
    renderCard(sampleSummary({ template: 'reit', headline: {}, kpis: [] }));
    expect(screen.getAllByText('not disclosed').length).toBeGreaterThanOrEqual(2);
  });
});

describe('growth lines', () => {
  it('prints year over year and quarter over quarter growth with accessible abbreviations', () => {
    renderCard(sampleSummary());
    const list = screen.getByRole('list', { name: 'Growth' });
    expect(within(list).getByText(/EPS up 12%/)).toBeInTheDocument();
    expect(list.querySelector('abbr[title="year over year"]')).not.toBeNull();
    expect(list.querySelector('abbr[title="quarter over quarter"]')).not.toBeNull();
    expect(within(list).queryByText(/first stored quarter/)).not.toBeInTheDocument();
  });

  it('says so for the first stored quarter instead of inventing a quarter over quarter figure', () => {
    renderCard(saas);
    expect(screen.getByText(/n\/a, first stored quarter/)).toBeInTheDocument();
  });
});

describe('the details', () => {
  it('has collapsible native sections for the results, guidance, cash flow, segments, key updates and management', () => {
    const { container } = renderCard(sampleSummary());
    const titles = [...container.querySelectorAll('details > summary')].map((summary) => summary.textContent);
    expect(titles).toEqual(['Results', 'Guidance', 'Cash flow', 'Segment sales', 'Key updates', 'Management']);
    const open = [...container.querySelectorAll('details')].map((details) => details.open);
    expect(open).toEqual([true, true, true, false, false, false]);
  });

  it('marks free cash flow as calculated or reported, and shows guidance with its direction and no estimate', () => {
    renderCard(sampleSummary());
    const cash = screen.getByText('Cash flow').closest('details')!;
    expect(within(cash).getAllByText('calculated', { selector: 'span' })).toHaveLength(2);
    expect(within(cash).getByText('Free cash flow')).toBeInTheDocument();
    expect(within(cash).getByText('FCF per share')).toBeInTheDocument();
    expect(within(cash).getByText('Cash from operations')).toBeInTheDocument();
    expect(within(cash).getByText('Capital expenditure')).toBeInTheDocument();
    const guidance = screen.getByText('Guidance').closest('details')!;
    expect(within(guidance).getByText('$80.0 billion to $81.5 billion')).toBeInTheDocument();
    expect(within(guidance).getByText('Raised')).toBeInTheDocument();
    expect(within(guidance).getAllByText('no estimate available')).toHaveLength(2);
    renderCard(sampleSummary({ symbol: 'REP', headline: { fcf: { value: 1e9, unit: 'money', basis: 'reported' } } }));
    expect(screen.getAllByText('reported').length).toBeGreaterThan(0);
  });

  it('shows the segments with growth, the key updates and the one management quote', () => {
    renderCard(sampleSummary());
    const segments = screen.getByText('Segment sales').closest('details')!;
    expect(within(segments).getByText('Airframes')).toBeInTheDocument();
    expect(within(segments).getByText(/\+10%/)).toBeInTheDocument();
    expect(within(screen.getByText('Key updates').closest('details')!).getAllByRole('listitem')).toHaveLength(3);
    const quote = screen.getByText('Management').closest('details')!;
    expect(within(quote).getByText(/We delivered strong results/)).toBeInTheDocument();
    expect(within(quote).getByText('Chief Executive Officer')).toBeInTheDocument();
  });

  it('leaves out sections the company did not report and has no cash flow section for a bank', () => {
    renderCard(bank);
    expect(screen.queryByText('Cash flow')).not.toBeInTheDocument();
    expect(screen.queryByText('Guidance')).not.toBeInTheDocument();
    expect(screen.getByText('Bank figures')).toBeInTheDocument();
    renderCard(sampleSummary({ symbol: 'BARE', guidance: [], segments: [], keyUpdates: [], quote: undefined, headline: { revenue: { value: 5e9, unit: 'money' } } }));
    const section = screen.getAllByText('Results').at(-1)!.closest('details')!;
    expect(within(section).getByText('$5B')).toBeInTheDocument();
    expect(screen.getAllByText('Cash flow').at(-1)!.closest('details')).toHaveTextContent('not disclosed');
  });

  it('shows the template slots of a bank with a missing figure as not disclosed', () => {
    renderCard(bank);
    const slots = screen.getByText('Bank figures').closest('details')!;
    expect(within(slots).getByText('ROTCE')).toBeInTheDocument();
    expect(within(slots).getByText('Tangible book value per share')).toBeInTheDocument();
    expect(within(slots).getByText('CET1 capital ratio')).toBeInTheDocument();
    expect(within(slots).getByText('Net interest income')).toBeInTheDocument();
    expect(within(slots).getByText('Provision for credit losses')).toBeInTheDocument();
    expect(within(slots).getByText(/\+1,1 pt/)).toBeInTheDocument();
    renderCard({ ...bank, symbol: 'BNK2', kpis: bank.kpis.map((kpi) => ({ key: kpi.key, label: kpi.label, unit: kpi.unit })) });
    expect(within(screen.getAllByText('Bank figures').at(-1)!.closest('details')!).getAllByText('not disclosed')).toHaveLength(6);
  });

  it('shows the SaaS slots (RPO, cRPO, NRR; ARR not disclosed)', () => {
    renderCard(saas);
    const slots = screen.getByText('Software as a service figures').closest('details')!;
    expect(within(slots).getByText('$14.8B')).toBeInTheDocument();
    expect(within(slots).getByText('Annual recurring revenue').closest('li')).toHaveTextContent('not disclosed');
    expect(within(slots).getByText('Current RPO growth').closest('li')).toHaveTextContent('27,0%');
  });
});
