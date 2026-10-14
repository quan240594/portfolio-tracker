import type { Theme } from '../../theme/ThemeProvider';
import { chartTheme } from './palette';

/** Chart colours for the analytics page, on top of the shared chart theme. */
export function analyticsTheme(theme: Theme) {
  const dark = theme === 'dark';
  return {
    ...chartTheme(theme),
    gain: dark ? '#34d399' : '#059669',
    loss: dark ? '#f87171' : '#dc2626',
    benchmark: dark ? '#fbbf24' : '#d97706',
    previous: dark ? '#64748b' : '#94a3b8',
    cautious: dark ? '#f87171' : '#dc2626',
    base: dark ? '#818cf8' : '#4f46e5',
    optimistic: dark ? '#34d399' : '#059669',
  };
}

export const tooltipStyle = (c: ReturnType<typeof analyticsTheme>) => ({
  background: c.tooltipBg,
  border: `1px solid ${c.tooltipBorder}`,
  borderRadius: 8,
  color: c.text,
  fontSize: 12,
});
