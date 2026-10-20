import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyLogo, LogosEnabledProvider, logoUrl, monogramOf, resetLogoSession } from './CompanyLogo';

afterEach(() => act(() => resetLogoSession()));

const enabled = (ui: React.ReactElement) => render(<LogosEnabledProvider value>{ui}</LogosEnabledProvider>);

describe('monogramOf', () => {
  it('takes the first two letters or digits of the symbol', () => {
    expect(monogramOf('SAP.DE')).toBe('SA');
    expect(monogramOf('brk-b')).toBe('BR');
    expect(monogramOf('1COV.DE')).toBe('1C');
    expect(monogramOf('X')).toBe('X');
    expect(monogramOf('...')).toBe('?');
  });
});

describe('CompanyLogo', () => {
  it('asks our own origin for the logo, with a fixed size, lazy loading and the symbol encoded', () => {
    enabled(<CompanyLogo symbol="BRK/B" name="Berkshire" size={32} />);
    const img = screen.getByRole('img', { name: 'Berkshire' });
    expect(img).toHaveAttribute('src', '/api/logos/BRK%2FB');
    expect(img).toHaveAttribute('src', logoUrl('BRK/B'));
    expect(img).toHaveAttribute('width', '32');
    expect(img).toHaveAttribute('height', '32');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img.className).toContain('object-contain');
  });

  it('uses the symbol as alternative text without a name and empty alt text when the name is written next to it', () => {
    const { rerender } = enabled(<CompanyLogo symbol="AAPL" />);
    expect(screen.getByRole('img', { name: 'AAPL' })).toBeInTheDocument();
    rerender(
      <LogosEnabledProvider value>
        <CompanyLogo symbol="AAPL" name="Apple Inc." decorative />
      </LogosEnabledProvider>,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('falls back to the monogram of the same box when the image fails, and remembers it for the session', () => {
    const { container, unmount } = enabled(<CompanyLogo symbol="SAP.DE" name="SAP SE" size={32} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveStyle({ width: '32px', height: '32px' });
    expect(box).toHaveAttribute('data-logo', 'image');
    fireEvent.error(container.querySelector('img')!);
    expect(box).toHaveAttribute('data-logo', 'monogram');
    expect(container.querySelector('img')).toBeNull();
    expect(box.querySelector('[data-monogram]')).toHaveAttribute('data-monogram', 'SA');
    expect(box).not.toHaveTextContent('SA ');
    expect(box).toHaveStyle({ width: '32px', height: '32px' });
    expect(screen.getByText('SAP SE')).toHaveClass('sr-only');
    unmount();

    // Another row of the same symbol does not ask again; another symbol still does.
    const next = enabled(
      <>
        <CompanyLogo symbol="SAP.DE" />
        <CompanyLogo symbol="ASML.AS" />
      </>,
    );
    expect(next.container.querySelectorAll('img')).toHaveLength(1);
    expect(next.container.querySelector('img')).toHaveAttribute('src', '/api/logos/ASML.AS');
  });

  it('turns every row of a symbol into the monogram when one of them fails', () => {
    const { container } = enabled(
      <>
        <CompanyLogo symbol="KO" />
        <CompanyLogo symbol="KO" />
      </>,
    );
    act(() => {
      fireEvent.error(container.querySelector('img')!);
    });
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('[data-logo="monogram"]')).toHaveLength(2);
  });

  it('shows the monogram and requests nothing when logos are off (demo mode, tests)', () => {
    const { container } = render(
      <LogosEnabledProvider value={false}>
        <CompanyLogo symbol="AAPL" name="Apple Inc." decorative />
      </LogosEnabledProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-logo', 'monogram');
    expect(container.querySelector('[data-monogram]')).toHaveAttribute('data-monogram', 'AA');
    expect(container).toHaveTextContent('');
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  it('draws the corner badge as decoration, on the image and on the monogram', () => {
    const badge = <span data-testid="badge">E</span>;
    const { container } = enabled(<CompanyLogo symbol="AAPL" badge={badge} />);
    expect(screen.getByTestId('badge').parentElement).toHaveAttribute('aria-hidden', 'true');
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByTestId('badge')).toBeInTheDocument();
  });
});
