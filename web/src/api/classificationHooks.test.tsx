import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ClassificationFields, ClassificationImportResponse, ClassificationInstrument } from '@portfolio/shared';
import { server } from '../mocks/server';
import { api } from '../mocks/utils';
import { createTestQueryClient } from '../test/utils';
import { classificationKeys, invalidateClassificationData, useClassification, useImportClassification, useResetClassification, useSaveClassification } from './classificationHooks';
import { queryKeys } from './hooks';
import { assetKeys } from './assetHooks';
import { managementKeys } from './management-hooks';

const wrap = (qc: QueryClient) =>
  function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

/** One cached query per kind of data that depends on classification, plus two that do not. */
const dependent = [
  classificationKeys.list,
  queryKeys.portfolio('all'),
  queryKeys.holdings('p1'),
  queryKeys.allocation('all', 'sector'),
  ['analytics', 'p1', 'asset', 'AAPL', 'positions'],
  assetKeys.detail('AAPL'),
  managementKeys.watchlist,
] as const;
const unrelated = [queryKeys.portfolios, queryKeys.import('imp-1')] as const;

function seededClient() {
  const qc = createTestQueryClient();
  for (const key of [...dependent, ...unrelated]) qc.setQueryData(key, { ok: true });
  const invalidated = () => [...dependent, ...unrelated].filter((key) => qc.getQueryState(key)?.isInvalidated);
  return { qc, invalidated };
}

const instrument: ClassificationInstrument = {
  symbol: 'ACME.AS',
  effective: { name: 'Acme', assetClass: 'ETF', sector: 'Funds', country: 'Netherlands' },
  base: { name: 'Acme', assetClass: 'STOCK', sector: null, country: null },
  source: 'trading212',
  isin: null,
  currency: 'EUR',
  override: { assetClass: 'ETF', sector: 'Funds', country: 'Netherlands' },
  held: true,
  updatedAt: '2026-01-02T03:04:05.000Z',
};

describe('invalidateClassificationData', () => {
  it('refreshes the override list and everything grouped or labelled by classification, nothing else', async () => {
    const { qc, invalidated } = seededClient();
    await invalidateClassificationData(qc);
    expect(invalidated()).toEqual([...dependent]);
  });
});

describe('useClassification', () => {
  it('lists the held instruments of the demo user with their effective and base classification', async () => {
    const { result } = renderHook(() => useClassification(), { wrapper: wrap(createTestQueryClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const aapl = result.current.data!.instruments.find((i) => i.symbol === 'AAPL');
    expect(aapl).toMatchObject({ source: 'provider', held: true, override: null, effective: { sector: 'Technology', country: 'United States' } });
    expect(aapl?.effective).toEqual(aapl?.base);
  });

  it('stays idle while disabled', () => {
    const { result } = renderHook(() => useClassification({ enabled: false }), { wrapper: wrap(createTestQueryClient()) });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useSaveClassification', () => {
  it('PUTs the fields to the encoded symbol and then refreshes the dependent queries', async () => {
    const seen: { path: string; body: ClassificationFields }[] = [];
    server.use(
      http.put(api('/classification/:symbol'), async ({ request }) => {
        seen.push({ path: new URL(request.url).pathname, body: (await request.json()) as ClassificationFields });
        return HttpResponse.json(instrument);
      }),
    );
    const { qc, invalidated } = seededClient();
    const { result } = renderHook(() => useSaveClassification(), { wrapper: wrap(qc) });
    await act(() => result.current.mutateAsync({ symbol: 'BRK-B', fields: { sector: 'Insurance' } }));
    expect(seen).toEqual([{ path: '/api/classification/BRK-B', body: { sector: 'Insurance' } }]);
    expect(invalidated()).toEqual([...dependent]);
  });

  it('does not refresh anything when the API refuses', async () => {
    server.use(http.put(api('/classification/:symbol'), () => HttpResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Nope' } }, { status: 400 })));
    const { qc, invalidated } = seededClient();
    const { result } = renderHook(() => useSaveClassification(), { wrapper: wrap(qc) });
    await act(async () => {
      await expect(result.current.mutateAsync({ symbol: 'AAPL', fields: { sector: 'X' } })).rejects.toThrow('Nope');
    });
    expect(invalidated()).toEqual([]);
  });
});

describe('useResetClassification', () => {
  it('DELETEs the override and refreshes the dependent queries', async () => {
    const seen: string[] = [];
    server.use(
      http.delete(api('/classification/:symbol'), ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { qc, invalidated } = seededClient();
    const { result } = renderHook(() => useResetClassification(), { wrapper: wrap(qc) });
    await act(() => result.current.mutateAsync('VWRL.AS'));
    expect(seen).toEqual(['/api/classification/VWRL.AS']);
    expect(invalidated()).toEqual([...dependent]);
  });
});

describe('useImportClassification', () => {
  const response = (dryRun: boolean): ClassificationImportResponse => ({ dryRun, matched: [], unmatched: [], applied: 0 });
  const rows = [{ ticker: 'ACME', sector: 'Funds' }];

  it('a dry run previews without refreshing anything', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/classification/import'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(response(true));
      }),
    );
    const { qc, invalidated } = seededClient();
    const { result } = renderHook(() => useImportClassification(), { wrapper: wrap(qc) });
    await act(() => result.current.mutateAsync({ dryRun: true, rows }));
    expect(bodies).toEqual([{ dryRun: true, rows }]);
    expect(invalidated()).toEqual([]);
  });

  it('a real import refreshes the dependent queries', async () => {
    server.use(http.post(api('/classification/import'), () => HttpResponse.json({ ...response(false), applied: 1 })));
    const { qc, invalidated } = seededClient();
    const { result } = renderHook(() => useImportClassification(), { wrapper: wrap(qc) });
    await act(() => result.current.mutateAsync({ dryRun: false, rows }));
    expect(invalidated()).toEqual([...dependent]);
  });
});
