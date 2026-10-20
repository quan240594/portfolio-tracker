import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalyticsMetricsResponse } from '@portfolio/shared';
import { PeCard } from './PeCard';
import { SharpeCard, SortinoCard, VolatilityCard } from './RiskCards';
import { TwrCard } from './TwrCard';
import { metricsFixture } from './testData';

const verdict = <L extends string>(level: L, label: string, tone: 'positive' | 'neutral' | 'caution' | 'negative') => ({ level, label, tone });

const card = (name: string) => screen.getByTestId(`metric-${name}`);

describe('TwrCard', () => {
  it('shows the lifetime TWR, the benchmark chip and who is ahead', () => {
    render(<TwrCard data={metricsFixture()} />);
    expect(screen.getByRole('heading', { name: 'Portfolio TWR' })).toBeInTheDocument();
    expect(screen.getByTestId('twr-value')).toHaveTextContent('+38,1%');
    expect(screen.getByText(/Time-weighted return since 02-06-2025 \(500 days\)/)).toBeInTheDocument();
    expect(card('twr')).toHaveTextContent('IWDA.AS: +45,9%(▼ 7,8 pp)');
    expect(screen.getByText('You are 7,8 pp behind IWDA.AS over the same period.')).toBeInTheDocument();
    expect(screen.queryByText(/Less than a year/)).not.toBeInTheDocument();
    expect(screen.getByTestId('twr-bar-portfolio')).toHaveStyle({ width: '83%' });
    expect(screen.getByTestId('twr-bar-benchmark')).toHaveStyle({ width: '100%' });
  });

  it('words an outperformance and a tie', () => {
    const { rerender } = render(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, difference: 3.2 } })} />);
    expect(card('twr')).toHaveTextContent('(▲ 3,2 pp)');
    expect(screen.getByText('You are 3,2 pp ahead of IWDA.AS over the same period.')).toBeInTheDocument();
    rerender(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, difference: 0 } })} />);
    expect(screen.getByText('You are 0,0 pp level with IWDA.AS over the same period.')).toBeInTheDocument();
  });

  it('colours a negative return and notes a short history', () => {
    render(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, portfolio: -4.2, days: 120 } })} />);
    expect(screen.getByTestId('twr-value')).toHaveTextContent('\u22124,2%');
    expect(screen.getByTestId('twr-value')).toHaveClass('loss-text');
    expect(screen.getByTestId('twr-bar-portfolio').className).toContain('bg-red-400');
    expect(screen.getByText(/Less than a year of history/)).toBeInTheDocument();
  });

  it('explains when the benchmark history starts after your first purchase', () => {
    render(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, benchmarkFrom: '2025-09-01' } })} />);
    expect(screen.getByText(/IWDA.AS price history only starts on 01-09-2025/)).toBeInTheDocument();
  });

  it('degrades when the benchmark has no data', () => {
    const data = metricsFixture({ benchmark: { symbol: 'IWDA.AS', available: false, message: 'No data' }, twr: { ...metricsFixture().twr, benchmark: null, difference: null, benchmarkFrom: null } });
    render(<TwrCard data={data} />);
    expect(screen.getByText('Benchmark comparison unavailable.')).toBeInTheDocument();
    expect(screen.getByTestId('twr-value')).toBeInTheDocument();
  });

  it('degrades when the benchmark is available but the window is too short to compare', () => {
    render(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, benchmark: null, difference: null } })} />);
    expect(screen.getByText('No IWDA.AS comparison available for this period.')).toBeInTheDocument();
  });

  it('shows an empty state without a return', () => {
    render(<TwrCard data={metricsFixture({ twr: { ...metricsFixture().twr, portfolio: null, from: null } })} />);
    expect(screen.getByText(/Not enough history yet: a time-weighted return/)).toBeInTheDocument();
    expect(screen.queryByTestId('twr-value')).not.toBeInTheDocument();
  });

  it('has an info section with the formula', async () => {
    render(<TwrCard data={metricsFixture()} />);
    const details = card('twr').querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    await userEvent.setup().click(within(details).getByText('How this is calculated'));
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText(/∏ \(1 \+ daily return\) − 1/)).toBeInTheDocument();
  });
});

