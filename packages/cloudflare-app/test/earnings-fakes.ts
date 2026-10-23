import { FakeAi, type AiCall, type FixtureRelease } from '@portfolio/earnings/testing';
import { FakeSecService } from './fakes.js';
import type { EarningsStartOptions } from './suite.js';

/** The fake SEC of a stack: every invented release is one filing of its company; the ticker table maps the (US) symbol to the CIK. */
export function secFor(options: EarningsStartOptions | undefined): FakeSecService {
  const releases = options?.releases ?? [];
  const tickers = Object.fromEntries(releases.map((release) => [release.symbol.split('.')[0]!, { cik: Number(release.cik), title: release.name }]));
  return new FakeSecService(releases.map((release) => ({ release })), tickers);
}

/** A fake Workers AI binding that answers with the extraction of the release whose company the prompt names. */
export function fakeAiFor(releases: readonly FixtureRelease[]): FakeAi {
  return new FakeAi((call: AiCall) => releases.find((release) => call.input.messages[1]!.content.includes(`Company: ${release.name}`))?.extraction ?? {});
}

/** The same answers as a JSON map by company name, for the workerd bundle (it builds its fake AI from a binding). */
export const aiAnswers = (releases: readonly FixtureRelease[]): string => JSON.stringify(Object.fromEntries(releases.map((release) => [release.name, release.extraction])));
