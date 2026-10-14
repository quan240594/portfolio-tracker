import { screen, within } from '@testing-library/react';
import { renderApp, renderWithProviders } from '../test/utils';
import { DemoBanner, PageHeader } from './Layout';

vi.mock('../config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config')>()), USE_MOCKS: true }));

describe('Layout in mock mode', () => {
  it('shows a non-dismissable demo-mode banner above the header', async () => {
    renderApp('/');
    const banner = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(banner).toHaveTextContent('Demo mode — sample data, nothing is saved. Changes reset when you reload.');
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
    expect(banner.compareDocumentPosition(screen.getByRole('banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('keeps the banner on every page', async () => {
    renderApp('/holdings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Holdings' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Demo mode' })).toBeInTheDocument();
  });
});

describe('DemoBanner', () => {
  it('renders standalone', () => {
    renderWithProviders(<DemoBanner />);
    expect(screen.getByRole('complementary', { name: 'Demo mode' })).toHaveTextContent('nothing is saved');
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
