import type { CalendarMonth } from '@portfolio/shared';
import { formatMoney, formatMonth } from '../../lib/format';
import { INCOME_SERIES, seriesName } from './incomeChartModel';
import type { IncomeColours } from './calendarColours';

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: CalendarMonth }[];
  currency: string;
  colours: IncomeColours;
  background: string;
  border: string;
  text: string;
}

/** Month tooltip listing the amount per status (zero rows are kept so the three statuses always read the same) and the total. */
export function IncomeTooltip({ active, payload, currency, colours, background, border, text }: Readonly<TooltipProps>) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border px-3 py-2 text-xs shadow-md" style={{ background, borderColor: border, color: text }} data-testid="calendar-income-tooltip">
      <p className="mb-1 font-semibold">{formatMonth(row.month)}</p>
      <ul className="m-0 list-none p-0">
        {INCOME_SERIES.map((key) => (
          <li key={key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm border"
                style={{ background: colours[key].fill, borderColor: colours[key].stroke, borderStyle: key === 'estimated' ? 'dashed' : 'solid' }}
              />
              {seriesName(key)}
            </span>
            <span className="tabular-nums">{formatMoney(row[key], currency)}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1 flex justify-between gap-4 border-t pt-1 font-semibold" style={{ borderColor: border }}>
        <span>Total</span>
        <span className="tabular-nums">{formatMoney(row.total, currency)}</span>
      </p>
    </div>
  );
}

/** Legend text in the normal text colour (Recharts would colour it like the pale bar fill, which is unreadable). */
export function legendLabel(value: unknown) {
  return <span className="text-slate-700 dark:text-slate-200">{seriesName(value)}</span>;
}
