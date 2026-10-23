import { describe, expect, it } from 'vitest';
import { MemoryItemStore, MemoryJobQueue } from '@portfolio/platform';
import { EARNINGS_REFRESH_INTERVAL_MS, sampleSummary } from '@portfolio/shared';
import { parseEarningsConfig } from './config.js';
import { EarningsRepository } from './repository.js';
import { EarningsService } from './service.js';

const NOW = new Date('2026-10-21T10:00:00.000Z');
const CONTACT = 'PortfolioTracker/1.0 (personal use; owner@example.invalid)';

function service(options: { contact?: string; ai?: boolean; neurons?: number } = {}) {
  const repo = new EarningsRepository(new MemoryItemStore());
  const queue = new MemoryJobQueue({});
  const config = parseEarningsConfig({ ...(options.contact === undefined ? {} : { SEC_CONTACT: options.contact }), EARNINGS_AI_DAILY_NEURONS: '9000' });
  const svc = new EarningsService({ repo, config, aiBound: options.ai ?? true, queue, now: () => NOW, neurons: () => Promise.resolve({ used: options.neurons ?? 120, allowance: 10_000, state: 'ok', resetsAt: '2026-10-22T00:00:00.000Z' }) });
  return { repo, queue, svc };
}

describe('EarningsService.status', () => {
  it('says what is missing, never a value', async () => {
    const { svc } = service({ ai: false });
    const status = await svc.status([{ symbol: 'LMFG', eligible: true }]);
    expect(status).toMatchObject({ available: true, configured: false, missing: ['sec-contact', 'ai-binding'], estimatesConfigured: false });
    expect(JSON.stringify(status)).not.toContain('owner@example.invalid');
  });

  it('reports the neurons, the cap (clamped to 8,000), the SEC block and the symbols', async () => {
    const { svc, repo } = service({ contact: CONTACT, neurons: 4321 });
    await repo.putSecBlock({ blockedUntil: '2026-10-21T11:00:00.000Z', failures: 1, lastStatus: 429, updatedAt: NOW.toISOString() });
    await repo.patchState('LMFG', { lastCheckedAt: '2026-10-21T09:30:00.000Z', lastResult: 'failed', lastReason: 'The submissions list: the SEC answered 500', retryAfter: '2026-10-21T10:30:00.000Z' }, NOW);
    await repo.putSummary(sampleSummary({ symbol: 'LMFG', reportDate: '2026-07-22' }));
    const status = await svc.status([{ symbol: 'LMFG', eligible: true }, { symbol: 'VWRL', eligible: false }]);
    expect(status).toMatchObject({ configured: true, missing: [], secBlockedUntil: '2026-10-21T11:00:00.000Z', neurons: { used: 4321, dailyCap: 8000, allowance: 10_000, state: 'ok' } });
    expect(status.symbols).toEqual([
      { symbol: 'LMFG', eligible: true, lastCheckedAt: '2026-10-21T09:30:00.000Z', lastResult: 'failed', lastReason: 'The submissions list: the SEC answered 500', retryAfter: '2026-10-21T10:30:00.000Z', latestReportDate: '2026-07-22' },
      { symbol: 'VWRL', eligible: false },
    ]);
  });

  it('an expired block is not reported', async () => {
    const { svc, repo } = service({ contact: CONTACT });
    await repo.putSecBlock({ blockedUntil: '2026-10-21T09:00:00.000Z', failures: 1, updatedAt: NOW.toISOString() });
    expect((await svc.status([])).secBlockedUntil).toBeUndefined();
  });
});

describe('EarningsService.refresh', () => {
  it('queues a re-check once an hour per symbol and clears what the watcher gave up on', async () => {
    const { svc, repo, queue } = service({ contact: CONTACT });
    await repo.patchState('LMFG', { seenAccessions: ['a'], unreadableCount: 2, retryAfter: '2027-01-01T00:00:00.000Z', pendingAt: NOW.toISOString(), pendingAccession: 'a' }, NOW);
    expect(await svc.refresh('LMFG', true)).toEqual({ accepted: true });
    expect(queue.enqueued).toEqual([{ job: 'watchEarnings', payload: { trigger: 'manual', symbol: 'LMFG' } }]);
    expect(await repo.getState('LMFG')).toMatchObject({ lastManualRefreshAt: NOW.toISOString() });
    expect((await repo.getState('LMFG'))?.seenAccessions).toBeUndefined();
    expect(await svc.refresh('LMFG', true)).toEqual({ accepted: false, reason: 'rate-limited', retryAfterSeconds: EARNINGS_REFRESH_INTERVAL_MS / 1000 });
    expect(await svc.refresh('OTHER', true)).toEqual({ accepted: true });
    expect(queue.enqueued).toHaveLength(2);
  });

  it('refuses when not configured or not an instrument with earnings', async () => {
    expect(await service({ ai: false, contact: CONTACT }).svc.refresh('LMFG', true)).toEqual({ accepted: false, reason: 'not-configured' });
    const { svc, queue } = service({ contact: CONTACT });
    expect(await svc.refresh('VWRL', false)).toEqual({ accepted: false, reason: 'not-eligible' });
    expect(queue.enqueued).toEqual([]);
  });
});
