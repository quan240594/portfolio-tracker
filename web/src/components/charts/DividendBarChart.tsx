import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DividendOverview } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney, formatMonth } from '../../lib/format';
import { chartTheme } from './palette';
import { compactMoneyTick, dividendSeriesName, moneyTooltip, monthLabel } from './chartFormatters';

type Monthly = DividendOverview['monthly'];

const nextMonth = (yyyyMm: string) => {
  const [y, m] = yyyyMm.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** The API only returns months with payments; fill the gaps so the time axis is continuous. */
export function fillMonths(monthly: Monthly): Monthly {
  const first = monthly[0];
  const last = monthly.at(-1);
  if (!first || !last) return [];
  const byMonth = new Map(monthly.map((m) => [m.month, m]));
  const out: Monthly = [];
  for (let m = first.month; m <= last.month; m = nextMonth(m)) out.push(byMonth.get(m) ?? { month: m, received: 0, upcoming: 0 });
  return out;
}

export function DividendBarChart({ monthly: raw, currency }: { monthly: Monthly; currency: string }) {
  const monthly = fillMonths(raw);
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const total = monthly.reduce((s, m) => s + m.received + m.upcoming, 0);
  const label = `Monthly dividends across ${monthly.length} months, totalling ${formatMoney(total, currency)} received and upcoming.`;

  return (
    <div role="img" aria-label={label} className="h-72 w-full" data-testid="dividend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={monthly} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={formatMonth} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          <Tooltip
            cursor={{ fill: c.grid, opacity: 0.5 }}
            contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, color: c.text, fontSize: 12 }}
            labelFormatter={monthLabel}
            formatter={moneyTooltip(currency, dividendSeriesName)}
          />
          <Legend formatter={dividendSeriesName} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="received" stackId="d" fill={c.received} radius={[0, 0, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="upcoming" stackId="d" fill={c.upcoming} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
