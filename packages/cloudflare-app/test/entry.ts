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
}

export class Hub extends DeployedHub {
  protected static override hubOptions(env: HubEnv): HubOptions {
    const { TEST_NOW, TEST_LIMITS } = env as TestEnv;
    return {
      ...(TEST_NOW === undefined ? {} : { now: () => new Date(Number(TEST_NOW)) }),
      ...(TEST_LIMITS === undefined ? {} : { limits: JSON.parse(TEST_LIMITS) }),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/__test/state') return super.fetch(request);
    const core = this.hubCore!;
    return Response.json({
      alarm: await this.ctx.storage.getAlarm(),
      pendingJobs: core.platform.jobs.nextJobDueAt(),
      failedJobs: core.platform.jobs.failedJobs().map(({ job, error }) => ({ job, error })),
      storageBytes: this.ctx.storage.sql.databaseSize ?? 0,
    });
  }
}

export default createWorker();
