import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyLogo, LOGO_URL_VERSION, LogosEnabledProvider, logoUrl, monogramOf, resetLogoSession } from './CompanyLogo';

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
    expect(img).toHaveAttribute('src', '/api/logos/BRK%2FB?v=2');
    expect(img).toHaveAttribute('src', logoUrl('BRK/B'));
    expect(img).toHaveAttribute('width', '32');
    expect(img).toHaveAttribute('height', '32');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img.className).toContain('object-cover');
    expect(img.className).not.toContain('object-contain');
  });

  it('versions the URL so a browser never keeps a picture of an older source', () => {
    expect(logoUrl('AAPL')).toBe(`/api/logos/AAPL?v=${LOGO_URL_VERSION}`);
    expect(LOGO_URL_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('is a circle: a clipped round box with a thin ring, a round image without padding, the same in the monogram', () => {
    const { container } = enabled(<CompanyLogo symbol="AAPL" name="Apple" size={32} />);
    const frame = container.querySelector('img')!.parentElement!;
    expect(frame.className).toContain('rounded-full');
    expect(frame.className).toContain('overflow-hidden');
    expect(frame.className).toMatch(/ring-1/);
    expect(frame.className).toMatch(/dark:ring-/);
    const img = container.querySelector('img')!;
    expect(img.className).toContain('rounded-full');
    expect(img.className).toContain('bg-white');
    expect(img.className).not.toMatch(/\bp-\d/);
    fireEvent.error(img);
    const monogram = container.querySelector('[data-logo] > span')!;
    expect(monogram.className).toContain('rounded-full');
    expect(monogram.className).not.toContain('rounded-md');
  });

  it('reserves room for the corner marker on its right only when there is one, so text next to it never touches it', () => {
    const { container } = enabled(
      <>
        <CompanyLogo symbol="AAPL" badge={<span>P</span>} />
        <CompanyLogo symbol="KO" />
      </>,
    );
    const [withBadge, without] = Array.from(container.querySelectorAll('[data-logo]'));
    expect(withBadge!.className).toContain('mr-1.5');
    expect(without!.className).not.toContain('mr-');
    expect(withBadge!.className).toContain('shrink-0');
    expect(container.querySelectorAll('[data-logo-marker]')).toHaveLength(1);
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
    expect(next.container.querySelector('img')).toHaveAttribute('src', '/api/logos/ASML.AS?v=2');
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
