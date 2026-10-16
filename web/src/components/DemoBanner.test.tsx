import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/utils';
import { DemoBanner } from './DemoBanner';

describe('DemoBanner', () => {
  it('renders the demo text and the switch control', () => {
    renderWithProviders(<DemoBanner />);
    const banner = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(banner).toHaveTextContent('Demo mode — sample data, nothing is saved. Changes reset when you reload.');
    expect(within(banner).getByRole('button', { name: 'Switch to real data' })).toBeInTheDocument();
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument();
  });

  describe('without a real app URL (dialog mode)', () => {
    it('opens a dialog with the steps and closes it with the close button, returning focus', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DemoBanner />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const trigger = screen.getByRole('button', { name: 'Switch to real data' });
      await user.click(trigger);

      const dialog = screen.getByRole('dialog', { name: 'Switch to real data' });
      expect(dialog).toHaveTextContent('sample data in your browser only');
      expect(dialog).toHaveTextContent('about 8 minutes');
      expect(dialog).toHaveTextContent('Your Trading 212 key never goes through this demo site.');
      const steps = within(dialog).getAllByRole('listitem');
      expect(steps).toHaveLength(3);
      expect(steps[1]).toHaveTextContent('REAL_APP_URL');
      expect(within(dialog).getByRole('link', { name: 'deployment guide' })).toHaveAttribute(
        'href',
        'https://github.com/quan240594/portfolio-tracker/blob/main/infra/terraform/README.md',
      );

      await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('closes on Escape and returns focus to the control', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DemoBanner />);
      const trigger = screen.getByRole('button', { name: 'Switch to real data' });
      await user.click(trigger);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('is operable with the keyboard', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DemoBanner />);
      await user.tab();
      expect(screen.getByRole('button', { name: 'Switch to real data' })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name: 'Switch to real data' })).toBeInTheDocument();
    });
  });

  describe('with a real app URL (link mode)', () => {
    it('renders a same-tab link with rel=noopener and no dialog', () => {
      renderWithProviders(<DemoBanner realAppUrl="https://app.example.com/" />);
      const link = screen.getByRole('link', { name: 'Switch to real data' });
      expect(link).toHaveAttribute('href', 'https://app.example.com/');
      expect(link).toHaveAttribute('rel', 'noopener');
      expect(link).not.toHaveAttribute('target');
      expect(screen.queryByRole('button', { name: 'Switch to real data' })).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
