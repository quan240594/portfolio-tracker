import type { AiLike } from '@portfolio/earnings';
import { Hub as DeployedHub } from '../src/hub.js';
import type { HubOptions } from '../src/hub-core.js';
import type { HubEnv } from '../src/runtime.js';
import { createWorker } from '../src/worker.js';

/**
 * The Worker bundle of the workerd tests: the deployed Worker and Hub, bundled exactly like `wrangler deploy` does, plus
 * one test-only subclass of the Hub that (a) reads a pinned clock and small limits from bindings the deployment never has
 * and (b) answers `/__test/state` for the assertions that need to look inside. Nothing else differs from production.
 */
interface TestEnv extends HubEnv {
  TEST_NOW?: string;
  TEST_LIMITS?: string;
  /** JSON: company name -> the extraction the fake Workers AI answers for a release of that company. */
  TEST_AI?: string;
}

/** The Workers AI binding of the bundle under test: answers per company named in the prompt, like `FakeAi` of the earnings package does in Node. */
function fakeAi(answers: Record<string, unknown>): AiLike {
  return {
    run: (_model, input) => {
      const prompt = input.messages[1]?.content ?? '';
      const name = Object.keys(answers).find((company) => prompt.includes(`Company: ${company}`));
      return Promise.resolve({ response: name === undefined ? {} : answers[name], usage: { prompt_tokens: 4000, completion_tokens: 500 } });
    },
  };
}

export class Hub extends DeployedHub {
  protected static override hubOptions(env: HubEnv): HubOptions {
    const { TEST_NOW, TEST_LIMITS, TEST_AI } = env as TestEnv;
    return {
      ...(TEST_AI === undefined ? {} : { ai: fakeAi(JSON.parse(TEST_AI) as Record<string, unknown>) }),
      ...(TEST_NOW === undefined ? {} : { now: () => new Date(Number(TEST_NOW)) }),
      ...(TEST_LIMITS === undefined ? {} : { limits: JSON.parse(TEST_LIMITS) }),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const core = this.hubCore!;
    await this.started();
    if (pathname === '/__test/enqueue') {
      await core.platform.jobs.enqueue((await request.json()) as never);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/__test/seed') {
      await core.platform.items.batchWrite(((await request.json()) as never[]).map((item) => ({ type: 'put' as const, item })));
      return new Response(null, { status: 204 });
    }
    if (pathname !== '/__test/state') return super.fetch(request);
    return Response.json({
      schedules: this.ctx.storage.sql.exec<{ name: string }>('SELECT name FROM schedules ORDER BY name').toArray().map((row) => row.name),
      alarm: await this.ctx.storage.getAlarm(),
      jobs: this.ctx.storage.sql.exec<{ job: string; due_at: number; attempts: number; state: string; last_error: string | null }>('SELECT job, due_at, attempts, state, last_error FROM jobs ORDER BY due_at').toArray(),
      pendingJobs: core.platform.jobs.nextJobDueAt(),
      failedJobs: core.platform.jobs.failedJobs().map(({ job, error }) => ({ job, error })),
      storageBytes: this.ctx.storage.sql.databaseSize ?? 0,
    });
  }
}

export default createWorker();
