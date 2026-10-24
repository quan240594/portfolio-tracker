import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/utils';
import { ValuedAtCostNote, valuedAtCostText } from './ValuedAtCostNote';

describe('valuedAtCostText', () => {
  it('names the numbers and the day in dd-mm-yyyy', () => {
    expect(valuedAtCostText({ symbols: ['A', 'B', 'C'], held: 26, until: '2026-10-23' })).toBe('3 of 26 holdings have no price history before 23-10-2026; they are valued at cost until then');
  });

  it('uses the singular for one holding of one', () => {
    expect(valuedAtCostText({ symbols: ['A'], held: 1, until: '2026-01-05' })).toBe('1 of 1 holding has no price history before 05-01-2026; it is valued at cost until then');
  });

  it('uses the singular verb with one of several', () => {
    expect(valuedAtCostText({ symbols: ['A'], held: 4, until: '2026-01-05' })).toBe('1 of 4 holdings has no price history before 05-01-2026; it is valued at cost until then');
  });
});

describe('ValuedAtCostNote', () => {
  it('is a short paragraph with a link to the coverage card', () => {
    renderWithProviders(<ValuedAtCostNote valuedAtCost={{ symbols: ['A', 'B'], held: 5, until: '2026-10-23' }} />);
    const note = screen.getByTestId('valued-at-cost-note');
    expect(note.tagName).toBe('P');
    expect(note).toHaveTextContent('2 of 5 holdings have no price history before 23-10-2026; they are valued at cost until then (details)');
    expect(screen.getByRole('link', { name: 'details' })).toHaveAttribute('href', '/settings/diagnostics#price-coverage');
  });
});
