import { describe, expect, it } from 'vitest';
import { USAGE_METRICS, USAGE_METRIC_LABELS, usageSnapshotSchema, type UsageMetricSnapshot, type UsageSnapshot } from './usage-api.js';

const metric = (used: number, limit: number): UsageMetricSnapshot => ({ used, limit, percent: (used / limit) * 100, state: 'ok' });

const snapshot = (): UsageSnapshot => ({
  day: '2026-10-19',
  generatedAt: '2026-10-19T10:00:00.000Z',
  resetsAt: '2026-10-20T00:00:00.000Z',
  state: 'ok',
  thresholds: { warnPercent: 60, blockPercent: 80 },
  metrics: {
    workerRequests: metric(10, 100_000),
    durableObjectRequests: metric(10, 100_000),
    durableObjectGbSeconds: metric(1.5, 13_000),
    rowsRead: metric(100, 5_000_000),
    rowsWritten: metric(5, 100_000),
    aiNeurons: metric(120, 10_000),
    storageBytes: metric(2048, 1_000_000_000),
  },
});

describe('usage contract', () => {
  it('has a label for every metric', () => {
    expect(USAGE_METRICS.every((name) => USAGE_METRIC_LABELS[name].length > 0)).toBe(true);
  });

  it('accepts a valid snapshot', () => {
    expect(usageSnapshotSchema.parse(snapshot())).toEqual(snapshot());
  });

  it('accepts the unavailable state', () => {
    expect(usageSnapshotSchema.safeParse({ ...snapshot(), state: 'unavailable' }).success).toBe(true);
  });

  it.each([
    ['a missing metric', { ...snapshot(), metrics: { ...snapshot().metrics, rowsRead: undefined } }],
    ['an unknown state', { ...snapshot(), state: 'full' }],
    ['a malformed day', { ...snapshot(), day: '19-10-2026' }],
    ['a malformed instant', { ...snapshot(), resetsAt: 'tomorrow' }],
    ['a zero limit', { ...snapshot(), metrics: { ...snapshot().metrics, rowsRead: metric(1, 0) } }],
  ])('rejects %s', (_name, payload) => {
    expect(usageSnapshotSchema.safeParse(payload).success).toBe(false);
  });
});
