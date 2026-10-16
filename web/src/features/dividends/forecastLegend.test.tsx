import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/utils';
import { incomeColours } from '../calendar/calendarColours';
import { StatusAmounts } from '../calendar/IncomeTooltip';
import { DividendGrowthCard } from './DividendGrowthCard';
import { ForecastNote } from './ForecastNote';
import { FuturePaymentsCard } from './GrowthAndFuture';
import { GrowthLegendNote, Swatch } from './GrowthForecastParts';
import { ReceivedCards } from './ReceivedCards';
import { useDividendTheme } from './chartParts';
import { DECLARED_LABEL, ESTIMATED_LABEL, FORECAST_YEAR_NOTE, GROWTH_FORECAST_NOTE, STATUS_NOTE } from './forecastLabels';
import { legendNote, type LegendItem } from './growthForecast';
import type { ReactNode } from 'react';

/** The wording and the swatches that tell the forecast statuses apart from a forecast-only year. */

type Theme = ReturnType<typeof useDividendTheme>;

function Themed({ children }: Readonly<{ children: (c: Theme) => ReactNode }>) {
  return <>{children(useDividendTheme())}</>;
}

const item = (key: string, swatch: LegendItem['swatch']): LegendItem => ({ key, label: key, swatch });

describe('the forecast status names', () => {
  it('say where the figure comes from', () => {
    expect(DECLARED_LABEL).toBe('Declared (announced)');
    expect(ESTIMATED_LABEL).toBe('Estimated (from history)');
  });
});

describe('forecast-year swatch', () => {
  const swatchOf = (kind: 'forecastYear' | 'declared' | 'estimated', override?: Partial<Theme>) => {
    renderWithProviders(<Themed>{(c) => <Swatch kind={kind} c={{ ...c, ...override }} />}</Themed>);
    const el = document.querySelector<HTMLElement>('span[aria-hidden="true"]')!;
    return { el, style: el.style };
  };

  it('is a neutral dashed square with a hatch: not the declared blue and not the estimated yellow', () => {
    const forecast = swatchOf('forecastYear');
    expect(forecast.style.border).toContain('dashed');
    expect(forecast.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(forecast.el).toHaveClass('h-2.5', 'w-2.5');
  });

  it('shares no colour with the declared and estimated swatches, in light and in dark', () => {
    const c = { grid: '#e2e8f0', axis: '#64748b', declared: '#dbeafe', declaredEdge: '#3b6fd4', estimated: '#fef9c3', estimatedEdge: '#a16207' } as const;
    for (const [grid, axis] of [
      ['#e2e8f0', '#64748b'],
      ['#1e293b', '#94a3b8'],
    ]) {
      const forecast = swatchOf('forecastYear', { ...c, grid, axis });
      expect(forecast.style.backgroundColor).not.toBe('');
      for (const taken of [c.declared, c.declaredEdge, c.estimated, c.estimatedEdge]) {
        expect(forecast.style.border.toLowerCase()).not.toContain(taken);
        expect(forecast.style.backgroundColor.toLowerCase()).not.toContain(taken);
      }
      document.body.innerHTML = '';
    }
  });

  it('keeps declared as a solid blue edge and estimated as a yellow dashed edge', () => {
    const declared = swatchOf('declared');
    expect(declared.style.border).toContain('solid');
    expect(declared.style.backgroundImage).toBe('');
    document.body.innerHTML = '';
    expect(swatchOf('estimated').style.border).toContain('dashed');
  });
});

describe('legendNote', () => {
  it('is empty while no forecast entry is shown', () => {
    expect(legendNote([item('2025', 'year'), item('average', 'yearAverage')])).toBeNull();
    expect(legendNote([])).toBeNull();
  });

  it('explains the statuses, and a forecast-only year when the legend has one', () => {
    expect(legendNote([item('2025', 'year'), item('declared', 'declared'), item('estimated', 'estimated')])).toBe(GROWTH_FORECAST_NOTE);
    expect(legendNote([item('2025', 'year'), item('2027-forecast', 'forecastYear'), item('estimated', 'estimated')])).toBe(`${GROWTH_FORECAST_NOTE} ${FORECAST_YEAR_NOTE}`);
  });

  it('is one sentence of plain words', () => {
    expect(GROWTH_FORECAST_NOTE).toBe('Forecast bars: declared = announced by the company; estimated = implied by your payment history.');
    expect(FORECAST_YEAR_NOTE).toBe('A year marked (forecast) has only forecast bars.');
  });
});

describe('ForecastNote and GrowthLegendNote', () => {
  it('draws a muted paragraph that wraps', () => {
    renderWithProviders(<ForecastNote text="Some words." testId="note" />);
    const note = screen.getByTestId('note');
    expect(note.tagName).toBe('P');
    expect(note).toHaveTextContent('Some words.');
    expect(note).toHaveClass('muted', 'break-words', 'min-w-0');
  });

  it('shows nothing without a forecast entry', () => {
    const { container } = renderWithProviders(<GrowthLegendNote items={[item('2025', 'year')]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the note for a forecast entry', () => {
    renderWithProviders(<GrowthLegendNote items={[item('declared', 'declared')]} />);
    expect(screen.getByTestId('growth-legend-note')).toHaveTextContent(GROWTH_FORECAST_NOTE);
  });
});

describe('Dividend growth legend', () => {
  const card = () => screen.getByRole('region', { name: 'Dividend growth' });

  it('names the statuses and the forecast year apart and explains them under the legend', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('year-compare-chart');
    await screen.findByTestId('forecast-summary');
    const legend = within(card()).getByTestId('growth-legend');
    const names = within(legend)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(expect.arrayContaining(['2027 (forecast)', DECLARED_LABEL, ESTIMATED_LABEL, 'Average of years']));
    expect(names).not.toContain('Declared (forecast)');
    expect(names).not.toContain('Estimated (forecast)');
    expect(within(card()).getByTestId('growth-legend-note')).toHaveTextContent(`${GROWTH_FORECAST_NOTE} ${FORECAST_YEAR_NOTE}`);

    // the timeline uses the same two names and the first sentence only
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    const timeline = within(card()).getByTestId('growth-legend');
    for (const name of ['Received', DECLARED_LABEL, ESTIMATED_LABEL]) expect(within(timeline).getByRole('button', { name })).toBeInTheDocument();
    expect(within(card()).getByTestId('growth-legend-note')).toHaveTextContent(GROWTH_FORECAST_NOTE);
    expect(within(card()).getByTestId('growth-legend-note')).not.toHaveTextContent('(forecast)');

    // no forecast, no explanation
    await user.click(screen.getByRole('checkbox', { name: 'Show forecast' }));
    expect(within(card()).queryByTestId('growth-legend-note')).toBeNull();
  });

  it('keeps the long names in the data table column headers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('forecast-summary');
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    await user.click(within(card()).getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividends received, forecast and trend per month' });
    expect(within(table).getByRole('button', { name: DECLARED_LABEL })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: ESTIMATED_LABEL })).toBeInTheDocument();
  });
});

