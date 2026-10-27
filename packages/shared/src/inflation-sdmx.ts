/**
 * Reader of the ECB's SDMX-JSON 1.0 reply for one monthly inflation series (pure). Reply shape:
 * `dataSets[0].series["0:0:0:0:0:0"].observations` maps an index to `[value, ...]`, and the index points into
 * `structure.dimensions.observation`, the TIME_PERIOD dimension, whose values are `{ id: "YYYY-MM" }`. Strict: anything that is not
 * exactly one series of plausible monthly rates is rejected with a reason, never repaired.
 */
import { z } from 'zod';
import type { InflationPoint } from './inflation-api.js';

/** Fewer months than this is not a usable series (the shortest horizon needs five years). */
export const MIN_INFLATION_POINTS = 24;
const PLAUSIBLE_RATE = { min: -50, max: 100 };

const sdmxSchema = z.object({
  dataSets: z.array(z.object({ series: z.record(z.object({ observations: z.record(z.array(z.unknown()).min(1)) })) })).length(1),
  structure: z.object({ dimensions: z.object({ observation: z.array(z.object({ id: z.string(), values: z.array(z.object({ id: z.string() })) })) }) }),
});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const plausible = (value: unknown): value is number => typeof value === 'number' && value > PLAUSIBLE_RATE.min && value < PLAUSIBLE_RATE.max;

export type InflationReplyResult = { points: InflationPoint[] } | { error: string };

/** The monthly points (oldest first) of a reply body, or why it is not the expected series. Months without a value are left out. */
export function parseInflationReply(body: string): InflationReplyResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { error: 'not JSON' };
  }
  const parsed = sdmxSchema.safeParse(json);
  if (!parsed.success) return { error: 'unexpected structure' };
  const seriesList = Object.values(parsed.data.dataSets[0]!.series);
  const time = parsed.data.structure.dimensions.observation.find((d) => d.id === 'TIME_PERIOD');
  if (seriesList.length !== 1 || !time) return { error: 'one series with a time dimension is expected' };
  const byMonth = new Map<string, number>();
  for (const [index, observation] of Object.entries(seriesList[0]!.observations)) {
    const month = time.values[Number(index)]?.id;
    const value = observation[0];
    if (month === undefined || !MONTH.test(month) || byMonth.has(month)) return { error: 'unknown or repeated month' };
    if (value === null) continue;
    if (!plausible(value)) return { error: 'implausible rate' };
    byMonth.set(month, value);
  }
  const points = [...byMonth].map(([month, ratePct]) => ({ month, ratePct })).sort((a, b) => a.month.localeCompare(b.month));
  return points.length < MIN_INFLATION_POINTS ? { error: 'too few months' } : { points };
}

/** An SDMX-JSON reply carrying `points`, in the shape `parseInflationReply` reads: for fakes and fixtures (tests, the demo's mock backend). */
export function buildInflationReply(points: readonly InflationPoint[]): string {
  const observations = Object.fromEntries(points.map((point, index) => [String(index), [point.ratePct, 0, null]]));
  return JSON.stringify({
    header: { id: 'fixture', test: true },
    dataSets: [{ action: 'Replace', series: { '0:0:0:0:0:0': { attributes: [], observations } } }],
    structure: { dimensions: { series: [], observation: [{ id: 'TIME_PERIOD', name: 'Time period or range', role: 'time', values: points.map((p) => ({ id: p.month, name: p.month })) }] } },
  });
}
