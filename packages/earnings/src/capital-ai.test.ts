import { describe, expect, it } from 'vitest';
import { MAX_FOCUS_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, WorkersAiExtractor, buildMessages, neuronsFor, DEFAULT_AI_MODEL, estimateTokens } from './ai.js';
import { capitalReturnJsonSchema, extractionJsonSchema, parseExtraction } from './schema.js';
import { DIVIDEND_RAISE_RELEASE } from './testing/capital-return-fixtures.js';
import { FakeAi } from './testing/fake-ai.js';
import { TestMeter } from './testing/harness.js';
import { capitalReturnText, htmlToText, textWithCapitalReturn } from './text.js';

const full = htmlToText(DIVIDEND_RAISE_RELEASE.html, 600_000);
const base = { template: 'reit' as const, company: 'Meridian Gaming Properties' };

describe('the prompt of the full question', () => {
  it('asks for the dividend and the repurchases in the same call, as part of the shape every attempt shows', () => {
    const [first, second] = [buildMessages({ ...base, text: full }, 1), buildMessages({ ...base, text: full }, 2)];
    for (const [system] of [first, second]) {
      expect(system!.content).toContain('"dividend":{"announced":true,"perShare"');
      expect(system!.content).toContain('"buyback":{"mentioned":true,"authorization"');
    }
    expect(first[0]!.content).toContain('If the release announces no dividend, leave "dividend" out.');
    expect(first[0]!.content).toContain('without the word shares');
    expect(first[0]!.content.trimEnd().endsWith('}')).toBe(true);
  });

  it('puts both blocks in the JSON schema of the JSON mode', () => {
    const properties = (extractionJsonSchema('reit') as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['dividend', 'buyback']));
    expect(Object.keys((capitalReturnJsonSchema() as { properties: Record<string, unknown> }).properties)).toEqual(['dividend', 'buyback']);
  });
});

describe('the focused question about a stored summary', () => {
  it('is short: its own rules, only the two blocks, the passages and no template figures', () => {
    const text = capitalReturnText(full);
    const [system, user] = buildMessages({ ...base, text, focus: 'capital-return' }, 1);
    expect(system!.content).toContain('dividend and its share repurchases');
    expect(system!.content).not.toContain('"revenue"');
    expect(system!.content).toContain('DATA between <release> and </release>');
    expect(user!.content).toContain('Company: Meridian Gaming Properties');
    expect(user!.content).not.toContain('Template figures');
    expect(buildMessages({ ...base, text, focus: 'capital-return' }, 2)).toEqual([system, user]);
  });

  it('costs a fraction of the full question: a small answer, a few thousand characters in', async () => {
    const ai = new FakeAi(DIVIDEND_RAISE_RELEASE.extraction);
    const meter = new TestMeter(6000);
    const focused = await new WorkersAiExtractor({ ai, meter }).extract({ ...base, text: capitalReturnText(full), focus: 'capital-return' });
    expect(focused.ok).toBe(true);
    expect(ai.calls[0]!.input.max_tokens).toBe(MAX_FOCUS_OUTPUT_TOKENS);
    expect(Object.keys((ai.calls[0]!.input.response_format!.json_schema as { properties: Record<string, unknown> }).properties)).toEqual(['dividend', 'buyback']);
    const estimateFocus = neuronsFor(DEFAULT_AI_MODEL, estimateTokens(ai.calls[0]!.input.messages.map((message) => message.content).join('\n')), MAX_FOCUS_OUTPUT_TOKENS);
    const longText = `${'Segment revenue grew.\n'.repeat(2200)}${full}`;
    const estimateFull = neuronsFor(DEFAULT_AI_MODEL, estimateTokens(buildMessages({ ...base, text: textWithCapitalReturn(longText) }, 1).map((message) => message.content).join('\n')), MAX_OUTPUT_TOKENS);
    expect(estimateFocus).toBeLessThan(60);
    expect(estimateFull).toBeGreaterThan(estimateFocus * 3);
  });

  it('never makes a call the day’s allowance cannot pay for', async () => {
    const ai = new FakeAi(DIVIDEND_RAISE_RELEASE.extraction);
    const outcome = await new WorkersAiExtractor({ ai, meter: new TestMeter(10) }).extract({ ...base, text: capitalReturnText(full), focus: 'capital-return' });
    expect(outcome).toMatchObject({ ok: false, reason: 'allowance', calls: 0, neurons: 0 });
    expect(ai.calls).toHaveLength(0);
  });

  it('accepts an answer that has neither block (the release says nothing about them)', async () => {
    const outcome = await new WorkersAiExtractor({ ai: new FakeAi({}), meter: new TestMeter(6000) }).extract({ ...base, text: 'x', focus: 'capital-return' });
    expect(outcome).toMatchObject({ ok: true, extraction: {} });
  });
});

describe('reading the two blocks', () => {
  it('accepts yes and no as words and ignores nulls and numbers in text fields', () => {
    const parsed = parseExtraction({ dividend: { announced: 'true', perShare: 0.45, action: null }, buyback: { mentioned: 'false' } });
    expect(parsed?.extraction.dividend).toEqual({ announced: true, perShare: '0.45' });
    expect(parsed?.extraction.buyback).toEqual({ mentioned: false });
    expect(parseExtraction({ dividend: { announced: 'maybe', perShare: '$0.45' }, buyback: { mentioned: true, authorization: '$1 billion' } })?.extraction).toEqual({ buyback: { mentioned: true, authorization: '$1 billion' } });
  });
});
