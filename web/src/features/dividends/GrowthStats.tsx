import type { DividendGrowthStats } from '@portfolio/shared';
import { growthTiles, type StatTile, type StatTone } from './growthStatsView';

/** Light themes use the 700 shades (>= 4.5:1 on the tile), dark themes the 300 shades. */
const TONE_CLASS: Record<StatTone, string> = {
  gain: 'text-emerald-700 dark:text-emerald-300',
  loss: 'text-red-700 dark:text-red-300',
  flat: 'text-slate-700 dark:text-slate-200',
  none: 'text-slate-700 dark:text-slate-200',
};

function Tile({ tile }: Readonly<{ tile: StatTile }>) {
  return (
    <li className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/50" data-testid={`growth-stat-${tile.id}`}>
      <h3 className="text-xs font-medium tracking-wide text-slate-600 uppercase dark:text-slate-400">{tile.label}</h3>
      <p className={`mt-1 flex flex-wrap items-baseline gap-x-2 ${TONE_CLASS[tile.tone]}`}>
        <span className="text-2xl font-semibold tracking-tight tabular-nums" data-testid={`growth-stat-${tile.id}-value`}>
          {tile.arrow && (
            <span aria-hidden="true" className="mr-1 text-base">
              {tile.arrow}
            </span>
          )}
          {tile.value}
        </span>
        {tile.change && (
          <span className="text-sm font-medium tabular-nums" data-testid={`growth-stat-${tile.id}-change`}>
            · {tile.change}
          </span>
        )}
      </p>
      <p className="mt-1 text-xs break-words text-slate-600 dark:text-slate-400" data-testid={`growth-stat-${tile.id}-periods`}>
        {tile.subtext}
      </p>
      <details className="mt-2 text-xs text-slate-700 dark:text-slate-300">
        <summary className="w-fit cursor-pointer rounded font-medium text-brand-700 select-none hover:underline dark:text-brand-400">How is this calculated?</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          {tile.amounts.length > 0 && (
            <ul className="space-y-0.5 font-medium tabular-nums">
              {tile.amounts.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {tile.method.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </details>
    </li>
  );
}

/** Quarter-over-quarter, year-over-year and all-time compound growth of the dividends received, under the Dividend growth chart. */
export function GrowthStats({ stats, currency }: Readonly<{ stats: DividendGrowthStats; currency: string }>) {
  return (
    <ul aria-label="Dividend growth figures" className="mt-4 grid grid-cols-1 items-start gap-3 md:grid-cols-3" data-testid="growth-stats">
      {growthTiles(stats, currency).map((tile) => (
        <Tile key={tile.id} tile={tile} />
      ))}
    </ul>
  );
}
