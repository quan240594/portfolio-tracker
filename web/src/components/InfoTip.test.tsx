import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip } from './InfoTip';

describe('InfoTip', () => {
  it('opens from the "i" and closes with Escape, putting the focus back on the "i"', async () => {
    const user = userEvent.setup();
    render(<InfoTip label="Yield">Explanation</InfoTip>);
    const summary = screen.getByLabelText('About Yield');
    const details = summary.closest('details')!;
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    await user.keyboard('a');
    expect(details).toHaveAttribute('open');
    await user.keyboard('{Escape}');
    expect(details).not.toHaveAttribute('open');
    expect(summary).toHaveFocus();
  });

  it('ignores Escape while it is closed', async () => {
    const user = userEvent.setup();
    render(<InfoTip label="Yield">Explanation</InfoTip>);
    const summary = screen.getByLabelText('About Yield');
    summary.focus();
    await user.keyboard('{Escape}');
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });
});
