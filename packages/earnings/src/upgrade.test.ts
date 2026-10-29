import { describe, expect, it } from 'vitest';
import { EARNINGS_SCHEMA_VERSION, type EarningsHolding, type EarningsPlanItem, type EarningsSummary } from '@portfolio/shared';
import { WorkersAiExtractor } from './ai.js';
import { armedMarker, reopenOutdated } from './backfill.js';
import { FakeAi, type AiCall } from './testing/fake-ai.js';
import type { FilingSpec } from './testing/fake-sec.js';
import { DIVIDEND_RAISE_RELEASE, MESSY_CAPITAL_RELEASE, NO_DIVIDEND_RELEASE } from './testing/capital-return-fixtures.js';
import type { FixtureRelease } from './testing/fixtures.js';
import { earningsHarness, type EarningsHarness, type HarnessOptions } from './testing/harness.js';
import { buildReleaseSummary } from './testing/summary.js';

const DATES = ['2026-10-21', '2026-07-22'];
const FOCUS = 'dividend and its share repurchases';

const holding = (release: FixtureRelease): EarningsHolding => ({ symbol: release.symbol, name: release.name, template: release.template, currency: 'USD' });

function filings(release: FixtureRelease): FilingSpec[] {
  return DATES.map((date, index) => ({ release: { ...release, filingDate: date, accession: `${release.accession.slice(0, 14)}${String(900 + index).padStart(6, '0')}` } }));
}

function setup(releases: FixtureRelease[], extra: HarnessOptions = {}): EarningsHarness {
  return earningsHarness({
    filings: releases.flatMap((release) => filings(release)),
    tickers: Object.fromEntries(releases.map((release) => [release.symbol, { cik: Number(release.cik), title: release.name }])),
    holdings: releases.map(holding),
    ai: new FakeAi((call: AiCall) => releases.find((release) => call.input.messages[1]!.content.includes(`Company: ${release.name}`))?.extraction),
    env: { EARNINGS_BACKFILL_QUARTERS: '2' },
    ...extra,
  });
}

async function run(h: EarningsHarness, trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<void> {
  await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger } });
  await h.queue.drain();
}

const focused = (h: EarningsHarness): number => h.ai.calls.filter((call) => call.input.messages[0]!.content.includes(FOCUS)).length;
const announcements = (h: EarningsHarness): number => h.queue.enqueued.filter((message) => message.job === 'notifyDividends').length;

/** What a deployment of the previous version holds: summaries without the two blocks, a finished backfill, a plan compared with nothing. */
async function downgrade(h: EarningsHarness, releases: FixtureRelease[]): Promise<void> {
  for (const release of releases) {
    for (const summary of await h.repo.latest(release.symbol, 8)) {
      const { dividend: _dividend, buyback: _buyback, ...rest } = summary;
      await h.repo.putSummary({ ...rest, schemaVersion: 1 });
    }
    await h.repo.patchState(release.symbol, { summaryVersion: undefined }, h.clock.now());
  }
  const { schemaVersion: _version, upgrade: _upgrade, ...marker } = (await h.repo.getBackfill())!;
  await h.repo.putBackfill(marker);
}

const OLD_SUMMARIES = (release: FixtureRelease): EarningsSummary[] =>
  DATES.map((date, index) => {
    const { summary } = buildReleaseSummary({ ...release, filingDate: date, accession: `${release.accession.slice(0, 14)}${String(900 + index).padStart(6, '0')}` });
    const { dividend: _dividend, buyback: _buyback, ...rest } = summary;
    return { ...rest, schemaVersion: 1, origin: index === 0 ? 'live' : 'backfill' };
  });

describe('a new release is read once, with the dividend and the repurchases in the same call', () => {
  it('stores both blocks from the one model call and none from a second', async () => {
    const h = setup([DIVIDEND_RAISE_RELEASE, NO_DIVIDEND_RELEASE]);
    await run(h);
    expect(h.ai.calls).toHaveLength(4);
    expect(focused(h)).toBe(0);
    const raise = (await h.repo.latest('MGPR', 2))[0]!;
    expect(raise.schemaVersion).toBe(EARNINGS_SCHEMA_VERSION);
    expect(raise.dividend).toMatchObject({ status: 'announced', perShare: 0.45, action: 'raised', changePct: 4.7, payDate: '2027-01-15' });
    expect(raise.buyback).toMatchObject({ status: 'announced', repurchased: 120_000_000, remaining: 880_000_000 });
    const none = (await h.repo.latest('NGTI', 2))[0]!;
    expect([none.dividend, none.buyback]).toEqual([{ status: 'none' }, { status: 'none' }]);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', schemaVersion: EARNINGS_SCHEMA_VERSION });
    expect((await h.repo.getBackfill())!.upgrade).toBeUndefined();
  });
});

