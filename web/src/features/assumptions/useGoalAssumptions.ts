import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_INFLATION_AREA,
  averageInflation,
  defaultYieldPreset,
  ecbTargetInflation,
  suggestDividendGrowth,
  yieldCandidates,
  type AssumptionRange,
  type Clamped,
  type DividendGrowthSuggestion,
  type InflationArea,
  type InflationHorizon,
  type InflationResponse,
  type InflationSuggestion,
  type YieldPreset,
  type YieldSuggestion,
} from '@portfolio/shared';
import { useAnalyticsDividendGrowth } from '../../api/analyticsHooks';
import { errorMessage } from '../../api/client';
import { useInflation } from '../../api/inflationHooks';
import { useDividendsOverview } from '../dividends/useDividendsOverview';
import { inputText } from './assumptionText';

/** The three goal inputs the helpers fill; the names are the same in the Goals form and in the Analytics goal tab. */
export type AssumptionField = 'dividendGrowthPct' | 'yieldOnNewMoneyPct' | 'inflationPct';

export type GrowthMode = 'manual' | 'portfolio';
export type YieldMode = 'manual' | YieldPreset;
export type InflationMode = 'manual' | 'ecb' | 'target';

/** What a helper knows: still loading, failed (entry stays manual), or ready with a value. */
export type Source<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

export interface GrowthHelper {
  mode: GrowthMode;
  setMode(mode: GrowthMode): void;
  source: Source<DividendGrowthSuggestion>;
}

export interface YieldData {
  candidates: Record<YieldPreset, YieldSuggestion>;
  defaultPreset: YieldPreset;
  /** The portfolio's forward yield and its number of dividend payers: the facts behind the default. */
  portfolioYieldPct: number;
  payers: number;
  currency: string;
}

export interface YieldHelper {
  mode: YieldMode;
  setMode(mode: YieldMode): void;
  source: Source<YieldData>;
}

export type InflationData = { kind: 'none' } | { kind: 'target'; target: Clamped } | { kind: 'ecb'; series: InflationResponse; suggestion: InflationSuggestion };

export interface InflationHelper {
  mode: InflationMode;
  setMode(mode: InflationMode): void;
  area: InflationArea;
  setArea(area: InflationArea): void;
  horizon: InflationHorizon;
  setHorizon(horizon: InflationHorizon): void;
  source: Source<InflationData>;
}

export interface AssumptionsController {
  growth: GrowthHelper;
  yield: YieldHelper;
  /** Null where the form has no inflation input (the Analytics goal tab). */
  inflation: InflationHelper | null;
  /** The user typed in a helped input: its helper goes to Manual and stops following the data. */
  noteEdit(field: string): void;
}

export interface AssumptionOptions {
  scope: string;
  /** False while the scope is not known yet: nothing is fetched. */
  enabled?: boolean;
  /** The inputs' current text. */
  values: Readonly<Record<AssumptionField, string>>;
  /** Writes suggested text into inputs (one call may fill several). */
  fill: (patch: Partial<Record<AssumptionField, string>>) => void;
  ranges: Readonly<Record<'growth' | 'yield' | 'inflation', AssumptionRange>>;
  /** A goal nobody has saved yet: the yield starts on the "Dividend payers only" preset when the portfolio's own yield is misleading (see `defaultYieldPreset`). Otherwise every helper starts as Manual. */
  autoStart: boolean;
  /** Whether the form has an inflation input. */
  withInflation: boolean;
}

const ready = <T,>(value: T): Source<T> => ({ status: 'ready', value });

/**
 * One state machine for the three assumption helpers, shared by the Goals page and the Analytics goal tab. The inputs stay the
 * source of truth (the goal calculation only ever receives their numbers): a helper in a calculated mode writes the figure into its
 * input whenever it changes, and typing in the input switches that helper to Manual, which keeps the last figure. Modes are not saved.
 */
