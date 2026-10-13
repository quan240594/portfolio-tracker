import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/utils';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
] as const;
type V = (typeof OPTIONS)[number]['value'];

function Harness({ variant }: { variant?: 'tabs' | 'radio' }) {
  const [value, setValue] = useState<V>('a');
  return (
    <SegmentedControl
      label="Pick"
      options={OPTIONS}
      value={value}
      onChange={setValue}
      variant={variant}
      panelId={variant === 'tabs' ? 'panel' : undefined}
      idPrefix={variant === 'tabs' ? 'seg' : undefined}
      size={variant === 'tabs' ? 'md' : undefined}
    />
  );
}

describe('SegmentedControl', () => {
  it('renders a radiogroup with roving tabindex and selects on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Pick' })).toBeInTheDocument();
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    const beta = screen.getByRole('radio', { name: 'Beta' });
    expect(alpha).toHaveAttribute('aria-checked', 'true');
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(beta).toHaveAttribute('tabindex', '-1');
    expect(alpha).not.toHaveAttribute('id');

    await user.click(beta);
    expect(beta).toHaveAttribute('aria-checked', 'true');
    expect(alpha).toHaveAttribute('aria-checked', 'false');
  });

  it('supports arrow keys (with wrap-around), Home and End', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const radio = (name: string) => screen.getByRole('radio', { name });
    radio('Alpha').focus();

    await user.keyboard('{ArrowRight}');
    expect(radio('Beta')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Beta')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(radio('Gamma')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Alpha')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(radio('Gamma')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(radio('Beta')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(radio('Alpha')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(radio('Gamma')).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('x');
    expect(radio('Gamma')).toHaveAttribute('aria-checked', 'true');
  });

  it('renders tabs that control a panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness variant="tabs" />);
    expect(screen.getByRole('tablist', { name: 'Pick' })).toBeInTheDocument();
    const beta = screen.getByRole('tab', { name: 'Beta' });
    expect(beta).toHaveAttribute('aria-controls', 'panel');
    expect(beta).toHaveAttribute('id', 'seg-b');
    expect(beta).toHaveAttribute('aria-selected', 'false');
    await user.click(beta);
    expect(beta).toHaveAttribute('aria-selected', 'true');
  });
});
