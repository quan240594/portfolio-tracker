import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AllocationSlice } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney, formatWeight } from '../../lib/format';
import { SERIES_COLORS, chartTheme } from './palette';

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

export function AllocationDonut({ slices, currency }: { slices: AllocationSlice[]; currency: string }) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const data = topSlices(slices).map((s, i) => ({ ...s, label: prettyLabel(s.label), color: SERIES_COLORS[i % SERIES_COLORS.length]! }));

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col 2xl:flex-row">
      <div className="h-48 w-48 shrink-0" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" paddingAngle={1.5} stroke="none" isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
              itemStyle={{ color: c.text }}
              formatter={(v, name) => [formatMoney(Number(v), currency), String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full min-w-0 space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.color }} />
            <span className="truncate">{d.label}</span>
            <span className="muted ml-auto tabular-nums">{formatMoney(d.value, currency, { compact: true })}</span>
            <span className="w-14 text-right font-medium tabular-nums">{formatWeight(d.weight)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
