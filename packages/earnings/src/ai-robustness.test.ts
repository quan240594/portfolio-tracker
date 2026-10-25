import { describe, expect, it } from 'vitest';
import { sampleSummary } from '@portfolio/shared';
import { WorkersAiExtractor, JSON_MODE_MODELS, MAX_OUTPUT_TOKENS, buildMessages, classifyAiError, describeAiError, estimateTokens, neuronsFor, DEFAULT_AI_MODEL } from './ai.js';
import { withPrevious } from './derive.js';
import { parseExtraction } from './schema.js';
import { htmlToText, MAX_RELEASE_CHARS } from './text.js';
import { FakeAi } from './testing/fake-ai.js';
import { GENERIC_RELEASE } from './testing/fixtures.js';
import { TestMeter } from './testing/harness.js';
import { buildReleaseSummary } from './testing/summary.js';

const input = { text: htmlToText(GENERIC_RELEASE.html), template: 'generic' as const, company: 'Lumen Forge Technologies' };
const extractor = (ai: FakeAi, model?: string) => new WorkersAiExtractor({ ai, meter: new TestMeter(), ...(model === undefined ? {} : { model }) });

describe('the prompt carries the shape of the answer', () => {
  it('names every field in both attempts, so a model that ignores response_format still knows them', () => {
    for (const attempt of [1, 2] as const) {
      const system = buildMessages(input, attempt)[0]!.content;
      for (const field of ['"revenue"', '"epsAdjusted"', '"epsGaap"', '"operatingIncome"', '"kpis"', '"guidance"', '"keyUpdates"', '"quote"', '"yearAgo"']) expect(system).toContain(field);
      expect(system).toContain('<as printed>');
      expect(system.split('The JSON object has')[1]).not.toMatch(/\d/);
    }
  });

  it('asks for JSON mode first and plain text second', async () => {
    const ai = new FakeAi({ raw: 'not json' }, GENERIC_RELEASE.extraction);
    expect(await extractor(ai).extract(input)).toMatchObject({ ok: true, calls: 2 });
    expect(ai.calls[0]!.input.response_format).toMatchObject({ type: 'json_schema' });
    expect(ai.calls[1]!.input.response_format).toBeUndefined();
    expect(ai.calls[1]!.input.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('knows which models the JSON Mode page lists (the default is not one of them)', () => {
    expect(JSON_MODE_MODELS.has('@cf/meta/llama-3.1-8b-instruct')).toBe(true);
    expect(JSON_MODE_MODELS.has(DEFAULT_AI_MODEL)).toBe(false);
  });
});

describe('what the model may answer', () => {
  it('a string with a fence, an object (JSON mode) and numbers instead of text are all read', async () => {
    const fenced = new FakeAi({ raw: `Here you go:\n\`\`\`json\n${JSON.stringify(GENERIC_RELEASE.extraction)}\n\`\`\`` });
    expect(await extractor(fenced).extract(input)).toMatchObject({ ok: true, calls: 1 });
    expect(await extractor(new FakeAi(GENERIC_RELEASE.extraction)).extract(input)).toMatchObject({ ok: true });
    const numbers = await extractor(new FakeAi({ revenue: { value: 4.82, yearAgo: 4.3 }, epsGaap: { value: 1.45 } })).extract(input);
    expect(numbers).toMatchObject({ ok: true, extraction: { revenue: { value: '4.82', yearAgo: '4.3' }, epsGaap: { value: '1.45' } } });
  });

  it('one malformed field does not cost the others', () => {
    const parsed = parseExtraction({ revenue: { value: '$4.82 billion' }, epsGaap: 'oops', kpis: [{ key: 'x', value: '1' }, 5], guidance: [{ nope: 1 }], keyUpdates: 'not a list' });
    expect(parsed).toEqual({ lenient: true, extraction: { revenue: { value: '$4.82 billion' }, kpis: [{ key: 'x', value: '1' }] } });
    expect(parseExtraction({ revenue: { value: '$1' } })).toEqual({ lenient: false, extraction: { revenue: { value: '$1' } } });
    expect(parseExtraction('text')).toBeUndefined();
    expect(parseExtraction([1])).toBeUndefined();
    expect(parseExtraction({ revenue: 5, epsGaap: [] })).toBeUndefined();
  });

  it('an invalid first answer is followed by a second, then it gives up with the reason', async () => {
    const outcome = await extractor(new FakeAi({ raw: '{broken' }, { revenue: 5 })).extract(input);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-json', calls: 2, detail: 'schema' });
  });
});

describe('platform errors', () => {
  it('a platform error on the JSON mode attempt is answered with the plain attempt (the model may not support response_format)', async () => {
    const ai = new FakeAi(new Error('5016: Bad input: response_format is not supported for this model'), GENERIC_RELEASE.extraction);
    expect(await extractor(ai).extract(input)).toMatchObject({ ok: true, calls: 2 });
    expect(ai.calls[1]!.input.response_format).toBeUndefined();
  });

  it('an error on both attempts ends as ai-error with a sanitised reason', async () => {
    const ai = new FakeAi(new Error('Capacity temporarily exceeded see https://example.invalid/x?token=abc please retry'));
    const outcome = await extractor(ai).extract(input);
    expect(outcome).toMatchObject({ ok: false, reason: 'ai-error', calls: 2 });
    expect(outcome.ok ? '' : outcome.detail).toBe('Capacity temporarily exceeded see please retry');
    expect(describeAiError('boom')).toBe('unknown error');
    expect(describeAiError(new Error(`${'x'.repeat(300)}`))).toHaveLength(100);
    expect(describeAiError(new Error('caf\u00e9 \u0007 bell'))).toBe('caf bell');
  });

  it('too long an input is cut and asked again, never an error', async () => {
    const long = { ...input, text: 'Revenue of $4.82 billion for the quarter.\n'.repeat(1500) };
    const ai = new FakeAi(new Error('This model exceeds the context window of 32000 tokens'), GENERIC_RELEASE.extraction);
    const outcome = await extractor(ai).extract(long);
    expect(outcome).toMatchObject({ ok: true, calls: 2 });
    expect(ai.calls[1]!.input.messages[1]!.content.length).toBeLessThan(ai.calls[0]!.input.messages[1]!.content.length * 0.7);
    expect(classifyAiError(new Error('input too long'))).toBe('context');
  });

  it('too long an input that cannot be cut further moves on to the plain attempt and then gives up without throwing', async () => {
    const outcome = await extractor(new FakeAi(new Error('maximum context length exceeded'))).extract(input);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-json', detail: 'context' });
  });

  it('an input far beyond the model window is capped before any call, and costs a few hundred neurons at most', () => {
    const huge = `<html><body>${'<p>Revenue was $1.2 billion in the quarter, net income $200 million. </p>'.repeat(40_000)}</body></html>`;
    const text = htmlToText(huge);
    expect(text.length).toBeLessThanOrEqual(MAX_RELEASE_CHARS);
    const messages = buildMessages({ ...input, text }, 1);
    const tokens = estimateTokens(messages.map((message) => message.content).join('\n'));
    expect(tokens).toBeLessThan(20_000);
    expect(neuronsFor(DEFAULT_AI_MODEL, tokens, MAX_OUTPUT_TOKENS)).toBeLessThan(400);
  });
});

describe('quarter over quarter recomputed when the older quarter arrives later', () => {
  it('adds the figures and the guidance direction, removes stale ones, and is idempotent', () => {
    const older = sampleSummary({ symbol: 'LMFG', reportDate: '2026-07-22', reportingCurrency: 'USD', headline: { revenue: { value: 4_000_000_000, unit: 'money' }, eps: { value: 1.65, unit: 'perShare', basis: 'adjusted' } }, guidance: [{ label: 'Revenue fiscal year 2026', period: 'fiscal year 2026', unit: 'money', raw: '$18 billion', point: 18_000_000_000 }] });
    const { summary } = buildReleaseSummary(GENERIC_RELEASE);
    expect(summary.headline.revenue?.qoqPct).toBeUndefined();
    const once = withPrevious({ ...summary, headline: { ...summary.headline, revenue: { ...summary.headline.revenue!, qoqPct: 99 } } }, older);
    expect(once.previousReportDate).toBe('2026-07-22');
    expect(once.headline.revenue?.qoqPct).toBe(20.5);
    expect(once.headline.eps?.qoqPct).toBe(20);
    expect(once.guidance[0]!.direction).toBe('raised');
    expect(withPrevious(once, older)).toEqual(once);
    const other = withPrevious(once, { ...older, reportingCurrency: 'EUR' });
    expect(other.previousReportDate).toBeUndefined();
    expect(other.headline.revenue?.qoqPct).toBeUndefined();
  });
});
