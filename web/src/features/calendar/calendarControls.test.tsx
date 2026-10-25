import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarMonth, CalendarSummary } from '@portfolio/shared';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { renderWithProviders, sp } from '../../test/utils';
import { ColourKey, FilterBar, MonthNavigator, ScopeSelect, StatusFilter, ToggleGroup, TypeFilter, ViewToolbar } from './CalendarControls';
import { CalendarKpis, CoverageNotes, IncomeChart, IncomeChartCard } from './CalendarOverview';
import { IncomeTooltip } from './IncomeTooltip';
import { chipClasses, incomeColours } from './calendarColours';
import { barLabel, incomeRows, seriesName, shortAmount } from './incomeChartModel';
import { parseCalendarState, type CalendarUiState } from './calendarModel';

const TODAY = '2026-10-15';
const initial = () => parseCalendarState(new URLSearchParams(), TODAY, 'calendar');

describe('ToggleGroup', () => {
  it('is a fieldset of native radio buttons', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ToggleGroup
        legend="View"
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma', disabled: true, title: 'Not now' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'View' });
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).getByRole('radio', { name: 'Alpha' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Gamma' })).toBeDisabled();
    await userEvent.click(within(group).getByRole('radio', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('filters', () => {
  it('toggles event types, keeping the canonical order', async () => {
    const onChange = vi.fn();
    renderWithProviders(<TypeFilter value={['EARNINGS', 'EX_DIVIDEND']} onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Event types' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(5);
    expect(within(group).getByRole('checkbox', { name: 'Earnings' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Stock split' })).not.toBeChecked();
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Stock split' }));
    expect(onChange).toHaveBeenLastCalledWith(['EX_DIVIDEND', 'EARNINGS', 'SPLIT']);
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Earnings' }));
    expect(onChange).toHaveBeenLastCalledWith(['EX_DIVIDEND']);
  });

  it('toggles statuses and scope', async () => {
    const onStatus = vi.fn();
    const onScope = vi.fn();
    renderWithProviders(
      <>
        <StatusFilter value={['CONFIRMED']} onChange={onStatus} />
        <ScopeSelect value="all" onChange={onScope} />
      </>,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Received' }));
    expect(onStatus).toHaveBeenCalledWith(['CONFIRMED', 'PAID']);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Confirmed' }));
    expect(onStatus).toHaveBeenLastCalledWith([]);
    const select = screen.getByRole('combobox', { name: 'Show' });
    expect(select).toHaveValue('all');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['My holdings', 'Watchlist', 'Holdings and watchlist']);
    await userEvent.selectOptions(select, 'watchlist');
    expect(onScope).toHaveBeenCalledWith('watchlist');
  });

  it('offers the download and disables it while busy or without selection', async () => {
    const onDownload = vi.fn();
    const { rerender } = renderWithProviders(<FilterBar state={initial()} onChange={vi.fn()} onDownload={onDownload} downloading={false} downloadDisabled={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download .ics' }));
    expect(onDownload).toHaveBeenCalledOnce();
    rerender(<FilterBar state={initial()} onChange={vi.fn()} onDownload={onDownload} downloading downloadDisabled={false} />);
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    rerender(<FilterBar state={initial()} onChange={vi.fn()} onDownload={onDownload} downloading={false} downloadDisabled />);
    expect(screen.getByRole('button', { name: 'Download .ics' })).toBeDisabled();
  });

  it('passes the changed filter up', async () => {
    const onChange = vi.fn();
    renderWithProviders(<FilterBar state={initial()} onChange={onChange} onDownload={vi.fn()} downloading={false} downloadDisabled={false} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ex-dividend' }));
    expect(onChange).toHaveBeenLastCalledWith({ types: ['DIVIDEND_PAY', 'EARNINGS', 'SPLIT', 'CORPORATE_ACTION'] });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Estimated' }));
    expect(onChange).toHaveBeenLastCalledWith({ statuses: ['CONFIRMED', 'PAID'] });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'holdings');
    expect(onChange).toHaveBeenLastCalledWith({ scope: 'holdings' });
  });
});

describe('MonthNavigator', () => {
  it('moves between months and jumps back to today', async () => {
    const onMonth = vi.fn();
    const { rerender } = renderWithProviders(<MonthNavigator month="2026-10" today={TODAY} range="month" onMonth={onMonth} />);
    expect(screen.getByRole('heading', { level: 2, name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(onMonth).toHaveBeenLastCalledWith('2026-09');
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(onMonth).toHaveBeenLastCalledWith('2026-11');
    rerender(<MonthNavigator month="2027-01" today={TODAY} range="month" onMonth={onMonth} />);
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onMonth).toHaveBeenLastCalledWith('2026-10');
  });

  it('is fixed in the 12-month range', () => {
    renderWithProviders(<MonthNavigator month="2026-10" today={TODAY} range="year" onMonth={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Next 12 months' })).toBeInTheDocument();
    for (const name of ['Previous month', 'Next month', 'Today']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });
});

describe('ViewToolbar', () => {
  function Harness({ start }: Readonly<{ start: CalendarUiState }>) {
    const [state, setState] = useState(start);
    return <ViewToolbar state={state} today={TODAY} onChange={(patch) => setState({ ...state, ...patch })} />;
  }

  it('switches between calendar and list and between this month and the next 12 months', async () => {
    renderWithProviders(<Harness start={initial()} />);
    expect(screen.getByRole('radio', { name: 'Calendar' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('radio', { name: 'List' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Calendar' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Next 12 months' }));
    // The grid only shows one month: the 12-month range switches to the list and disables the grid.
    expect(screen.getByRole('radio', { name: 'List' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Calendar' })).toBeDisabled();
    expect(screen.getByRole('heading', { level: 2, name: 'Next 12 months' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'This month' }));
    expect(screen.getByRole('radio', { name: 'Calendar' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'List' })).toBeChecked();
  });
});

describe('CalendarOverview', () => {
  const summary: CalendarSummary = { annualIncome: 540.96, monthlyAverage: 45.08, dailyAverage: 1.48, yieldPct: 0.75, yieldOnCostPct: 0.85, declared: 300, estimated: 240.96 };
  const monthly: CalendarMonth[] = [
    { month: '2026-09', paid: 10, declared: 0, estimated: 0, total: 10 },
    { month: '2026-10', paid: 0, declared: 20, estimated: 5, total: 25 },
  ];

  it('shows the four KPIs or placeholders while loading', () => {
    const { rerender } = render(<CalendarKpis summary={summary} currency="EUR" loading={false} />);
    expect(screen.getByRole('region', { name: 'Annual income' })).toHaveTextContent(sp('€ 540,96'));
    expect(screen.getByRole('region', { name: 'Monthly average' })).toHaveTextContent(sp('€ 45,08'));
    expect(screen.getByRole('region', { name: 'Daily average' })).toHaveTextContent(sp('€ 1,48'));
    expect(screen.getByRole('region', { name: 'Yield' })).toHaveTextContent('0,75%');
    expect(screen.getByRole('region', { name: 'Yield' })).toHaveTextContent('0,85% on cost');
    rerender(<CalendarKpis loading currency="EUR" />);
    expect(screen.getByRole('region', { name: 'Annual income' })).toHaveAttribute('aria-busy', 'true');
  });

  it('describes the chart for assistive technology with a data table', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <IncomeChart monthly={monthly} average={45.08} currency="EUR" />
      </ThemeProvider>,
    );
    expect(screen.getByRole('img', { name: /Dividend income per month over 2 months: .* in total, .* on average\./ })).toBeInTheDocument();
    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividend income per month' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent(sp('€ 20,00'));
    expect(rows[2]).toHaveTextContent(sp('€ 5,00'));
  });

  it('names the chart series', () => {
    expect(seriesName('paid')).toBe('Received');
    expect(seriesName('declared')).toBe('Declared');
    expect(seriesName('estimated')).toBe('Estimated');
    expect(seriesName('other')).toBe('other');
  });

  it('labels bars with a short amount, hiding zero bars and, on narrow screens, every other bar', () => {
    const rows = [
      { month: '2026-08', paid: 0, declared: 0, estimated: 0, total: 0 },
      { month: '2026-09', paid: 56, declared: 0, estimated: 0, total: 56 },
      { month: '2026-10', paid: 0, declared: 0, estimated: 1234, total: 1234 },
      { month: '2026-11', paid: 0, declared: 0, estimated: 7, total: 7 },
    ];
    expect(incomeRows(rows, 'EUR', false).map((r) => sp(r.label))).toEqual(['', '€ 56', '€ 1,2K', '€ 7']);
    expect(incomeRows(rows, 'EUR', true).map((r) => sp(r.label))).toEqual(['', '', '€ 1,2K', '']);
    expect(sp(shortAmount(55.6, 'EUR'))).toBe('€ 56');
    expect([barLabel(0.2, 'EUR'), sp(barLabel(55.6, 'EUR'))]).toEqual(['', '€ 56']);
  });

  it('uses the narrow-screen media query for the chart labels', () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof matchMedia;
    try {
      render(
        <ThemeProvider>
          <IncomeChart monthly={monthly} average={45.08} currency="EUR" />
        </ThemeProvider>,
      );
      expect(screen.getByTestId('calendar-income-chart')).toBeInTheDocument();
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it('lists every status and the total in the month tooltip', () => {
    const props = { currency: 'EUR', colours: incomeColours('light'), background: '#fff', border: '#ccc', text: '#000' };
    const row = monthly[1]!;
    const { rerender } = render(<IncomeTooltip {...props} active payload={[{ payload: row }]} />);
    const tip = screen.getByTestId('calendar-income-tooltip');
    expect(tip).toHaveTextContent('Received');
    expect(tip).toHaveTextContent('Declared');
    expect(tip).toHaveTextContent('Estimated');
    expect(tip).toHaveTextContent(sp('€ 20,00'));
    expect(tip).toHaveTextContent(`Total${sp('€ 25,00')}`);
    rerender(<IncomeTooltip {...props} active={false} payload={[{ payload: row }]} />);
    expect(screen.queryByTestId('calendar-income-tooltip')).not.toBeInTheDocument();
    rerender(<IncomeTooltip {...props} active payload={[]} />);
    expect(screen.queryByTestId('calendar-income-tooltip')).not.toBeInTheDocument();
  });

  it('colours statuses green, yellow (dashed) and blue in both themes', () => {
    expect(chipClasses('PAID')).toContain('bg-[#dcfce7]');
    expect(chipClasses('ESTIMATED')).toContain('bg-[#fef9c3]');
    expect(chipClasses('ESTIMATED')).toContain('border-dashed');
    expect(chipClasses('CONFIRMED')).toContain('bg-[#dbeafe]');
    expect(chipClasses('PAID')).not.toContain('border-dashed');
    expect(incomeColours('light').paid.fill).toBe('#86d9a0');
    expect(incomeColours('light').estimated.fill).toBe('#fde68a');
    expect(incomeColours('dark').paid.stroke).toBe('#6ee7a0');
    expect(incomeColours('dark').estimated.stroke).toBe('#facc15');
  });

  it('explains the colours in a native list: ex-dividend violet with its marker, then the three statuses', () => {
    renderWithProviders(<ColourKey />);
    const list = screen.getByRole('list', { name: /ex-dividend by type, everything else by status/ });
    expect(list.tagName).toBe('UL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['EEx-dividend: violet', 'Received: green', 'Confirmed: blue', 'Estimated: yellow, dashed']);
    expect(items[0]?.querySelector('svg[data-shape="circle"]')).not.toBeNull();
    expect(items[0]?.querySelector('[aria-hidden="true"]')?.className).toContain('bg-[#e9d5ff]');
    expect(items[3]?.querySelector('[aria-hidden="true"]')?.className).toContain('border-dashed');
    expect(list.closest('[role]')).toBeNull();
  });

  it('shows the colour key in the filter bar', () => {
    renderWithProviders(<FilterBar state={initial()} onChange={vi.fn()} onDownload={vi.fn()} downloading={false} downloadDisabled={false} />);
    expect(screen.getByRole('list', { name: /Colours/ })).toBeInTheDocument();
  });

  it('shows a skeleton until the income data is there', () => {
    const { rerender } = render(
      <ThemeProvider>
        <IncomeChartCard loading currency="EUR" />
      </ThemeProvider>,
    );
    expect(screen.getByText('Loading chart')).toBeInTheDocument();
    rerender(
      <ThemeProvider>
        <IncomeChartCard monthly={monthly} summary={summary} currency="EUR" loading={false} />
      </ThemeProvider>,
    );
    expect(screen.queryByText('Loading chart')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Income per month' })).toBeInTheDocument();
  });

  it('lists the coverage limits, preferring the API’s wording', () => {
    const { rerender } = render(<CoverageNotes />);
    const details = screen.getByText('What does this calendar cover?').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('mostly available for US-listed companies');
    expect(details).toHaveTextContent('mergers, spin-offs and symbol changes are not');
    expect(details).toHaveTextContent('projections from your own payment history');
    rerender(<CoverageNotes earnings="Earnings from X." corporateActions="Splits from Y." />);
    expect(details).toHaveTextContent('Earnings from X.');
    expect(details).toHaveTextContent('Splits from Y.');
  });
});
