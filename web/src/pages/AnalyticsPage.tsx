import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/Layout';
import { SegmentedControl } from '../components/SegmentedControl';
import { BenchmarkTab } from '../features/analytics/BenchmarkTab';
import { DividendGrowthTab } from '../features/analytics/DividendGrowthTab';
import { GoalTab } from '../features/analytics/GoalTab';
import { GrowthTab } from '../features/growth/GrowthTab';
import { ReturnsTab } from '../features/analytics/ReturnsTab';
import { RiskTab } from '../features/analytics/RiskTab';
import { MetricsTab } from '../features/metrics/MetricsTab';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';

export const ANALYTICS_TABS = [
  { value: 'growth', label: 'Growth' },
  { value: 'metrics', label: 'Metrics' },
  { value: 'returns', label: 'Returns' },
  { value: 'risk', label: 'Risk' },
  { value: 'benchmark', label: 'Benchmark' },
  { value: 'dividends', label: 'Dividend growth' },
  { value: 'goal', label: 'Income goal' },
] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number]['value'];

export const TAB_PARAM = 'tab';
const PANELS: Record<AnalyticsTab, () => React.JSX.Element> = {
  growth: GrowthTab,
  metrics: MetricsTab,
  returns: ReturnsTab,
  risk: RiskTab,
  benchmark: BenchmarkTab,
  dividends: DividendGrowthTab,
  goal: GoalTab,
};

export const isAnalyticsTab = (v: string | null): v is AnalyticsTab => ANALYTICS_TABS.some((t) => t.value === v);

const PANEL_ID = 'analytics-panel';
const ID_PREFIX = 'analytics-tab';

/** Analytics hub: growth (default), metrics, returns, risk, benchmark comparison, dividend growth and the income goal, one tab each (`?tab=`). */
export default function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const { scopeName } = usePortfolioScope();
  const requested = params.get(TAB_PARAM);
  const tab: AnalyticsTab = isAnalyticsTab(requested) ? requested : 'growth';
  const Panel = PANELS[tab];

  const select = (next: AnalyticsTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(TAB_PARAM, next);
        return n;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader title="Analytics" description={scopeName ? `${scopeName} · values in EUR` : undefined} />
      <div className="space-y-5">
        <div className="overflow-x-auto">
          <SegmentedControl variant="tabs" size="md" label="Analytics" options={ANALYTICS_TABS} value={tab} onChange={select} panelId={PANEL_ID} idPrefix={ID_PREFIX} />
        </div>
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={`${ID_PREFIX}-${tab}`} className={tab === 'growth' ? undefined : 'card p-4'}>
          <Panel />
        </div>
      </div>
    </>
  );
}
