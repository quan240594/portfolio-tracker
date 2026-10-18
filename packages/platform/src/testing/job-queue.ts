import { describe, expect, it } from 'vitest';
import { JOBS, type JobHandler, type JobPayloads, type JobQueue } from '../job.js';

export interface JobQueueHarness {
  queue: JobQueue;
  /** Installs the handler that the adapter delivers `syncBroker` jobs to. */
  register(handler: JobHandler<JobPayloads['syncBroker']>): void;
  /** Resolves when every job enqueued so far (continuations and redeliveries included) has been processed. */
  drain(): Promise<void>;
}

type Factory = () => JobQueueHarness | Promise<JobQueueHarness>;

/**
 * Behaviour every JobQueue adapter must have: the payload reaches the handler, a `{ done: false, next }` step is
 * re-delivered with its cursor until the job is done, and a failing step is redelivered with the same cursor
 * (at-least-once, which is why handlers are idempotent).
 */
export function runJobQueueContract(name: string, create: Factory): void {
  describe(`JobQueue contract: ${name}`, () => {
    const payload = { userId: 'u1', portfolioId: 'p1' };

    it('delivers an enqueued job to its handler with the payload and no cursor', async () => {
      const { queue, register, drain } = await create();
      const calls: unknown[] = [];
      register((invocation) => {
        calls.push(invocation);
        return Promise.resolve({ done: true, result: 'ok' });
      });
      await queue.enqueue({ job: JOBS.syncBroker, payload });
      await drain();
      expect(calls).toEqual([{ payload, cursor: undefined }]);
    });

    it('re-delivers a job with the cursor of its previous step until it is done', async () => {
      const { queue, register, drain } = await create();
      const cursors: (string | undefined)[] = [];
      register(({ cursor }) => {
        cursors.push(cursor);
        if (cursor === undefined) return Promise.resolve({ done: false, next: 'page-2', delayMs: 1 });
        if (cursor === 'page-2') return Promise.resolve({ done: false, next: 'page-3' });
        return Promise.resolve({ done: true, result: 'finished' });
      });
      await queue.enqueue({ job: JOBS.syncBroker, payload });
      await drain();
      expect(cursors).toEqual([undefined, 'page-2', 'page-3']);
    });

    it('re-delivers a step that failed, with the same cursor', async () => {
      const { queue, register, drain } = await create();
      const seen: (string | undefined)[] = [];
      let failed = false;
      register(({ cursor }) => {
        seen.push(cursor);
        if (cursor === 'x' && !failed) {
          failed = true;
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve(cursor === undefined ? { done: false, next: 'x' } : { done: true, result: 1 });
      });
      await queue.enqueue({ job: JOBS.syncBroker, payload });
      await drain();
      expect(seen).toEqual([undefined, 'x', 'x']);
    });

    it('runs independent jobs separately', async () => {
      const { queue, register, drain } = await create();
      const users: string[] = [];
      register(({ payload: p }) => {
        users.push('userId' in p ? p.userId : 'all');
        return Promise.resolve({ done: true, result: null });
      });
      await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'a', portfolioId: 'p' } });
      await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
      await drain();
      expect([...users].sort((a, b) => a.localeCompare(b))).toEqual(['a', 'all']);
    });
  });
}