export function useGoalAssumptions({ scope, enabled = true, values, fill, ranges, autoStart, withInflation }: Readonly<AssumptionOptions>): AssumptionsController {
  const [growthChoice, setGrowthChoice] = useState<GrowthMode>();
  const [yieldChoice, setYieldChoice] = useState<YieldMode>();
  const [inflationMode, setInflationMode] = useState<InflationMode>('manual');
  const [area, setArea] = useState<InflationArea>(DEFAULT_INFLATION_AREA);
  const [horizon, setHorizon] = useState<InflationHorizon>('10y');

  const overview = useDividendsOverview(scope, { enabled });
  const perShare = useMemo(() => (overview.data ? suggestDividendGrowth(overview.data.holdings, null, ranges.growth) : null), [overview.data, ranges.growth]);
  const needsIncomeGrowth = perShare !== null && !perShare.available && perShare.reason === 'TOO_LITTLE_HISTORY';
  const incomeGrowth = useAnalyticsDividendGrowth(scope, { enabled: enabled && needsIncomeGrowth });
  const incomeCagr = incomeGrowth.data?.growthStats?.cagr;

  const growthSource = useMemo((): Source<DividendGrowthSuggestion> => {
    if (overview.isError) return { status: 'error', message: errorMessage(overview.error) };
    if (!overview.data || perShare === null) return { status: 'loading' };
    if (!needsIncomeGrowth) return ready(perShare);
    if (incomeGrowth.isLoading) return { status: 'loading' };
    return ready(suggestDividendGrowth(overview.data.holdings, incomeCagr, ranges.growth));
  }, [overview.isError, overview.error, overview.data, perShare, needsIncomeGrowth, incomeGrowth.isLoading, incomeCagr, ranges.growth]);

  const yieldSource = useMemo((): Source<YieldData> => {
    if (overview.isError) return { status: 'error', message: errorMessage(overview.error) };
    if (!overview.data) return { status: 'loading' };
    const { summary, holdings, baseCurrency } = overview.data;
    return ready({
      candidates: yieldCandidates(summary, holdings, ranges.yield),
      defaultPreset: defaultYieldPreset(summary, holdings),
      portfolioYieldPct: summary.yieldOnValuePct,
      payers: holdings.filter((h) => h.forward12m > 0).length,
      currency: baseCurrency,
    });
  }, [overview.isError, overview.error, overview.data, ranges.yield]);

  const inflationQuery = useInflation(area, { enabled: enabled && withInflation && inflationMode === 'ecb' });
  const inflationSource = useMemo((): Source<InflationData> => {
    if (inflationMode === 'manual') return ready({ kind: 'none' });
    if (inflationMode === 'target') return ready({ kind: 'target', target: ecbTargetInflation(ranges.inflation) });
    if (inflationQuery.isError) return { status: 'error', message: errorMessage(inflationQuery.error) };
    if (!inflationQuery.data) return { status: 'loading' };
    return ready({ kind: 'ecb', series: inflationQuery.data, suggestion: averageInflation(inflationQuery.data.points, horizon, ranges.inflation) });
  }, [inflationMode, inflationQuery.isError, inflationQuery.error, inflationQuery.data, horizon, ranges.inflation]);

  const growthMode: GrowthMode = growthChoice ?? 'manual';
  const defaultPreset = yieldSource.status === 'ready' ? yieldSource.value.defaultPreset : 'portfolio';
  const yieldMode: YieldMode = yieldChoice ?? (autoStart && defaultPreset === 'payers' ? 'payers' : 'manual');

  const growthTarget = growthMode === 'portfolio' && growthSource.status === 'ready' && growthSource.value.available ? inputText(growthSource.value.pct) : null;
  const yieldPick = yieldMode !== 'manual' && yieldSource.status === 'ready' ? yieldSource.value.candidates[yieldMode] : null;
  const yieldTarget = yieldPick?.available ? inputText(yieldPick.pct) : null;
  const inflationData = inflationSource.status === 'ready' ? inflationSource.value : null;
  let inflationTarget: string | null = null;
  if (inflationData?.kind === 'target') inflationTarget = inputText(inflationData.target.pct);
  else if (inflationData?.kind === 'ecb' && inflationData.suggestion.available) inflationTarget = inputText(inflationData.suggestion.pct);

  const { dividendGrowthPct, yieldOnNewMoneyPct, inflationPct } = values;
  useEffect(() => {
    const patch: Partial<Record<AssumptionField, string>> = {};
    if (growthTarget !== null && growthTarget !== dividendGrowthPct) patch.dividendGrowthPct = growthTarget;
    if (yieldTarget !== null && yieldTarget !== yieldOnNewMoneyPct) patch.yieldOnNewMoneyPct = yieldTarget;
    if (withInflation && inflationTarget !== null && inflationTarget !== inflationPct) patch.inflationPct = inflationTarget;
    if (Object.keys(patch).length > 0) fill(patch);
  }, [growthTarget, yieldTarget, inflationTarget, dividendGrowthPct, yieldOnNewMoneyPct, inflationPct, withInflation, fill]);

  return {
    growth: {
      mode: growthMode,
      setMode: setGrowthChoice,
      source: growthSource,
    },
    yield: {
      mode: yieldMode,
      setMode: setYieldChoice,
      source: yieldSource,
    },
    inflation: withInflation ? { mode: inflationMode, setMode: setInflationMode, area, setArea, horizon, setHorizon, source: inflationSource } : null,
    noteEdit: (field) => {
      if (field === 'dividendGrowthPct') setGrowthChoice('manual');
      else if (field === 'yieldOnNewMoneyPct') setYieldChoice('manual');
      else if (field === 'inflationPct') setInflationMode('manual');
    },
  };
}
