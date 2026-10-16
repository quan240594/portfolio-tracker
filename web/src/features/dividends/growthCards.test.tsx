import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { buildGrowthTimeline, computeDividendGrowth, computeDividendsOverview, type AnalyticsDividendGrowthResponse } from '@portfolio/shared';
import { SelectableLegend, useSeriesSelection, type LegendEntry } from '../../components/charts/selection';
import { renderWithProviders, sp } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData } from '../../mocks/db';
import { formatMoney } from '../../lib/format';
import { DividendGrowthCard } from './DividendGrowthCard';
import { FuturePaymentsCard } from './GrowthAndFuture';
import { useDividendTheme } from './chartParts';
import { growthLegendEntries, GrowthControls, ForecastSummary, Swatch, TimelineTooltip, TooltipBox, TrendMethod, TrendNote, YearTooltip } from './GrowthForecastParts';
import { yearBars, yearColour } from './GrowthCharts';
import { timelineRows, yearForecastModel, type SwatchKind } from './growthForecast';
import type { ReactNode } from 'react';

const GROWTH = '/api/analytics/dividend-growth';
const OVERVIEW = '/api/dividends/overview';
const data = getAnalyticsData();
const overview = computeDividendsOverview(data);
const growth = computeDividendGrowth(data);
const card = () => screen.getByRole('region', { name: 'Dividend growth' });
const growthWith = (byMonth: AnalyticsDividendGrowthResponse['byMonth']) => server.use(http.get(GROWTH, () => HttpResponse.json({ ...growth, byMonth, growthStats: undefined })));

/** Runs `render` with the dividends chart theme (needs the theme provider). */
function Themed({ children }: Readonly<{ children: (c: ReturnType<typeof useDividendTheme>) => ReactNode }>) {
  return <>{children(useDividendTheme())}</>;
}

function LegendHarness({ entries }: Readonly<{ entries: LegendEntry[] }>) {
  const selection = useSeriesSelection(entries.map((e) => e.key));
  return <SelectableLegend entries={entries} selection={selection} />;
}

