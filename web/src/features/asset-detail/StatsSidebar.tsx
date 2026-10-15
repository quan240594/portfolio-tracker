import type { ReactNode } from 'react';
import type { AssetDetailResponse } from '@portfolio/shared';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { DASH, formatRatio } from './assetFormat';

/** A figure, or a dash that screen readers announce as "not available". */
export function Figure({ children }: Readonly<{ children: ReactNode | null }>) {
  if (children === null) {
    return (
      <>
        <span aria-hidden="true">{DASH}</span>
        <span className="sr-only">not available</span>
      </>
    );
  }
  return <span>{children}</span>;
}

function Row({ label, hint, children }: Readonly<{ label: string; hint?: string; children: ReactNode | null }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800/60">
      <dt className="muted min-w-0 text-sm" title={hint}>
        {label}
      </dt>
      <dd className="text-right text-sm font-medium tabular-nums">
        <Figure>{children}</Figure>
      </dd>
    </div>
  );
}

function Group({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-xs font-semibold tracking-wide uppercase text-slate-500 dark:text-slate-400">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

/** Estimate (P/E, EPS, beta) and dividend figures; anything that cannot be sourced or derived shows a dash. */
export function StatsSidebar({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { stats, profile, dividends } = detail;
  const dividendCurrency = dividends.currency ?? profile.currency;
  const growth = stats.dividendGrowth;
  return (
    <aside aria-label="Key figures" className="card min-w-0 space-y-5 p-4">
      <Group title="Estimate">
        <Row label="P/E ratio" hint="Price divided by trailing twelve-month earnings per share">
          {stats.peRatio === null ? null : formatRatio(stats.peRatio, 1)}
        </Row>
        <Row label="EPS" hint="Trailing twelve-month earnings per share">
          {stats.eps === null ? null : formatMoney(stats.eps, profile.currency)}
        </Row>
        <Row label="Beta" hint="Sensitivity to the market; 1 moves with it">
          {stats.beta === null ? null : formatRatio(stats.beta)}
        </Row>
      </Group>
      <Group title="Dividends">
        <Row label="Dividend yield" hint="Dividends paid over the last 12 months divided by the price">
          {stats.dividendYieldPct === null ? null : formatPercent(stats.dividendYieldPct)}
        </Row>
        <Row label="Annual payout" hint="Dividend per share over the last 12 months">
          {stats.annualDividend === null ? null : formatMoney(stats.annualDividend, dividendCurrency, { maxDigits: 4 })}
        </Row>
        <Row label="Next ex-dividend date">
          {stats.nextExDate === null ? null : formatDate(stats.nextExDate)}
        </Row>
        <Row label="Payout ratio" hint="Annual payout divided by EPS">
          {stats.payoutRatioPct === null ? null : formatPercent(stats.payoutRatioPct, { digits: 1 })}
        </Row>
        <Row label="Dividend growth" hint="Compound yearly growth of the dividend per share over the complete years we have stored">
          {growth === null ? null : `${formatPercent(growth.cagrPct, { signed: true })} / yr (${growth.years} yr)`}
        </Row>
        <Row label="Increase streak" hint="Consecutive most recent years in which the yearly dividend rose">
          {stats.dividendIncreaseStreak === null ? null : `${stats.dividendIncreaseStreak} yr`}
        </Row>
      </Group>
      <p className="muted text-xs">A dash means the figure is not available from the free data sources behind this app, or cannot be worked out from the history we store.</p>
    </aside>
  );
}
