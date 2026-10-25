/**
 * Press-release HTML to plain text. Deterministic and dependency-free (it runs in the Worker): scripts, styles and comments are dropped,
 * block elements become lines, table cells become ` | ` separated rows, entities are decoded and whitespace is collapsed. The text is
 * capped; when the release is longer the headline and the first tables come first and the cash flow statement is kept.
 */

export const MAX_RELEASE_CHARS = 48_000;

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
const SKIPPED_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'head', 'noscript', 'template', 'ix:header', 'ix:hidden', 'ix:references', 'ix:resources']);
/** Elements that may be hidden with an inline `display:none` (inline XBRL puts its header in such a `div`). */
const HIDEABLE_TAGS: ReadonlySet<string> = new Set(['div', 'span', 'table', 'section']);
const HIDDEN_STYLE = /style\s*=\s*["'][^"']*display\s*:\s*none/i;

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
  while (end < tag.length && /[a-zA-Z0-9:]/.test(tag[end]!)) end += 1;
  return { name: tag.slice(closing ? 1 : 0, end).toLowerCase(), closing };
}

/** Index just after the end of a skipped element that starts at `from`, or the end of the input. */
function skipElement(lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) return lower.length;
  const end = lower.indexOf('>', close);
  return end === -1 ? lower.length : end + 1;
}

/** Like `skipElement`, for an element that may hold elements of its own name (a hidden `div` with `div`s inside). */
function skipNested(lower: string, name: string, from: number): number {
  let depth = 1;
  let index = from;
  while (depth > 0) {
    const open = lower.indexOf(`<${name}`, index);
    const close = lower.indexOf(`</${name}`, index);
    if (close === -1) return lower.length;
    const nested = open !== -1 && open < close;
    depth += nested ? 1 : -1;
    index = (nested ? open : close) + name.length + 1;
  }
  const end = lower.indexOf('>', index);
  return end === -1 ? lower.length : end + 1;
}

/** What a tag leaves in the text: a cell separator, a line break, or nothing. */
function tagText(name: string, closing: boolean): string {
  if (CELL_TAGS.has(name)) return closing ? ' | ' : ' ';
  return BLOCK_TAGS.has(name) ? '\n' : '';
}

/** Reads the comment or tag that starts at `open`: the text it leaves and where reading goes on; `undefined` for a tag that never ends. */
function readTag(html: string, lower: string, open: number): { text: string; next: number } | undefined {
  if (html.startsWith('<!--', open)) {
    const end = html.indexOf('-->', open + 4);
    return { text: '', next: end === -1 ? html.length : end + 3 };
  }
  const close = html.indexOf('>', open);
  if (close === -1) return undefined;
  const { name, closing } = tagName(html.slice(open + 1, close));
  if (!closing && SKIPPED_TAGS.has(name)) return { text: '', next: skipElement(lower, name, close + 1) };
  if (!closing && HIDEABLE_TAGS.has(name) && HIDDEN_STYLE.test(html.slice(open, close))) return { text: '', next: skipNested(lower, name, close + 1) };
  return { text: tagText(name, closing), next: close + 1 };
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
    const step = readTag(html, lower, open);
    if (step === undefined) break;
    out += step.text;
    index = step.next;
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
  while (head < lines.length && used + lines[head]!.length + 1 <= headBudget) {
    used += lines[head]!.length + 1;
    head += 1;
  }
  const cashFlow = lines.findIndex((line, index) => index >= head && /cash flows?/i.test(line));
  const tail: string[] = [];
  let tailUsed = 0;
  for (let index = cashFlow === -1 ? head : cashFlow; index < lines.length && used + tailUsed + lines[index]!.length + 1 <= max; index++) {
    tail.push(lines[index]!);
    tailUsed += lines[index]!.length + 1;
  }
  return [...lines.slice(0, head), ...tail].join('\n');
}

/** Lines longer than this are cut at a space: one paragraph that holds a whole release must not hide the rest of the text from the cap. */
const MAX_LINE_CHARS = 1500;

function splitLongLine(line: string): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > MAX_LINE_CHARS) {
    const space = rest.lastIndexOf(' ', MAX_LINE_CHARS);
    const at = space > MAX_LINE_CHARS / 2 ? space : MAX_LINE_CHARS;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  parts.push(rest);
  return parts;
}

/** The plain text of an HTML (or plain text) press release, capped at `max` characters. */
export function htmlToText(html: string, max = MAX_RELEASE_CHARS): string {
  const lines = decodeEntities(flatten(html))
    .split('\n')
    .map(cleanLine)
    .filter((line) => line !== '' && !isPipeOnly(line))
    .flatMap((line) => splitLongLine(line));
  return capText(lines.join('\n'), max);
}