describe('parts', () => {
  it('draws a swatch for every kind of series', () => {
    const kinds: SwatchKind[] = ['year', 'forecastYear', 'received', 'declared', 'estimated', 'average', 'yearAverage', 'trend', 'projection'];
    renderWithProviders(<Themed>{(c) => kinds.map((k) => <Swatch key={k} kind={k} color="#123456" c={c} />)}</Themed>);
    const swatches = document.querySelectorAll('span[aria-hidden="true"]');
    expect(swatches).toHaveLength(kinds.length);
    const style = (i: number) => (swatches[i] as HTMLElement).style;
    expect(style(0).background).toContain('rgb(18, 52, 86)');
    expect(style(2).background).toContain('rgb(18, 52, 86)');
    expect(style(1).border).toContain('solid');
    expect(style(3).border).toContain('solid');
    expect(style(4).border).toContain('dashed'); // estimated: dashed edge, not colour only
    expect(style(5).borderTopStyle).toBe('solid');
    expect(style(6).borderTopStyle).toBe('dashed');
    expect(style(7).borderTopStyle).toBe('solid');
    expect(style(8).borderTopStyle).toBe('dashed');
  });

  it('turns legend items into entries with a swatch and the text', () => {
    renderWithProviders(
      <Themed>
        {(c) => (
          <LegendHarness
            entries={growthLegendEntries(
              [
                { key: 'a', label: '2027 (forecast)', swatch: 'forecastYear' },
                { key: 'b', label: 'Estimated (forecast)', swatch: 'estimated' },
              ],
              c,
            )}
          />
        )}
      </Themed>,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2027 (forecast)', 'Estimated (forecast)']);
    expect(screen.getByRole('button', { name: '2027 (forecast)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a tooltip box with a labelled row per series', () => {
    renderWithProviders(
      <Themed>
        {(c) => (
          <TooltipBox
            title="mrt"
            ccy="EUR"
            c={c}
            colorOf={() => '#ff0000'}
            lines={[
              { key: '2026', label: '2026', value: 5, kind: 'received', year: '2026' },
              { key: 'e', label: '2026 forecast · Estimated', value: 7.5, kind: 'estimated', year: '2026' },
              { key: 't', label: 'Trend', value: 1, kind: 'trend' },
            ]}
          />
        )}
      </Themed>,
    );
    expect(screen.getByText('mrt')).toBeInTheDocument();
    expect(sp(screen.getByText('2026 forecast · Estimated').parentElement!.parentElement!.textContent!)).toContain('€ 7,50');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders the tooltips only for an active chart with data', () => {
    const timeline = buildGrowthTimeline(growth.byMonth, overview.futureMonths, overview.asOf);
    const model = yearForecastModel(growth.byMonth, timeline, true);
    const row = model.rows[1]!;
    const trow = timelineRows(timeline, true).at(-1)!;
    const { container } = renderWithProviders(
      <Themed>
        {(c) => (
          <>
            <YearTooltip active={false} payload={[{ payload: row }]} model={model} ccy="EUR" c={c} colorOf={() => '#000'} />
            <YearTooltip active payload={[]} model={model} ccy="EUR" c={c} colorOf={() => '#000'} />
            <TimelineTooltip active={false} payload={[{ payload: trow }]} ccy="EUR" c={c} />
            <TimelineTooltip active payload={undefined} ccy="EUR" c={c} />
          </>
        )}
      </Themed>,
    );
    expect(container.querySelector('li')).toBeNull();
    const shown = renderWithProviders(
      <Themed>
        {(c) => (
          <>
            <YearTooltip active payload={[{ payload: row }]} model={model} ccy="EUR" c={c} colorOf={() => '#000'} />
            <TimelineTooltip active payload={[{ payload: trow }]} ccy="EUR" c={c} />
          </>
        )}
      </Themed>,
    );
    expect(shown.container).toHaveTextContent(row.month);
    expect(shown.container).toHaveTextContent(`${trow.label} · Forecast`);
    expect(shown.container).toHaveTextContent('Trend (projected)');
  });

  it('has native controls: view radios and a forecast checkbox', async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onShow = vi.fn();
    const view = renderWithProviders(<GrowthControls view="year" onView={onView} showForecast onShowForecast={onShow} forecastAvailable />);
    expect(screen.getByRole('radio', { name: 'By year' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    expect(onView).toHaveBeenCalledWith('timeline');
    await user.click(screen.getByRole('checkbox', { name: 'Show forecast' }));
    expect(onShow).toHaveBeenCalledWith(false);
    view.unmount();

    renderWithProviders(<GrowthControls view="timeline" onView={onView} showForecast onShowForecast={onShow} forecastAvailable={false} />);
    expect(screen.getByRole('checkbox', { name: 'Show forecast' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Show forecast' })).not.toBeChecked();
  });

  it('renders the summary, the note and the method', () => {
    const { container } = renderWithProviders(
      <>
        <ForecastSummary parts={[]} />
        <ForecastSummary parts={['A', 'B']} />
        <TrendNote />
        <TrendMethod />
      </>,
    );
    expect(screen.getByTestId('forecast-summary')).toHaveTextContent('A · B');
    expect(screen.getAllByTestId('forecast-summary')).toHaveLength(1);
    expect(screen.getByTestId('trend-note')).toHaveTextContent('Needs at least 6 months of dividend history');
    const method = screen.getByTestId('trend-method');
    expect(method).toHaveTextContent('least squares');
    expect(method).toHaveTextContent('24 complete months');
    expect(method).toHaveTextContent('never drops below € 0');
    expect(method).toHaveTextContent('Not investment advice');
    expect(container.querySelector('details')).not.toBeNull();
  });

  it('stacks forecast bars on the year of the received bars', () => {
    const timeline = buildGrowthTimeline(growth.byMonth, overview.futureMonths, overview.asOf);
    const model = yearForecastModel(growth.byMonth, timeline, true);
    const { container } = renderWithProviders(<Themed>{(c) => <span data-keys={yearBars(model, c).map((b) => String(b.key)).join(',')} data-colour={yearColour(c, model.years, model.years.at(-1)!)} />}</Themed>);
    const keys = container.querySelector('span')!.getAttribute('data-keys')!.split(',');
    expect(keys).toEqual(expect.arrayContaining(['2026', '2026-declared', '2026-estimated', '2027-declared', '2027-estimated']));
    expect(keys).not.toContain('2027');
  });
});

describe('DividendGrowthCard forecast and trend', () => {
  it('shows the forecast in the grouped chart and a summary that matches the Future payments card', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <DividendGrowthCard />
        <FuturePaymentsCard />
      </>,
    );
    const chart = await screen.findByTestId('year-compare-chart');
    const summary = await within(card()).findByTestId('forecast-summary');
    const { forward12m, declared, estimated } = overview.summary;
    expect(sp(summary.textContent!)).toContain(sp(`Forecast next 12 months: ${formatMoney(forward12m, 'EUR')} (declared ${formatMoney(declared, 'EUR')}, estimated ${formatMoney(estimated, 'EUR')})`));
    expect(sp(summary.textContent!)).toMatch(/ · Trend: [+−]€ \d+,\d{2}\/month per year$/);
    expect(sp((await screen.findByTestId('future-total')).textContent!)).toBe(sp(formatMoney(forward12m, 'EUR')));

    const legend = within(card()).getByTestId('growth-legend');
    for (const text of ['2027 (forecast)', 'Declared (forecast)', 'Estimated (forecast)', 'Average of years']) expect(legend).toHaveTextContent(text);
    expect(chart.getAttribute('aria-label')).toMatch(/Forecast bars \(declared and estimated\) are stacked .* 2026 and 2027\./);
    expect(chart.getAttribute('aria-label')).toContain('Forecast next 12 months');

    await user.click(within(card()).getByText('Show data table'));
    const forecast = screen.getByRole('table', { name: 'Dividend forecast and trend per month' });
    expect(within(forecast).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Received', 'Declared', 'Estimated', 'Trend']);
    const rows = within(forecast).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(within(row).getAllByRole('cell')[0]).toHaveTextContent(/Forecast/);
    // the plain year table is still there
    expect(screen.getByRole('table', { name: 'Dividends received per calendar month and year' })).toBeInTheDocument();
  });

  it('hides the forecast with the checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('forecast-summary');
    const toggle = screen.getByRole('checkbox', { name: 'Show forecast' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(within(card()).getByTestId('growth-legend')).not.toHaveTextContent('forecast');
    expect(screen.getByTestId('year-compare-chart').getAttribute('aria-label')).not.toContain('Forecast bars');
    await user.click(within(card()).getByText('Show data table'));
    expect(screen.queryByRole('table', { name: 'Dividend forecast and trend per month' })).not.toBeInTheDocument();
  });

  it('switches to the timeline with the average and the trend line', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('year-compare-chart');
    await screen.findByTestId('forecast-summary');
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    const chart = await screen.findByTestId('growth-timeline-chart');
    expect(screen.queryByTestId('year-compare-chart')).not.toBeInTheDocument();
    expect(chart.getAttribute('aria-label')).toMatch(/^Dividends received per month from .*, with forecast bars and a trend line\. Forecast next 12 months/);
    const legend = within(card()).getByTestId('growth-legend');
    for (const text of ['Received', '12-month average', 'Trend', 'Trend (projected)']) expect(legend).toHaveTextContent(text);
    expect(screen.getByTestId('growth-stats')).toBeInTheDocument();

    await user.click(within(card()).getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividends received, forecast and trend per month' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 24 + 12);
    expect(within(table).getAllByText(/Forecast/).length).toBe(12);

    await user.click(screen.getByRole('checkbox', { name: 'Show forecast' }));
    expect(screen.getByTestId('growth-timeline-chart').getAttribute('aria-label')).toContain('forecast hidden');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 24 + 1);
  });

  it('asks for 6 months of history instead of drawing a trend', async () => {
    const user = userEvent.setup();
    growthWith(growth.byMonth.slice(-3));
    renderWithProviders(<DividendGrowthCard />);
    expect(await screen.findByTestId('trend-note')).toHaveTextContent('Needs at least 6 months of dividend history');
    expect(within(card()).getByTestId('forecast-summary')).not.toHaveTextContent('Trend:');
    expect(within(card()).getByTestId('growth-legend')).not.toHaveTextContent('Average of years');
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    expect(screen.getByTestId('trend-note')).toBeInTheDocument();
    expect(within(card()).getByTestId('growth-legend')).not.toHaveTextContent('Trend');
  });

  it('works without the forecast data: loading, then an error with retry', async () => {
    const user = userEvent.setup();
    server.use(http.get(OVERVIEW, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }), { once: true }));
    renderWithProviders(<DividendGrowthCard />);
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
    const status = await within(card()).findByText(/Forecast unavailable/);
    expect(screen.getByRole('checkbox', { name: 'Show forecast' })).toBeDisabled();
    expect(within(card()).getByTestId('growth-legend')).not.toHaveTextContent('forecast');
    await user.click(within(status.parentElement!).getByRole('button', { name: 'Try again' }));
    expect(await within(card()).findByTestId('forecast-summary')).toHaveTextContent('Forecast next 12 months');
    expect(screen.getByRole('checkbox', { name: 'Show forecast' })).toBeEnabled();
    expect(screen.queryByText(/Forecast unavailable/)).not.toBeInTheDocument();
  });

  it('says that the forecast is loading', async () => {
    server.use(http.get(OVERVIEW, async () => new Promise<Response>(() => undefined)));
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('year-compare-chart');
    expect(within(card()).getByTestId('forecast-status')).toHaveTextContent('Loading forecast…');
  });

  it('keeps the empty state without dividends', async () => {
    growthWith([]);
    renderWithProviders(<DividendGrowthCard />);
    expect(await screen.findByText(/No dividends received yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('year-compare-chart')).not.toBeInTheDocument();
  });
});
