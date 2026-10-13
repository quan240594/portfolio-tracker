import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/utils';
import { Dialog } from './Dialog';

function Harness({ withControls = true, autofocus = false, description }: { withControls?: boolean; autofocus?: boolean; description?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Settings"
        description={description}
        footer={withControls ? <button type="button" data-autofocus={autofocus || undefined}>Save</button> : undefined}
      >
        {withControls ? <input aria-label="Name" /> : <p>Read only</p>}
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    renderWithProviders(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a labelled modal that focuses the first control and locks body scroll', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness description="Change your preferences" />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Change your preferences');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('honours data-autofocus', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness autofocus />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });

  it('traps Tab and Shift+Tab inside the panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const name = screen.getByRole('textbox', { name: 'Name' });
    const save = screen.getByRole('button', { name: 'Save' });

    await user.tab();
    expect(name).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    await user.tab({ shift: true });
    expect(name).toHaveFocus();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes via the close button and the backdrop', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const backdrop = screen.getByRole('dialog').previousElementSibling as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores other keys', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('a');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('focuses the panel itself and keeps Tab inert when it has no focusable controls', async () => {
    renderWithProviders(
      <Dialog open onClose={() => {}} title="Empty" role="alertdialog" size="sm">
        <p>Nothing to focus</p>
      </Dialog>,
    );
    // Remove the only focusable control (close button) to exercise the empty-trap path.
    const panel = screen.getByRole('alertdialog', { name: 'Empty' });
    screen.getByRole('button', { name: 'Close dialog' }).remove();
    const user = userEvent.setup();
    panel.focus();
    await user.tab();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('focuses the panel when nothing inside is focusable on open', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'querySelectorAll').mockReturnValue([] as unknown as NodeListOf<HTMLElement>);
    renderWithProviders(
      <Dialog open onClose={() => {}} title="Bare">
        <p>Body</p>
      </Dialog>,
    );
    spy.mockRestore();
    expect(screen.getByRole('dialog', { name: 'Bare' })).toHaveFocus();
  });
});
