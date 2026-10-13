import { screen } from '@testing-library/react';
import { renderApp, renderWithProviders } from '../test/utils';
import { PageHeader } from './Layout';

vi.mock('../config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config')>()), USE_MOCKS: true }));

describe('Layout in mock mode', () => {
  it('shows a "Demo data" badge', async () => {
    renderApp('/');
    expect(screen.getByText('Demo data')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('PageHeader', () => {
  it('renders title only', () => {
    renderWithProviders(<PageHeader title="Plain" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Plain' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders description and actions', () => {
    renderWithProviders(<PageHeader title="Rich" description="Some context" actions={<button type="button">Act</button>} />);
    expect(screen.getByText('Some context')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });
});
