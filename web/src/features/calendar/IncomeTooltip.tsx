import type { ReactNode } from 'react';
import type { CalendarMonth } from '@portfolio/shared';
import { formatMoney, formatMonth } from '../../lib/format';
import { INCOME_SERIES, seriesName, type IncomeSeries } from './incomeChartModel';
import type { IncomeColours } from './calendarColours';

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: CalendarMonth }[];
  currency: string;
  colours: IncomeColours;
  background: string;
  border: string;
  text: string;
  /** The statuses that are part of the chart (the others are excluded); default all three. */
  statuses?: readonly IncomeSeries[];
}

interface ShellProps {
  title: string;
  testId: string;
  background: string;
  border: string;
  text: string;
  children: ReactNode;
}

/** The tooltip box shared by the calendar income chart and the dividends chart. */
export function TooltipShell({ title, testId, background, border, text, children }: Readonly<ShellProps>) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs shadow-md" style={{ background, borderColor: border, color: text }} data-testid={testId}>
      <p className="mb-1 font-semibold">{title}</p>
      {children}
    </div>
  );
}

export interface StatusValues {
  paid: number;
  declared: number;
  estimated: number;
  total: number;
}

/** Amount per (visible) status (zero rows are kept so the statuses always read the same: swatch + name, not colour only) and the total of those. */
export function StatusAmounts({ row, currency, colours, border, statuses = INCOME_SERIES }: Readonly<{ row: StatusValues; currency: string; colours: IncomeColours; border: string; statuses?: readonly IncomeSeries[] }>) {
  return (
    <>
      <ul className="m-0 list-none p-0">
        {statuses.map((key) => (
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
    </>
  );
}

/** Month tooltip of the calendar income chart. */
export function IncomeTooltip({ active, payload, currency, colours, background, border, text, statuses }: Readonly<TooltipProps>) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <TooltipShell title={formatMonth(row.month)} testId="calendar-income-tooltip" background={background} border={border} text={text}>
      <StatusAmounts row={row} currency={currency} colours={colours} border={border} statuses={statuses} />
    </TooltipShell>
  );
}