describe('a long release whose dividend paragraph lies beyond the text cap', () => {
  const filler = Array.from({ length: 800 }, (_, index) => `<div>Segment ${index} revenue grew in the quarter as customers added capacity across the region and the portfolio.</div>`).join('\n');
  const long: FixtureRelease = { ...DIVIDEND_RAISE_RELEASE, html: DIVIDEND_RAISE_RELEASE.html.replace('<div>Dividend:', `${filler}\n<div>Dividend:`) };

  it('adds the passages about dividends and repurchases to the same call, and verifies the answer against them', async () => {
    const h = setup([long]);
    await run(h);
    const prompt = h.ai.calls[0]!.input.messages[1]!.content;
    expect(prompt).toContain('Further passages about dividends and share repurchases:');
    expect(prompt.split('Further passages about dividends and share repurchases:')[1]).toContain('declared a quarterly dividend of $0.45 per common share');
    expect(prompt.length).toBeLessThan(48_000 + 4000 + 400);
    expect(focused(h)).toBe(0);
    const [newest] = await h.repo.latest('MGPR', 1);
    expect(newest!.dividend).toMatchObject({ status: 'announced', perShare: 0.45, action: 'raised', payDate: '2027-01-15' });
    expect(newest!.buyback).toMatchObject({ status: 'announced', remaining: 880_000_000 });
  });

  it('sends only the passages when a stored summary is read again', async () => {
    const h = setup([long]);
    await run(h);
    await downgrade(h, [long]);
    h.ai.calls.length = 0;
    await run(h);
    const prompt = h.ai.calls[0]!.input.messages[1]!.content;
    expect(prompt.length).toBeLessThan(6000);
    expect(prompt).toContain('Passages about dividends and share repurchases:');
    expect((await h.repo.latest('MGPR', 1))[0]!.dividend).toMatchObject({ status: 'announced', perShare: 0.45 });
  });
});

