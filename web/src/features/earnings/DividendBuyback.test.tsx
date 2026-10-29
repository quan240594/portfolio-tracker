import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleDemoSummaries, sampleSummary, type EarningsStatusResponse, type EarningsSummary } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { CheckedSection } from './CheckedSection';
import { EarningsCard } from './EarningsCard';

const [bank, saas] = sampleDemoSummaries() as [EarningsSummary, EarningsSummary];
const renderCard = (summary: EarningsSummary, variant: 'full' | 'compact' = 'full') => renderWithProviders(<EarningsCard summary={summary} variant={variant} />);

describe('the dividend and share buybacks on a card', () => {
  it('shows a raised dividend and the buyback after the headline figures, with an icon and the words', () => {
    renderCard(bank);
    const list = screen.getByRole('list', { name: 'Dividend and share buybacks' });
    const [dividend, buyback] = within(list).getAllByRole('listitem');
    expect(dividend).toHaveTextContent('Dividend: US$ 1,25 per share (quarterly), raised 4,2% (+US$ 0,05), paid 27-11-2026 to holders of record 06-11-2026');
    expect(dividend!.querySelector('svg[data-icon="up"]')).toBeInTheDocument();
    expect(buyback).toHaveTextContent('Share buybacks: repurchased $1.5B (24M shares) this quarter; $4.5B authorization remaining');
    const growth = screen.getByRole('list', { name: 'Growth' });
    expect(growth.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says N/A and why for a release without either', () => {
    renderCard(saas);
    const [dividend, buyback] = within(screen.getByRole('list', { name: 'Dividend and share buybacks' })).getAllByRole('listitem');
    expect(dividend).toHaveTextContent('Dividend: N/A · No dividend announced');
    expect(buyback).toHaveTextContent('Share buybacks: N/A · No share buyback mentioned');
  });

  it('says "not read yet" for a summary of the previous schema version, never N/A', () => {
    const { dividend: _dividend, buyback: _buyback, ...old } = sampleSummary({ schemaVersion: 1 });
    renderCard(old);
    const items = within(screen.getByRole('list', { name: 'Dividend and share buybacks' })).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Dividend and buyback: not read yet');
    expect(screen.queryByText(/N\/A/)).not.toBeInTheDocument();
  });

  it('is on the compact card too (the latest earnings of an asset)', () => {
    renderCard(bank, 'compact');
    expect(screen.getByRole('list', { name: 'Dividend and share buybacks' })).toHaveTextContent('raised 4,2%');
  });

  it('shows a cut and a dividend that could not be read, each as words', () => {
    renderCard(sampleSummary({ dividend: { status: 'announced', perShare: 0.3, currency: 'USD', action: 'cut', changePct: -50, changeAmount: -0.3 }, buyback: { status: 'not-found' } }));
    const [dividend, buyback] = within(screen.getByRole('list', { name: 'Dividend and share buybacks' })).getAllByRole('listitem');
    expect(dividend).toHaveTextContent('cut 50,0% (−US$ 0,30)');
    expect(dividend!.querySelector('svg[data-icon="down"]')).toBeInTheDocument();
    expect(buyback).toHaveTextContent('could not be read reliably');
  });
});

describe('the progress text of the pass that reads stored summaries again', () => {
  const status: EarningsStatusResponse = {
    available: true,
    configured: true,
    missing: [],
    estimatesConfigured: false,
    backfill: { status: 'running', quarters: 4, total: 8, done: 8, stored: 8, failed: 0, planned: 2, companies: 2, upgrade: { total: 8, done: 3 } },
    symbols: [],
  };

  it('is part of "Reading the latest quarters", next to the releases read', () => {
    renderWithProviders(<CheckedSection status={status} hasSummaries={false} />);
    const section = screen.getByRole('region', { name: 'Reading the latest quarters' });
    expect(section).toHaveTextContent('8 of 8 releases read');
    expect(section).toHaveTextContent('Dividend and buyback: read for 3 of 8 stored quarters so far.');
  });

  it('is left out when no such pass is running', () => {
    renderWithProviders(<CheckedSection status={{ ...status, backfill: { ...status.backfill!, upgrade: undefined } }} hasSummaries={false} />);
    expect(screen.queryByText(/Dividend and buyback:/)).not.toBeInTheDocument();
  });
});
