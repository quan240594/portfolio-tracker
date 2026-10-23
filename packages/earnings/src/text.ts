/**
 * Press-release HTML to plain text. Deterministic and dependency-free (it runs in the Worker): scripts, styles and comments are dropped,
 * block elements become lines, table cells become ` | ` separated rows, entities are decoded and whitespace is collapsed. The text is
 * capped; when the release is longer the headline and the first tables come first and the cash flow statement is kept.
 */

export const MAX_RELEASE_CHARS = 60_000;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  minus: '−',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
};

const BLOCK_TAGS: ReadonlySet<string> = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr', 'body']);
const CELL_TAGS: ReadonlySet<string> = new Set(['td', 'th']);
const SKIPPED_TAGS: readonly string[] = ['script', 'style', 'head', 'noscript', 'template'];

function decodeEntity(body: string): string | undefined {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
  }
  return ENTITIES[body.toLowerCase()];
}

/** Decodes the named and numeric entities of `text`; an unknown one is kept as written. */
export function decodeEntities(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf('&', index);
    if (amp === -1) break;
    out += text.slice(index, amp);
    const semicolon = text.indexOf(';', amp);
    const decoded = semicolon !== -1 && semicolon - amp <= 10 ? decodeEntity(text.slice(amp + 1, semicolon)) : undefined;
    if (decoded === undefined) {
      out += '&';
      index = amp + 1;
    } else {
      out += decoded;
      index = semicolon + 1;
    }
  }
  return out + text.slice(index);
}

/** The lower-case name of the tag that starts at `tag` (the text between `<` and `>`), and whether it closes. */
function tagName(tag: string): { name: string; closing: boolean } {
  const closing = tag.startsWith('/');
  let end = closing ? 1 : 0;
  while (end < tag.length && /[a-zA-Z0-9]/.test(tag[end]!)) end += 1;
  return { name: tag.slice(closing ? 1 : 0, end).toLowerCase(), closing };
}

/** Index just after the end of a skipped element that starts at `from`, or the end of the input. */
function skipElement(lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) return lower.length;
  const end = lower.indexOf('>', close);
  return end === -1 ? lower.length : end + 1;
}

/** Tags and entities out, structure kept as line breaks (blocks) and ` | ` (table cells). */
function flatten(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, open);
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf('>', open);
    if (close === -1) break;
    const { name, closing } = tagName(html.slice(open + 1, close));
    index = close + 1;
    if (!closing && SKIPPED_TAGS.includes(name)) index = skipElement(lower, name, index);
    else if (CELL_TAGS.has(name)) out += closing ? ' | ' : ' ';
    else if (BLOCK_TAGS.has(name)) out += '\n';
  }
  return out;
}

const isPipeOnly = (line: string): boolean => line.replaceAll('|', '').trim() === '';

/** One cleaned line: whitespace collapsed, empty cells and repeated separators removed. */
function cleanLine(raw: string): string {
  const cells = raw
    .replaceAll(/[\u00a0\u2007\u202f\u200b]/g, ' ')
    .split('|')
    .map((cell) => cell.replaceAll(/\s+/g, ' ').trim())
    .filter((cell) => cell !== '');
  return cells.join(' | ');
}

/**
 * Keeps at most `max` characters of the lines: the start of the release (headline, highlights, income statement) first, and when
 * the cash flow statement would be cut off its lines are kept instead of the middle.
 */
export function capText(text: string, max = MAX_RELEASE_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const headBudget = Math.floor(max * 0.7);
  let head = 0;
  let used = 0;
  while (head < lines.length && used + lines[head]!.length + 1 <= headBudget) used += lines[head++]!.length + 1;
  const cashFlow = lines.findIndex((line, index) => index >= head && /cash flows?/i.test(line));
  const tail: string[] = [];
  let tailUsed = 0;
  for (let index = cashFlow === -1 ? head : cashFlow; index < lines.length && used + tailUsed + lines[index]!.length + 1 <= max; index++) {
    tail.push(lines[index]!);
    tailUsed += lines[index]!.length + 1;
  }
  return [...lines.slice(0, head), ...tail].join('\n');
}

/** The plain text of an HTML (or plain text) press release, capped at `max` characters. */
export function htmlToText(html: string, max = MAX_RELEASE_CHARS): string {
  const lines = decodeEntities(flatten(html))
    .split('\n')
    .map(cleanLine)
    .filter((line) => line !== '' && !isPipeOnly(line));
  return capText(lines.join('\n'), max);
}
