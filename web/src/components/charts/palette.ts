import type { Theme } from '../../theme/ThemeProvider';

export const SERIES_COLORS = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#84cc16', '#f97316', '#64748b'];

export function chartTheme(theme: Theme) {
  const dark = theme === 'dark';
  return {
    grid: dark ? '#1e293b' : '#e2e8f0',
    axis: dark ? '#94a3b8' : '#64748b',
    value: dark ? '#818cf8' : '#4f46e5',
    invested: dark ? '#94a3b8' : '#64748b',
    received: dark ? '#2dd4bf' : '#0d9488',
    upcoming: dark ? '#fbbf24' : '#d97706',
    tooltipBg: dark ? '#0f172a' : '#ffffff',
    tooltipBorder: dark ? '#334155' : '#e2e8f0',
    text: dark ? '#e2e8f0' : '#0f172a',
  };
}
