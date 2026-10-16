import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AllocationSlice } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney, formatWeight } from '../../lib/format';
import { SERIES_COLORS, chartTheme } from './palette';
import { moneyTooltip } from './chartFormatters';
import { LegendSwatch, NothingSelected, SelectableLegend, SelectableTable, focusOpacity, useSliceSelection, visibleSliceTotal, visibleSlices } from './selection';

const MAX_SLICES = 8;

/** Collapse the long tail into "Other" so the legend stays readable. */
function topSlices(slices: AllocationSlice[]): AllocationSlice[] {
  if (slices.length <= MAX_SLICES) return slices;
  const head = slices.slice(0, MAX_SLICES - 1);
  const tail = slices.slice(MAX_SLICES - 1);
  return [
    ...head,
    { key: '__other', label: 'Other', value: tail.reduce((s, x) => s + x.value, 0), weight: tail.reduce((s, x) => s + x.weight, 0) },
  ];
}

const prettyLabel = (label: string) =>
  /^[A-Z]+$/.test(label) && label.length > 3 ? label.charAt(0) + label.slice(1).toLowerCase() : label;

/** Share and value describe the slice, they are not series of their own: only the rows (slices) toggle. */
const TABLE_COLUMNS = [
  { key: 'value', label: 'Value', selectable: false },
  { key: 'share', label: 'Share', selectable: false },
];

interface Props {
  slices: AllocationSlice[];
  currency: string;
  /** What the slices divide, e.g. "Asset class": the heading of the table's first column and part of the chart's label. */
  dimension?: string;
}

/**
 * Allocation donut, legend and table of one set of slices. A slice is a legend entry AND a table row (one state); the shares and the total in
 * the middle are recomputed over the slices that are not excluded.
 */
export function AllocationDonut({ slices, currency, dimension = 'Category' }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  // colours follow the position among ALL slices, so a slice keeps its colour while others are excluded
  const data = useMemo(() => topSlices(slices).map((s, i) => ({ ...s, label: prettyLabel(s.label), color: SERIES_COLORS[i % SERIES_COLORS.length]! })), [slices]);
  const selection = useSliceSelection(data.map((s) => s.key));
  const { isSeriesVisible } = selection;
  // a hover preview must not rebuild the slices: they change with the include/exclude state only
  const shown = useMemo(() => visibleSlices(data, { isSeriesVisible }), [data, isSeriesVisible]);
  const shownTotal = visibleSliceTotal(data, selection);
  const shareOf = new Map(shown.map((s) => [s.key, selection.hasHidden ? s.share : s.weight]));
  const parts = shown.map((s) => `${s.label} ${formatWeight(shareOf.get(s.key)!)}`);
  const label = `Allocation by ${dimension.toLowerCase()}: ${parts.join(', ')}.`;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col 2xl:flex-row">
      {selection.nothingSelected ? (
        <div className="w-full shrink-0 sm:w-48 lg:w-full 2xl:w-48">
          <NothingSelected onShowAll={selection.reset} />
        </div>
      ) : (
        <div role="img" aria-label={label} data-testid="allocation-donut" className="chart-focus relative h-48 w-48 shrink-0">
          <div aria-hidden="true" data-testid="allocation-donut-centre" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-12 text-center text-xs leading-tight">
            <span className="font-semibold tabular-nums">{formatMoney(shownTotal, currency, { compact: true })}</span>
            <span className="muted">{selection.hasHidden ? 'selected' : 'total'}</span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={shown} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" paddingAngle={1.5} stroke="none" isAnimationActive={false}>
                {shown.map((d) => (
                  <Cell key={d.key} fill={d.color} fillOpacity={focusOpacity(selection.focusKey, d.key)} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                itemStyle={{ color: c.text }}
                formatter={moneyTooltip(currency)}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="w-full min-w-0 space-y-3">
        <SelectableLegend
          label={dimension}
          testId="allocation-legend"
          selection={selection}
          entries={data.map((d) => ({ key: d.key, label: d.label, swatch: <LegendSwatch color={d.color} /> }))}
        />
        <SelectableTable
          caption={`Allocation by ${dimension.toLowerCase()}`}
          rowHeader={dimension}
          columns={TABLE_COLUMNS}
          selection={selection}
          rows={data.map((d) => ({
            id: d.key,
            header: d.label,
            cells: [formatMoney(d.value, currency, { compact: true }), shareOf.has(d.key) ? formatWeight(shareOf.get(d.key)!) : '—'],
          }))}
        />
      </div>
    </div>
  );
}
