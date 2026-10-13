import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/utils';
import { Change } from './Change';

describe('Change', () => {
  it('shows amount and percentage together, trend driven by amount', () => {
    renderWithProviders(<Change amount={-12.5} pct={3} currency="USD" />);
    expect(screen.getByText('down')).toHaveClass('sr-only');
    expect(screen.getByText('\u2212US$12.50')).toBeInTheDocument();
    expect(screen.getByText('(+3.00%)')).toBeInTheDocument();
  });

  it('derives the trend from pct when no value or amount is given', () => {
    renderWithProviders(<Change pct={1.25} />);
    expect(screen.getByText('up')).toBeInTheDocument();
    expect(screen.getByText('+1.25%')).toBeInTheDocument();
  });

  it('prefers an explicit value for the trend', () => {
    renderWithProviders(<Change value={-1} pct={0} />);
    expect(screen.getByText('down')).toBeInTheDocument();
  });

  it('renders an unchanged indicator when nothing is provided', () => {
    renderWithProviders(<Change />);
    expect(screen.getByText('unchanged')).toBeInTheDocument();
    expect(screen.getByText('■')).toHaveAttribute('aria-hidden', 'true');
  });
});