describe('PeCard', () => {
  it('shows the P/E, the gauge, the coverage line and the excluded stocks', () => {
    render(<PeCard data={metricsFixture()} />);
    expect(screen.getByTestId('pe-value')).toHaveTextContent('25,4×');
    expect(screen.getByTestId('pe-coverage')).toHaveTextContent('Based on 4 of 5 stocks, 42% of portfolio value.');
    expect(screen.getByText(/the stocks you hold are covered for 83% of their value/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Price/earnings ratio, portfolio' })).toHaveAttribute('value', '25.43');
    expect(screen.getByText('1 stock left out')).toBeInTheDocument();
    expect(screen.getByText('JNJ (Johnson & Johnson): no earnings data')).toBeInTheDocument();
    expect(screen.getByText('IWDA.AS has no P/E of its own, so there is no market marker.')).toBeInTheDocument();
    expect(screen.queryByTestId('gauge-dot-benchmark')).not.toBeInTheDocument();
    expect(screen.getByText('Earnings data as of 06-10-2026.')).toBeInTheDocument();
  });

  it('adds a market marker when the benchmark has a P/E', () => {
    const data = metricsFixture();
    render(<PeCard data={{ ...data, pe: { ...data.pe, benchmark: 19.5 } }} />);
    expect(screen.getByTestId('gauge-dot-benchmark')).toBeInTheDocument();
    expect(screen.getByText('19,5×')).toBeInTheDocument();
    expect(screen.queryByText(/has no P\/E of its own/)).not.toBeInTheDocument();
  });

  it('flags earnings data older than 90 days and words one-stock coverage', () => {
    const data = metricsFixture();
    const pe = {
      ...data.pe,
      asOf: '2026-01-01',
      excluded: [{ symbol: 'LOSS', name: 'Loss Co', reason: 'non-positive' as const, marketValue: 10 }, ...data.pe.excluded],
      coverage: { ...data.pe.coverage, includedStocks: 1, totalStocks: 1, nonStockHoldings: 0 },
    };
    render(<PeCard data={{ ...data, pe }} />);
    expect(screen.getByTestId('pe-coverage')).toHaveTextContent('Based on 1 of 1 stock,');
    expect(screen.getByText(/more than 90 days ago/)).toBeInTheDocument();
    expect(screen.getByText('2 stocks left out')).toBeInTheDocument();
    expect(screen.getByText('LOSS (Loss Co): no positive earnings')).toBeInTheDocument();
    expect(screen.queryByText(/ETFs, crypto and other holdings/)).not.toBeInTheDocument();
  });

  it('shows no earnings-date line when none is known', () => {
    const data = metricsFixture();
    render(<PeCard data={{ ...data, pe: { ...data.pe, asOf: null, excluded: [] } }} />);
    expect(screen.queryByText(/Earnings data as of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left out/)).not.toBeInTheDocument();
  });

  it('explains missing earnings data when no stock has a P/E, with coverage', () => {
    const data = metricsFixture();
    const pe: AnalyticsMetricsResponse['pe'] = {
      portfolio: null,
      benchmark: null,
      coverage: { includedStocks: 0, totalStocks: 2, nonStockHoldings: 1, includedValue: 0, stockValue: 500, portfolioValue: 1000, portfolioSharePct: 0, stockSharePct: 0 },
      excluded: [
        { symbol: 'AAA', name: 'Alpha', reason: 'missing', marketValue: 300 },
        { symbol: 'BBB', name: 'Beta', reason: 'non-positive', marketValue: 200 },
      ],
      asOf: null,
    };
    render(<PeCard data={{ ...data, pe }} />);
    expect(screen.getByTestId('pe-empty')).toHaveTextContent(/Earnings data is missing/);
    expect(screen.getByTestId('pe-empty')).toHaveTextContent(/companies without positive earnings have none/);
    expect(screen.getByTestId('pe-coverage')).toHaveTextContent('Based on 0 of 2 stocks, 0% of portfolio value.');
    expect(screen.queryByTestId('pe-value')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('2 stocks left out')).toBeInTheDocument();
  });

  it('explains that P/E needs individual stocks when the portfolio has none', () => {
    const data = metricsFixture();
    const pe: AnalyticsMetricsResponse['pe'] = {
      ...data.pe,
      portfolio: null,
      coverage: { ...data.pe.coverage, includedStocks: 0, totalStocks: 0, nonStockHoldings: 2, stockSharePct: 0, portfolioSharePct: 0 },
      excluded: [],
    };
    render(<PeCard data={{ ...data, pe }} />);
    expect(screen.getByTestId('pe-empty')).toHaveTextContent('No individual stocks.');
    expect(screen.getByTestId('pe-coverage')).toHaveTextContent('Based on 0 of 0 stocks, 0% of portfolio value.');
  });

  it('documents the harmonic-mean method', () => {
    render(<PeCard data={metricsFixture()} />);
    expect(within(card('pe')).getByText(/weighted harmonic mean/)).toBeInTheDocument();
    expect(within(card('pe')).getByText(/P\/E 10 and 40 give 16, not 25/)).toBeInTheDocument();
  });
});

describe('VolatilityCard', () => {
  it('states the verdict with beta and shows both markers', () => {
    render(<VolatilityCard data={metricsFixture()} />);
    expect(screen.getByRole('heading', { name: 'Volatility / beta' })).toBeInTheDocument();
    expect(card('volatility')).toHaveTextContent('Volatility of your portfolio (β = 0,679) — lower than the market');
    expect(screen.getByText('lower than the market')).toBeInTheDocument();
    expect(screen.getByText('12,3%')).toBeInTheDocument();
    expect(screen.getByText('15,1%')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Annualised volatility, portfolio' })).toHaveAttribute('value', '12.3');
    expect(screen.getByText(/Verdict: lower than the market\./)).toBeInTheDocument();
    expect(screen.getByText('Market = IWDA.AS, calculated the same way over the same period.')).toBeInTheDocument();
    expect(screen.queryByText(/Short history/)).not.toBeInTheDocument();
  });

  it('widens the scale for very volatile portfolios', () => {
    const data = metricsFixture();
    render(<VolatilityCard data={{ ...data, volatility: { ...data.volatility, portfolio: 62, verdict: verdict('higher', 'higher than the market', 'caution'), beta: 1.8 } }} />);
    expect(card('volatility')).toHaveTextContent('higher than the market');
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('max', '70');
  });

  it('labels every end of an odd-sized scale', () => {
    const data = metricsFixture();
    render(<VolatilityCard data={{ ...data, volatility: { ...data.volatility, portfolio: 85, benchmark: 20 } }} />);
    expect(screen.getByRole('meter')).toHaveAttribute('max', '90');
    for (const tick of ['0%', '20%', '80%', '90%']) expect(screen.getByText(tick)).toBeInTheDocument();
    expect(screen.queryByText('10%')).not.toBeInTheDocument();
  });

  it('warns about a short history', () => {
    const data = metricsFixture();
    render(<VolatilityCard data={{ ...data, volatility: { ...data.volatility, observations: 42 } }} />);
    expect(screen.getByText(/Short history: these figures rest on only 42 trading days/)).toBeInTheDocument();
    expect(screen.getByTestId('gauge-dot-portfolio')).toBeInTheDocument();
  });

  it('explains too little history instead of a gauge', () => {
    const data = metricsFixture();
    const volatility = { ...data.volatility, portfolio: null, benchmark: null, beta: null, verdict: null, observations: 7 };
    render(<VolatilityCard data={{ ...data, volatility }} />);
    expect(screen.getByText(/Not enough history yet: risk figures need at least 20 trading days of returns, you have 7/)).toBeInTheDocument();
    expect(card('volatility')).toHaveTextContent('Volatility of your portfolio');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('shows the volatility without a verdict when the benchmark has no data', () => {
    const data = metricsFixture({ benchmark: { symbol: 'IWDA.AS', available: false, message: 'No data' } });
    const volatility = { ...data.volatility, benchmark: null, beta: null, verdict: null };
    render(<VolatilityCard data={{ ...data, volatility }} />);
    expect(screen.getByText('No market marker: IWDA.AS has no price data.')).toBeInTheDocument();
    expect(screen.getByText('Beta, and so the verdict, needs IWDA.AS price data over the same period.')).toBeInTheDocument();
    expect(screen.queryByTestId('gauge-dot-benchmark')).not.toBeInTheDocument();
  });

  it('documents the beta bands', () => {
    render(<VolatilityCard data={metricsFixture()} />);
    expect(within(card('volatility')).getByText(/below 0,9 lower than the market, 0,9 to 1,1 in line with the market, above 1,1 higher/)).toBeInTheDocument();
  });
});

describe('SharpeCard', () => {
  it('states the ratio and verdict with a banded gauge', () => {
    render(<SharpeCard data={metricsFixture()} />);
    expect(screen.getByRole('heading', { name: 'Risk-adjusted return / Sharpe ratio' })).toBeInTheDocument();
    expect(card('sharpe')).toHaveTextContent('Sharpe ratio = 0,787 — requires attention');
    expect(screen.getByRole('meter', { name: 'Sharpe ratio, portfolio' })).toHaveAttribute('value', '0.787');
    expect(screen.getByText('1,050')).toBeInTheDocument();
    expect(within(card('sharpe')).getByText(/constant risk-free rate of 2,5% a year/)).toBeInTheDocument();
    expect(within(card('sharpe')).getByText(/below 0 poor, 0 up to 1 requires attention, 1 to 2 good, above 2 very good/)).toBeInTheDocument();
  });

  it('words a good and a very good ratio and handles a missing market marker', () => {
    const data = metricsFixture();
    const sharpe = { ...data.sharpe, portfolio: 2.4, benchmark: null, verdict: verdict('very-good', 'very good', 'positive') };
    render(<SharpeCard data={{ ...data, sharpe }} />);
    expect(card('sharpe')).toHaveTextContent('Sharpe ratio = 2,400 — very good');
    expect(screen.getByText('No market marker: there is not enough overlapping history.')).toBeInTheDocument();
  });

  it('warns about a short history and shows a dash without a figure', () => {
    const data = metricsFixture();
    const { rerender } = render(<SharpeCard data={{ ...data, sharpe: { ...data.sharpe, observations: 25 } }} />);
    expect(screen.getByText(/Short history: these figures rest on only 25 trading days/)).toBeInTheDocument();
    rerender(<SharpeCard data={{ ...data, sharpe: { ...data.sharpe, portfolio: null, benchmark: null, verdict: null, observations: 3 } }} />);
    expect(card('sharpe')).toHaveTextContent('Sharpe ratio = —');
    expect(screen.getByText(/you have 3/)).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('shows a negative ratio as poor', () => {
    const data = metricsFixture();
    render(<SharpeCard data={{ ...data, sharpe: { ...data.sharpe, portfolio: -0.4, verdict: verdict('poor', 'poor', 'negative') } }} />);
    expect(card('sharpe')).toHaveTextContent('Sharpe ratio = \u22120,400 — poor');
  });
});

describe('SortinoCard', () => {
  it('states the ratio and verdict', () => {
    render(<SortinoCard data={metricsFixture()} />);
    expect(screen.getByRole('heading', { name: 'Risk-adjusted return / Sortino ratio' })).toBeInTheDocument();
    expect(card('sortino')).toHaveTextContent('Sortino ratio = 1,310 — acceptable');
    expect(screen.getByRole('meter', { name: 'Sortino ratio, portfolio' })).toHaveAttribute('max', '4');
    expect(within(card('sortino')).getByText(/over two is considered to be good/)).toBeInTheDocument();
  });

  it('warns about a short history and explains missing data', () => {
    const data = metricsFixture();
    const { rerender } = render(<SortinoCard data={{ ...data, sortino: { ...data.sortino, observations: 59 } }} />);
    expect(screen.getByText(/Short history: these figures rest on only 59 trading days/)).toBeInTheDocument();
    rerender(<SortinoCard data={{ ...data, sortino: { ...data.sortino, observations: 60 } }} />);
    expect(screen.queryByText(/Short history/)).not.toBeInTheDocument();
    rerender(<SortinoCard data={{ ...data, sortino: { ...data.sortino, portfolio: null, benchmark: null, verdict: null, observations: 0 } }} />);
    expect(card('sortino')).toHaveTextContent('Sortino ratio = —');
  });
});
