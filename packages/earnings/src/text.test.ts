import { describe, expect, it } from 'vitest';
import { MAX_RELEASE_CHARS, capText, decodeEntities, htmlToText } from './text.js';

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and keeps unknown ones', () => {
    expect(decodeEntities('R&amp;D &lt;b&gt; &#8364;5 &#x20AC;6 &nbsp;x &bogus; &#0; &#99999999; a & b &amp')).toBe('R&D <b> €5 €6  x &bogus; &#0; &#99999999; a & b &amp');
  });
});

describe('htmlToText', () => {
  it('drops scripts, styles, comments and the head; keeps blocks as lines and cells as pipes', () => {
    const html = '<html><head><title>t</title></head><body><style>p{}</style><script>var x="secret"</script><!-- hidden $9 -->' +
      '<p>Revenue&nbsp;was <b>$4.8</b> billion</p><table><tr><td>Net&nbsp;income</td><td></td><td>1,098</td></tr><tr><td>EPS</td><td>$1.45</td></tr></table>' +
      '<br>Line two<noscript>no</noscript></body></html>';
    expect(htmlToText(html)).toBe('Revenue was $4.8 billion\nNet income | 1,098\nEPS | $1.45\nLine two');
  });

  it('handles unterminated tags, comments and skipped elements without hanging', () => {
    expect(htmlToText('a<!-- open')).toBe('a');
    expect(htmlToText('a<script>never closed')).toBe('a');
    expect(htmlToText('a<script>x</script')).toBe('a');
    expect(htmlToText('a < b <p')).toBe('a');
    expect(htmlToText('plain text\n\n\nmore')).toBe('plain text\nmore');
    expect(htmlToText('<p>| | |</p><p>real</p>')).toBe('real');
  });

  it('decodes entities after removing tags, so an escaped tag stays text', () => {
    expect(htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('<script>alert(1)</script>');
  });
});

describe('capText', () => {
  const lines = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix} line ${index} ${'x'.repeat(40)}`);

  it('returns short text unchanged', () => {
    expect(capText('short', 100)).toBe('short');
  });

  it('keeps the start and, when it would be cut off, the cash flow statement', () => {
    const text = [...lines(60, 'head'), 'CONDENSED CONSOLIDATED STATEMENTS OF CASH FLOWS', ...lines(10, 'cash')].join('\n');
    const capped = capText(text, 2000);
    expect(capped.length).toBeLessThanOrEqual(2000);
    expect(capped).toContain('head line 0');
    expect(capped).toContain('STATEMENTS OF CASH FLOWS');
    expect(capped).toContain('cash line 0');
  });

  it('without a cash flow statement it keeps the first lines', () => {
    const capped = capText(lines(100, 'only').join('\n'), 1000);
    expect(capped.length).toBeLessThanOrEqual(1000);
    expect(capped.startsWith('only line 0')).toBe(true);
  });

  it('caps a very long release at the default size', () => {
    expect(htmlToText(`<p>${'word '.repeat(40_000)}</p>`.replaceAll('word ', 'word</p><p>')).length).toBeLessThanOrEqual(MAX_RELEASE_CHARS);
  });
});
