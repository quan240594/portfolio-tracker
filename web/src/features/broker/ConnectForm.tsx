import { useId, useState, type FormEvent } from 'react';
import { T212_ENVIRONMENTS, type Portfolio, type T212Environment } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useConnectBroker } from './useBroker';

const ENVIRONMENT_LABELS: Record<T212Environment, string> = {
  live: 'Live (real account)',
  demo: 'Demo (practice account)',
};

/** The portfolio a Trading 212 account most likely belongs in: one named after it, else the first. */
export function suggestedPortfolio(portfolios: readonly Portfolio[]): string {
  return (portfolios.find((p) => /trading\s*212/i.test(p.name)) ?? portfolios[0])?.portfolioId ?? '';
}

/**
 * The key and secret live only in this component's state while the form is open: they are never written to
 * localStorage/sessionStorage, never put in the URL, and are cleared as soon as the request has been sent.
 */
export function ConnectForm({ portfolios }: Readonly<{ portfolios: readonly Portfolio[] }>) {
  const ids = { portfolio: useId(), key: useId(), secret: useId(), env: useId() };
  const connect = useConnectBroker();
  const [portfolioId, setPortfolioId] = useState(() => suggestedPortfolio(portfolios));
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [environment, setEnvironment] = useState<T212Environment>('live');
  const target = portfolios.some((p) => p.portfolioId === portfolioId) ? portfolioId : suggestedPortfolio(portfolios);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate({ portfolioId: target, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), environment });
    setApiKey('');
    setApiSecret('');
  };

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-4" aria-label="Connect Trading 212" autoComplete="off">
      <div>
        <label htmlFor={ids.portfolio} className="label">
          Import into portfolio
        </label>
        <select id={ids.portfolio} className="input" value={target} onChange={(e) => setPortfolioId(e.target.value)} disabled={connect.isPending}>
          {portfolios.map((p) => (
            <option key={p.portfolioId} value={p.portfolioId}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.key} className="label">
            API key
          </label>
          <input
            id={ids.key}
            type="password"
            className="input"
            required
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={connect.isPending}
          />
        </div>
        <div>
          <label htmlFor={ids.secret} className="label">
            API secret
          </label>
          <input
            id={ids.secret}
            type="password"
            className="input"
            required
            autoComplete="off"
            spellCheck={false}
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            disabled={connect.isPending}
          />
        </div>
      </div>
      <div>
        <label htmlFor={ids.env} className="label">
          Environment
        </label>
        <select id={ids.env} className="input" value={environment} onChange={(e) => setEnvironment(e.target.value as T212Environment)} disabled={connect.isPending}>
          {T212_ENVIRONMENTS.map((env) => (
            <option key={env} value={env}>
              {ENVIRONMENT_LABELS[env]}
            </option>
          ))}
        </select>
      </div>

      {connect.isError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
          {errorMessage(connect.error)}
        </p>
      )}

      <button type="submit" className="btn-primary" disabled={connect.isPending || !target || !apiKey.trim() || !apiSecret.trim()}>
        {connect.isPending ? 'Testing…' : 'Test & connect'}
      </button>
    </form>
  );
}
