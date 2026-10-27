import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidatePortfolioData, usePortfolios } from '../../api/hooks';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/Layout';
import { CardGrid } from '../layout/CardGrid';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { USE_MOCKS } from '../../config';
import { ConnectForm } from './ConnectForm';
import { StatusCard } from './StatusCard';
import { useBrokerOverview } from './useBroker';

function Instructions() {
  return (
    <section aria-label="How to connect" className="card space-y-3 p-4 text-sm">
      <h2 className="text-base font-semibold">Create a read-only API key</h2>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          In the Trading 212 app open <strong>Settings → API (Beta)</strong> and generate a new key.
        </li>
        <li>
          Enable only these scopes: <strong>account</strong>, <strong>metadata</strong>, <strong>portfolio</strong>, <strong>history:orders</strong>,{' '}
          <strong>history:dividends</strong> and <strong>history:transactions</strong>. Do <em>not</em> enable order execution or pies.
        </li>
        <li>Copy the key and the secret (shown once) into the form above.</li>
      </ol>
      <ul className="muted list-disc space-y-1 pl-5 text-xs">
        <li>Trading 212 only allows the API for your own account: connect your own Invest or Stocks ISA account, not someone else&apos;s.</li>
        <li>An IP restriction on the key is optional. Leave it unrestricted: the sync runs on AWS, which has no fixed IP address.</li>
        <li>The key is stored in AWS Secrets Manager, never in this browser, and removed when you disconnect. Transactions are imported once a day and on demand.</li>
        <li>Trades, dividends, fees and stock splits are imported. Deposits, withdrawals and interest are not (cash is not tracked yet).</li>
      </ul>
    </section>
  );
}

export function BrokerPage() {
  const qc = useQueryClient();
  const portfolios = usePortfolios();
  const list = portfolios.data?.portfolios;
  const overview = useBrokerOverview(list?.map((p) => p.portfolioId) ?? []);
  const { connected } = overview;

  // Show freshly imported transactions everywhere once a sync has finished.
  const lastSuccess = useRef(connected?.lastSuccessAt);
  useEffect(() => {
    if (connected && connected.lastSuccessAt !== lastSuccess.current) {
      lastSuccess.current = connected.lastSuccessAt;
      void invalidatePortfolioData(qc, connected.portfolioId);
    }
  }, [connected, qc]);

  let body;
  if (portfolios.isError || overview.error) {
    body = <ErrorState error={portfolios.error ?? overview.error} onRetry={() => (portfolios.isError ? void portfolios.refetch() : overview.refetch())} />;
  } else if (!list || overview.isLoading) {
    body = (
      <LoadingRegion label="Loading Trading 212 status">
        <Skeleton className="h-48 w-full" />
      </LoadingRegion>
    );
  } else if (connected) {
    body = <StatusCard status={connected} portfolios={list} />;
  } else {
    body = <ConnectForm portfolios={list} />;
  }

  return (
    <>
      <PageHeader title="Trading 212" description="Import your own Trading 212 account automatically (read-only)." />
      {USE_MOCKS && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          Demo mode: the connection is simulated. Trading 212 is never contacted from this page, and nothing you type leaves your browser.
        </p>
      )}
      <CardGrid
        pageId="brokers"
        cards={[
          { id: 'broker-connection', title: 'Connection', defaultWidth: 'full', render: () => body },
          { id: 'broker-instructions', title: 'How to connect', defaultWidth: 'full', render: () => <Instructions /> },
        ]}
      />
    </>
  );
}
