import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { renderWithProviders } from '../../test/utils';
import { BLOCKED_SNAPSHOT, OK_SNAPSHOT, serveUsage, usageSnapshot, UNAVAILABLE_SNAPSHOT, WARN_SNAPSHOT } from '../../test/usage';
import { UsageIndicator } from './UsageIndicator';
import { USAGE_QUERY_KEY } from './useUsage';

const chip = (name: string | RegExp) => screen.findByRole('button', { name });
const local = (iso: string) => new Intl.DateTimeFormat('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

describe('UsageIndicator chip', () => {
  it.each([
    [OK_SNAPSHOT, 'Usage OK', /emerald/],
    [WARN_SNAPSHOT, 'Usage high', /amber/],
    [BLOCKED_SNAPSHOT, 'Paused', /rose/],
    [UNAVAILABLE_SNAPSHOT, 'Usage unknown', /slate/],
  ])('shows the %# state with text, an icon and its own tone', async (snapshot, text, tone) => {
    serveUsage(snapshot);
    renderWithProviders(<UsageIndicator />);
    const button = await chip(text);
    expect(button).toHaveClass(tone);
    expect(button.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders nothing while the backend does not expose /usage', async () => {
    const { container, queryClient } = renderWithProviders(<UsageIndicator />);
    await waitFor(() => expect(queryClient.getQueryState(USAGE_QUERY_KEY)?.status).not.toBe('pending'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the usage cannot be reached', async () => {
    server.use(http.get(api('/usage'), () => HttpResponse.error()));
    const { container, queryClient } = renderWithProviders(<UsageIndicator />);
    await waitFor(() => expect(queryClient.getQueryState(USAGE_QUERY_KEY)?.status).not.toBe('pending'));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UsageIndicator panel', () => {
  it('lists every metric with label, used of limit, percent, state and a native meter', async () => {
    serveUsage(WARN_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    const user = userEvent.setup();
    await user.click(await chip('Usage high'));

    const panel = screen.getByRole('region', { name: 'Free-plan usage' });
    expect(screen.getByRole('button', { name: 'Usage high' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(6);

    const worker = within(panel).getByRole('meter', { name: 'Worker requests' });
    expect(worker.tagName).toBe('METER');
    expect(worker).toHaveAttribute('value', '61');
    expect(worker).toHaveAttribute('low', '59.99');
    expect(worker).toHaveAttribute('high', '79.99');
    const row = worker.closest('li')!;
    expect(row).toHaveTextContent('Worker requests');
    expect(row).toHaveTextContent('High');
    expect(row).toHaveTextContent('61.000 of 100.000 (61,0%)');
    expect(within(panel).getByRole('meter', { name: 'Database rows read' }).closest('li')).toHaveTextContent('3.625.000 of 5.000.000 (72,5%)');
    expect(within(panel).getByRole('meter', { name: 'Database rows written' }).closest('li')).toHaveTextContent('OK');
    expect(within(panel).getByRole('meter', { name: 'Durable Object duration (GB-s)' })).toBeInTheDocument();
  });

  it('explains the cap policy and when the counters reset, in local time next to 00:00 UTC', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    await userEvent.setup().click(await chip('Usage OK'));
    const panel = screen.getByRole('region', { name: 'Free-plan usage' });
    expect(panel).toHaveTextContent('Free plan caps are never exceeded: at 80 % of any cap the app pauses new work until the reset.');
    expect(panel).toHaveTextContent(`Daily counters reset at ${local('2026-10-20T00:00:00Z')} (00:00 UTC)`);
    expect(panel).toHaveTextContent(/Updated \d{2}:\d{2}\./);
  });

  it('caps the bar at 100 while still printing the real percentage when a cap was passed', async () => {
    serveUsage(usageSnapshot({ rowsWritten: 130 }));
    renderWithProviders(<UsageIndicator />);
    await userEvent.setup().click(await chip('Paused'));
    const meter = screen.getByRole('meter', { name: 'Database rows written' });
    expect(meter).toHaveAttribute('value', '100');
    expect(meter.closest('li')).toHaveTextContent('(130,0%)');
    expect(meter.closest('li')).toHaveTextContent('Paused');
  });

  it('shows decimals only for GB-seconds', async () => {
    serveUsage(usageSnapshot({ durableObjectGbSeconds: 12.345678 }));
    renderWithProviders(<UsageIndicator />);
    await userEvent.setup().click(await chip('Usage OK'));
    const text = screen.getByRole('meter', { name: 'Durable Object duration (GB-s)' }).closest('li')!.textContent!;
    expect(text).toContain('1.604,94 of 13.000 (12,3%)');
  });

  it('replaces the figures by a plain note when the usage could not be read', async () => {
    serveUsage(UNAVAILABLE_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    await userEvent.setup().click(await chip('Usage unknown'));
    const panel = screen.getByRole('region', { name: 'Free-plan usage' });
    expect(within(panel).queryAllByRole('meter')).toHaveLength(0);
    expect(panel).toHaveTextContent('The usage could not be read right now, so the app only allows reading until it can.');
  });
});

describe('UsageIndicator keyboard and focus', () => {
  it('opens with Enter, moves focus into the panel and closes with Escape, returning focus to the chip', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    const user = userEvent.setup();
    const button = await chip('Usage OK');
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('region', { name: 'Free-plan usage' });
    expect(panel).toHaveFocus();
    expect(button).toHaveAttribute('aria-controls', panel.id);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Free-plan usage' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('ignores other keys', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    const user = userEvent.setup();
    await user.click(await chip('Usage OK'));
    await user.keyboard('a{Enter}');
    expect(screen.getByRole('region', { name: 'Free-plan usage' })).toBeInTheDocument();
  });

  it('reaches the Close button with Tab and closes with it, returning focus to the chip', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    const user = userEvent.setup();
    await user.click(await chip('Usage OK'));
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.queryByRole('region', { name: 'Free-plan usage' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usage OK' })).toHaveFocus();
  });

  it('closes when focus leaves the panel and when clicking elsewhere, but not when clicking inside', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(
      <>
        <UsageIndicator />
        <button type="button">Elsewhere</button>
      </>,
    );
    const user = userEvent.setup();
    await user.click(await chip('Usage OK'));
    await user.click(screen.getByRole('heading', { name: 'Free-plan usage' }));
    expect(screen.getByRole('region', { name: 'Free-plan usage' })).toBeInTheDocument();

    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'Free-plan usage' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Usage OK' }));
    expect(screen.getByRole('region', { name: 'Free-plan usage' })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('region', { name: 'Free-plan usage' })).not.toBeInTheDocument();
  });

  it('toggles with the chip', async () => {
    serveUsage(OK_SNAPSHOT);
    renderWithProviders(<UsageIndicator />);
    const user = userEvent.setup();
    const button = await chip('Usage OK');
    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole('region', { name: 'Free-plan usage' })).not.toBeInTheDocument();
  });
});