describe('summaries stored by the previous version are read again, only for the two new blocks', () => {
  const releases = [DIVIDEND_RAISE_RELEASE, NO_DIVIDEND_RELEASE];

  it('re-extracts every old summary with the small question, keeps its figures and origin, and announces nothing', async () => {
    const h = setup(releases);
    await run(h);
    const before = await Promise.all(releases.map((release) => h.repo.latest(release.symbol, 4)));
    const announced = announcements(h);
    await downgrade(h, releases);
    h.ai.calls.length = 0;
    await run(h);
    expect(h.ai.calls).toHaveLength(4);
    expect(focused(h)).toBe(4);
    const after = await Promise.all(releases.map((release) => h.repo.latest(release.symbol, 4)));
    expect(after).toEqual(before.map((list) => list.map((summary) => ({ ...summary, verification: { ...summary.verification, neuronsEstimate: expect.any(Number), calls: 2 } }))));
    expect(announcements(h)).toBe(announced);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', schemaVersion: EARNINGS_SCHEMA_VERSION, total: 4, done: 4, stored: 4, failed: 0, upgrade: { total: 4, done: 4 } });
  });

  it('upgrades summaries that were stored before any plan existed, on the first step', async () => {
    const h = setup([DIVIDEND_RAISE_RELEASE]);
    for (const summary of OLD_SUMMARIES(DIVIDEND_RAISE_RELEASE)) await h.repo.putSummary(summary);
    await run(h);
    expect(h.ai.calls).toHaveLength(2);
    expect(focused(h)).toBe(2);
    expect((await h.repo.latest('MGPR', 4)).map((summary) => [summary.schemaVersion, summary.dividend?.status, summary.origin])).toEqual([
      [2, 'announced', 'live'],
      [2, 'announced', 'backfill'],
    ]);
    expect(announcements(h)).toBe(0);
  });

  it('is resumable: a run cut short by the allowance resumes after 00:00 UTC and reads each release once', async () => {
    const h = setup(releases, { allowance: 100_000 });
    await run(h);
    await downgrade(h, releases);
    h.ai.calls.length = 0;
    const spent = h.meter.spent;
    h.meter.spent = 100_000 - 130;
    await run(h);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'running', waitReason: 'allowance', upgrade: { total: 4 } });
    const first = focused(h);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(4);
    h.clock.advance(6 * 3_600_000);
    h.meter.spent = spent;
    await run(h);
    expect(focused(h)).toBe(4);
    expect(h.ai.calls).toHaveLength(4);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', upgrade: { total: 4, done: 4 } });
  });

  it('leaves the old summary as it was when the model fails, and tries again later', async () => {
    const h = setup(releases);
    await run(h);
    await downgrade(h, releases);
    const before = await h.repo.latest('MGPR', 4);
    const failing = new FakeAi(new Error('the model is down'));
    (h.deps as { extractor: unknown }).extractor = new WorkersAiExtractor({ ai: failing, meter: h.meter, model: h.config.model });
    await run(h);
    expect(await h.repo.latest('MGPR', 4)).toEqual(before);
    expect(await h.repo.getBackfill()).toMatchObject({ failed: 0 });
    expect((await h.repo.getBackfill())!.upgrade!.done).toBeLessThan(4);
  });

  it('does not read again on "Fetch all now" what is already read', async () => {
    const h = setup(releases);
    await run(h);
    await downgrade(h, releases);
    await run(h);
    h.ai.calls.length = 0;
    await h.repo.putBackfill(armedMarker(2, 'manual', h.clock.now()));
    await run(h, 'manual');
    expect(h.ai.calls).toHaveLength(0);
    expect((await h.repo.latest('MGPR', 4)).every((summary) => summary.schemaVersion === EARNINGS_SCHEMA_VERSION)).toBe(true);
  });

  it('reads an old summary again on "Fetch all now" when it is still old', async () => {
    const h = setup([DIVIDEND_RAISE_RELEASE]);
    await run(h);
    await downgrade(h, [DIVIDEND_RAISE_RELEASE]);
    await h.repo.putBackfill(armedMarker(2, 'manual', h.clock.now()));
    h.ai.calls.length = 0;
    await run(h, 'manual');
    expect(focused(h)).toBe(2);
    expect(h.ai.calls).toHaveLength(2);
  });

  it('recomputes the newer dividend against an older quarter when that one is read afterwards', async () => {
    const h = setup([MESSY_CAPITAL_RELEASE]);
    await run(h);
    const [newest] = await h.repo.latest('HRTD', 2);
    expect(newest!.dividend).toMatchObject({ action: 'maintained', actionSource: 'computed', previousSource: 'stored', changePct: 0 });
    await downgrade(h, [MESSY_CAPITAL_RELEASE]);
    await run(h);
    const [after] = await h.repo.latest('HRTD', 2);
    expect(after!.dividend).toMatchObject({ action: 'maintained', actionSource: 'computed', previousSource: 'stored' });
  });

  it('reopens only the stored releases whose summary is old', () => {
    const item = (accession: string, status: EarningsPlanItem['status']): EarningsPlanItem => ({ accession, form: '8-K', filingDate: '2026-10-21', reportDate: `2026-10-2${accession}`, primaryDocument: 'p.htm', status, tries: 2, triesDay: '2026-10-21' });
    const summary = (digit: string, schemaVersion: number) => ({ ...buildReleaseSummary(DIVIDEND_RAISE_RELEASE).summary, accession: digit, reportDate: `2026-10-2${digit}`, schemaVersion });
    const plan = [item('1', 'stored'), item('2', 'stored'), item('3', 'todo'), item('4', 'stored')];
    const next = reopenOutdated(plan, [summary('1', 1), summary('2', EARNINGS_SCHEMA_VERSION), summary('3', 1)]);
    expect(next.map((entry) => [entry.status, entry.upgrade, entry.tries])).toEqual([
      ['todo', EARNINGS_SCHEMA_VERSION, 0],
      ['stored', undefined, 2],
      ['todo', undefined, 2],
      ['stored', undefined, 2],
    ]);
  });
});
