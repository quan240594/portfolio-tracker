import { errorMessage } from '../errors.js';
import type { RepairRows } from '../repository.js';
import { runUnits, whileAffordable, type StepContext } from './common.js';

/** A step stops taking symbols once it has read this many rows (a symbol holds about 250 EOD rows: a year of history); one symbol always runs. */
export const REPAIR_ROWS_PER_STEP = 5000;

/** The repair progress kept in the refresh cursor: `queue` is null until the first step, then the symbols still to do. */
export interface RepairState {
  queue: string[] | null;
  failed: number;
  rows: RepairRows;
}

export const initialRepair = (): RepairState => ({ queue: null, failed: 0, rows: { read: 0, written: 0 } });

/**
 * One step of the one-time repair of prices stored in a minor unit (see `PriceRepository.repairMinorUnits`). Resolves true when it is
 * finished (done before, or now). The marker is only set when every symbol was repaired, so a failure is retried by a later refresh;
 * the queue only ever shrinks, and a repaired row is never written again, so a rerun or a second concurrent alarm is a read-only pass.
 */
export async function runMinorUnitRepair(ctx: StepContext, repair: RepairState, symbols: readonly string[], now: Date): Promise<boolean> {
  if (repair.queue === null) {
    if (await ctx.repo.minorUnitRepairDone()) return true;
    repair.queue = [...symbols];
  }
  const queue = repair.queue;
  let readInStep = 0;
  await runUnits(
    whileAffordable(queue, () => readInStep < REPAIR_ROWS_PER_STEP),
    async (symbol) => {
      try {
        const rows = await ctx.repo.repairMinorUnits(symbol);
        readInStep += rows.read;
        repair.rows.read += rows.read;
        repair.rows.written += rows.written;
      } catch (error) {
        repair.failed += 1;
        ctx.logger.error('minor-unit repair failed', { symbol, error: errorMessage(error) });
      }
      queue.shift();
    },
  );
  if (queue.length > 0) return false;
  if (repair.failed === 0) await markDone(ctx, repair, now);
  return true;
}

/** A marker that cannot be written only means the pass is repeated (read-only) by a later refresh. */
async function markDone(ctx: StepContext, repair: RepairState, now: Date): Promise<void> {
  try {
    await ctx.repo.markMinorUnitRepair(now.toISOString(), repair.rows);
    ctx.logger.info('minor-unit prices repaired', { ...repair.rows });
  } catch (error) {
    ctx.logger.error('minor-unit repair marker not stored', { error: errorMessage(error) });
  }
}