describe('the other Dividends cards use the same two names', () => {
  it('Dividends received explains them under its legend while the future is on', async () => {
    renderWithProviders(<ReceivedCards />);
    await screen.findByTestId('received-time-chart');
    const legend = screen.getByTestId('received-legend');
    expect(within(legend).getByRole('button', { name: DECLARED_LABEL })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: ESTIMATED_LABEL })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: 'Received' })).toBeInTheDocument();
    expect(screen.getByTestId('received-legend-note')).toHaveTextContent(STATUS_NOTE);

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Include future payments' }));
    expect(screen.queryByTestId('received-legend-note')).toBeNull();
  });

  it('name the statuses in the tooltip rows, while the calendar keeps its short names', () => {
    const colours = incomeColours('light');
    const row = { paid: 1, declared: 2, estimated: 3, total: 6 };
    const { unmount } = renderWithProviders(<StatusAmounts row={row} currency="EUR" colours={colours} border="#ccc" names={{ declared: DECLARED_LABEL, estimated: ESTIMATED_LABEL }} />);
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText(DECLARED_LABEL)).toBeInTheDocument();
    expect(screen.getByText(ESTIMATED_LABEL)).toBeInTheDocument();
    unmount();
    renderWithProviders(<StatusAmounts row={row} currency="EUR" colours={colours} border="#ccc" />);
    expect(screen.getByText('Declared')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toBeInTheDocument();
  });

  it('Future payments names its statuses and explains them', async () => {
    renderWithProviders(<FuturePaymentsCard />);
    await screen.findByTestId('future-chart');
    const legend = screen.getByTestId('future-legend');
    expect(within(legend).getByRole('button', { name: DECLARED_LABEL })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: ESTIMATED_LABEL })).toBeInTheDocument();
    expect(screen.getByTestId('future-legend-note')).toHaveTextContent(STATUS_NOTE);
  });
});
