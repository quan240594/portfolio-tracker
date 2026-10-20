import { render, screen, within } from '@testing-library/react';
import type { ClassificationImportResponse } from '@portfolio/shared';
import { countReport, ImportReport } from './ImportReport';
import { REASON_LABELS } from './labels';

const response: ClassificationImportResponse = {
  dryRun: true,
  applied: 0,
  matched: [
    {
      index: 2,
      ticker: 'ACME',
      symbol: 'ACME.AS',
      matchedBy: 'isin',
      fields: { sector: 'Technology', assetClass: 'ETF' },
      changes: [
        { field: 'sector', from: null, to: 'Technology' },
        { field: 'assetClass', from: 'STOCK', to: 'ETF' },
      ],
    },
    { index: 0, ticker: 'FUND', symbol: 'FUND', matchedBy: 'ticker', fields: { name: 'Invented Fund' }, changes: [] },
  ],
  unmatched: [
    { index: 1, ticker: 'GONE', isin: 'US0000000002', reason: 'not-held' },
    { index: 3, ticker: 'TWIN', reason: 'ambiguous' },
    { index: 4, ticker: 'MISM', isin: 'NL0000000003', reason: 'isin-mismatch' },
    { index: 5, ticker: 'FUND', reason: 'duplicate' },
    { index: 6, ticker: 'NONE', reason: 'empty' },
  ],
};

describe('countReport', () => {
  it('counts rows, matches, matches with changes and unmatched rows', () => {
    expect(countReport(response)).toEqual({ rows: 7, matched: 2, withChanges: 1, unmatched: 5 });
    expect(countReport({ matched: [], unmatched: [] })).toEqual({ rows: 0, matched: 0, withChanges: 0, unmatched: 0 });
  });
});

describe('ImportReport', () => {
  it('lists every row in file order with what matched, what changes and why a row did not match', () => {
    render(<ImportReport response={response} issues={[]} caption="Import preview" />);
    const summary = within(screen.getByLabelText('Summary'));
    expect(summary.getByText('Rows read').nextElementSibling).toHaveTextContent('7');
    expect(summary.getByText('Matched').nextElementSibling).toHaveTextContent('2');
    expect(summary.getByText('With changes').nextElementSibling).toHaveTextContent('1');
    expect(summary.getByText('Not matched').nextElementSibling).toHaveTextContent('5');

    const table = screen.getByRole('table', { name: 'Import preview' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);

    expect(rows[0]).toHaveTextContent('FUNDmatches FUND by tickerNo change');
    expect(rows[1]).toHaveTextContent('GONEUS0000000002Not matched. Not one of your holdings');
    expect(rows[2]).toHaveTextContent('ACMEmatches ACME.AS by ISIN');
    expect(rows[2]).toHaveTextContent('Sector: not set → Technology');
    expect(rows[2]).toHaveTextContent('Asset class: Stock → ETF');
    expect(rows[3]).toHaveTextContent(REASON_LABELS.ambiguous);
    expect(rows[4]).toHaveTextContent(`NL0000000003Not matched. ${REASON_LABELS['isin-mismatch']}`);
    expect(rows[5]).toHaveTextContent(REASON_LABELS.duplicate);
    expect(rows[6]).toHaveTextContent(REASON_LABELS.empty);
    expect(screen.queryByRole('region', { name: 'Notes on the file' })).not.toBeInTheDocument();
  });

  it('lists the notes of the parser with their line numbers', () => {
    render(<ImportReport response={{ ...response, matched: [], unmatched: [] }} issues={[{ line: 7, message: 'Category "X" is not a known asset kind' }]} caption="Import result" />);
    const notes = screen.getByRole('region', { name: 'Notes on the file' });
    expect(within(notes).getByRole('listitem')).toHaveTextContent('Line 7: Category "X" is not a known asset kind');
    expect(screen.getByRole('table', { name: 'Import result' })).toBeInTheDocument();
  });
});
