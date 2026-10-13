import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from './ThemeProvider';

type Listener = (e: MediaQueryListEvent) => void;

/** Controllable `prefers-color-scheme: dark` media query. */
function mockColorScheme(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  } as unknown as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockReturnValue(mql);
  return {
    listeners,
    change(dark: boolean) {
      act(() => listeners.forEach((l) => l({ matches: dark } as MediaQueryListEvent)));
    },
  };
}

function Probe() {
  const { theme, toggleTheme, setTheme } = useTheme();
  return (
    <>
      <p>theme: {theme}</p>
      <button type="button" onClick={toggleTheme}>toggle</button>
      <button type="button" onClick={() => setTheme('light')}>light</button>
    </>
  );
}

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

afterEach(() => document.documentElement.classList.remove('dark'));

describe('ThemeProvider', () => {
  it('defaults to light when the OS has no dark preference', () => {
    mockColorScheme(false);
    renderProbe();
    expect(screen.getByText('theme: light')).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('follows prefers-color-scheme: dark initially and on OS changes', () => {
    const os = mockColorScheme(true);
    renderProbe();
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('dark');

    os.change(false);
    expect(screen.getByText('theme: light')).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('dark');

    os.change(true);
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
  });

  it('stops following the OS once the user picked a theme, and persists the choice', async () => {
    const user = userEvent.setup();
    const os = mockColorScheme(false);
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    os.change(false);
    expect(screen.getByText('theme: dark')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('prefers a stored theme over the OS preference and ignores invalid stored values', () => {
    mockColorScheme(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { unmount } = renderProbe();
    expect(screen.getByText('theme: light')).toBeInTheDocument();
    unmount();

    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    renderProbe();
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
  });

  it('removes its media-query listener on unmount', () => {
    const os = mockColorScheme(false);
    const { unmount } = renderProbe();
    expect(os.listeners.size).toBe(1);
    unmount();
    expect(os.listeners.size).toBe(0);
  });

  it('still works when localStorage is unavailable', async () => {
    const user = userEvent.setup();
    mockColorScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    renderProbe();
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'light' }));
    expect(screen.getByText('theme: light')).toBeInTheDocument();
  });

  it('tolerates legacy MediaQueryList objects without addEventListener', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, media: '(prefers-color-scheme: dark)' } as MediaQueryList);
    const { unmount } = renderProbe();
    expect(screen.getByText('theme: dark')).toBeInTheDocument();
    expect(() => unmount()).not.toThrow();
  });

  it('falls back to light when matchMedia is not supported', () => {
    const original = window.matchMedia;
    // @ts-expect-error simulate a browser without matchMedia
    delete window.matchMedia;
    try {
      renderProbe();
      expect(screen.getByText('theme: light')).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('throws a helpful error when useTheme is used outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow('useTheme must be used inside <ThemeProvider>');
  });
});
