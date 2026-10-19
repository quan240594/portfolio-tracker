import { describe, expect, it, vi } from 'vitest';
import { SUBREQUEST_CEILING, SUBREQUEST_LIMIT, SubrequestBudget, SubrequestLimitError } from './subrequests.js';

describe('SubrequestBudget', () => {
  it('plans below the free-plan limit', () => {
    expect(SUBREQUEST_CEILING).toBeLessThan(SUBREQUEST_LIMIT);
    expect(new SubrequestBudget().remaining()).toBe(SUBREQUEST_CEILING);
  });

  it('counts the calls it lets through and refuses the one over the ceiling', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('ok')));
    const budget = new SubrequestBudget(2);
    const wrapped = budget.wrap(inner as unknown as typeof fetch);
    await wrapped('https://x.test/1');
    await wrapped('https://x.test/2', { method: 'GET' });
    expect([budget.used, budget.remaining()]).toEqual([2, 0]);
    await expect(wrapped('https://x.test/3')).rejects.toBeInstanceOf(SubrequestLimitError);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(budget.remaining()).toBe(0);
  });

  it('counts a call that fails', async () => {
    const budget = new SubrequestBudget(1);
    await expect(budget.wrap(() => Promise.reject(new Error('network')))('https://x.test/')).rejects.toThrow('network');
    expect(budget.used).toBe(1);
  });
});
