import type { ReactNode } from 'react';
import { DividendGrowthChart, hasPreviousSeries, type GrowthBar } from '../../components/charts/DividendGrowthChart';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { LegendSwatch, NothingSelected, SelectableLegend, selectRows, type SeriesSelection } from '../../components/charts/selection';
import { useTheme } from '../../theme/ThemeProvider';

interface Props {
  bars: readonly GrowthBar[];
  selection: SeriesSelection;
  currency: string;
  title: string;
  testId: string;
  currentName: string;
  previousName?: string;
  /** Plain content under the chart (a data table that shares the selection). */
  children?: ReactNode;
}

/** Series keys of a growth chart: the previous-year bars (when there are any) and the current ones. */
export const growthSeriesKeys = (bars: readonly GrowthBar[]): string[] => (hasPreviousSeries(bars) ? ['previous', 'current'] : ['current']);

/** Legend and chart of one growth chart. The periods are rows and the two bar series are columns of the shared selection. */
export function GrowthChartBlock({ bars, selection, currency, title, testId, currentName, previousName = 'A year earlier', children }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const entries = [
    ...(hasPreviousSeries(bars) ? [{ key: 'previous', label: previousName, swatch: <LegendSwatch color={c.previous} /> }] : []),
    { key: 'current', label: currentName, swatch: <LegendSwatch color={c.received} /> },
  ];
  return (
    <div>
      <SelectableLegend entries={entries} selection={selection} label={title} testId={`${testId}-legend`} />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <DividendGrowthChart
          bars={selectRows(bars, (b) => b.label, selection)}
          currency={currency}
          title={title}
          testId={testId}
          currentName={currentName}
          previousName={previousName}
          showCurrent={selection.isSeriesVisible('current')}
          showPrevious={selection.isSeriesVisible('previous')}
          filtered={selection.hasHidden}
          focusKey={selection.focusKey}
        />
      )}
      {children}
    </div>
  );
}
