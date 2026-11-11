/**
 * Markdown → plain text for OurFamilyWizard message bodies.
 *
 * OFW renders a body as plain text: verified in the web app 2026-11-11, the
 * read view HTML-escapes the body (a `&` arrives as `&amp;`), auto-links
 * https URLs, emails and phone numbers, and shows it in a `white-space:
 * pre-wrap` span. Markdown is never rendered, so `**urgent**` reaches the
 * co-parent — and the court-visible record — with its asterisks. Models write
 * Markdown by habit, so the write tools run the body through this first.
 *
 * Rules, all deliberately conservative (when in doubt, leave the text alone):
 * - bold/italic markers are stripped; word-internal `_`/`*` (snake_case,
 *   a*b) and spaced `*` (3 * 4) are not emphasis
 * - `[text](url)` → `text (url)` (OFW auto-links the url); `<url>` → url
 * - `# Heading` → `Heading`
 * - lists: `*`/`+` → `-`; 4 spaces per nesting level; numbered lists are
 *   renumbered from their first number (Markdown's `1. 1. 1.` means 1, 2, 3),
 *   the second level is lettered (a., b.), and markers are padded so item
 *   text lines up past 9
 * - code spans, fenced blocks, URLs and ~~strikethrough~~ (stripping it would
 *   invert its meaning) are left exactly as written
 *
 * Idempotent: converting the output again changes nothing, so a draft that
 * is re-saved does not drift. When nothing changes the input is returned
 * byte-for-byte (line endings included).
 */

export type BodyChange =
  | 'headings'
  | 'bold/italic'
  | 'links'
  | 'list markers'
  | 'list numbering'
  | 'list indentation';

const CHANGE_ORDER: readonly BodyChange[] = [
  'headings', 'bold/italic', 'links', 'list markers', 'list numbering', 'list indentation',
];

export interface BodyConversion {
  text: string;
  /** What was converted, in a fixed order; empty when the text is unchanged. */
  changes: BodyChange[];
}

const PH_OPEN = '';
const PH_CLOSE = '';
const PLACEHOLDER = /(\d+)/g;

function convertInline(line: string, changes: Set<BodyChange>): string {
  // A body that already holds our private-use markers is left alone rather
  // than risk restoring the wrong span into it.
  if (line.includes(PH_OPEN) || line.includes(PH_CLOSE)) return line;
  const kept: string[] = [];
  const protect = (s: string): string => `${PH_OPEN}${kept.push(s) - 1}${PH_CLOSE}`;

  let s = line.replace(/(`+)[^`]+?\1(?!`)/g, protect);

  const beforeLinks = s;
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_m, url: string) => protect(url));
  s = s.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const bare = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return bare(text) === bare(url) ? protect(url) : `${text} (${protect(url)})`;
  });
  if (s !== beforeLinks) changes.add('links');

  s = s.replace(/https?:\/\/\S+/g, protect);

  const beforeEmphasis = s;
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1');
  s = s.replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1');
  s = s.replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '$1');
  s = s.replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '$1');
  if (s !== beforeEmphasis) changes.add('bold/italic');

  while (s.includes(PH_OPEN)) {
    s = s.replace(PLACEHOLDER, (_m, i: string) => kept[Number(i)]);
  }
  return s;
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)]|[a-z]{1,2}[.)])([ \t]+)(\S.*)$/;

function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

/** a=1 … z=26, aa=27 … */
function alphaIndex(token: string): number {
  let n = 0;
  for (const ch of token) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n;
}

function toAlpha(n: number): string {
  let s = '';
  for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26)) {
    s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  }
  return s;
}

interface Item {
  line: number;
  indent: string;
  marker: string;
  sep: string;
  content: string;
}

interface Run {
  kind: 'bullet' | 'ordered';
  level: number;
  start: number;
  items: Item[];
}

interface Level {
  indent: number;
  run: Run;
}

export function markdownToPlainText(input: string): BodyConversion {
  const eol = input.includes('\r\n') ? '\r\n' : '\n';
  const lines = input.split(/\r?\n/);
  const out = [...lines];
  const changes = new Set<BodyChange>();
  const runs: Run[] = [];

  let fence: string | null = null;
  let stack: Level[] = [];
  let prevBlank = true;

  const endList = () => { stack = []; };

  lines.forEach((line, i) => {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      return;
    }
    const fenceOpen = FENCE.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      endList();
      prevBlank = false;
      return;
    }
    if (line.trim() === '') {
      prevBlank = true;
      return;
    }

    const m = ITEM.exec(line);
    if (m) {
      const [, ws, marker, sep, content] = m;
      const indent = indentWidth(ws);
      const bullet = /^[-*+]$/.test(marker);
      const letter = /^[a-z]/.test(marker);
      const token = bullet ? '' : marker.slice(0, -1);
      const accepted = letter
        ? stack.length > 0 && indent >= stack[0].indent + 2
        : stack.length > 0 || prevBlank || bullet || token === '1';
      if (accepted) {
        const kind = bullet ? 'bullet' : 'ordered';
        const start = bullet ? 0 : letter ? alphaIndex(token) : Number(token);
        const item: Item = { line: i, indent: ws, marker, sep, content };
        const newRun = (level: number): Run => {
          const run: Run = { kind, level, start, items: [item] };
          runs.push(run);
          return run;
        };
        if (stack.length === 0) {
          stack.push({ indent, run: newRun(0) });
        } else {
          while (stack.length > 1 && indent <= stack[stack.length - 1].indent - 2) stack.pop();
          const top = stack[stack.length - 1];
          if (indent >= top.indent + 2) {
            stack.push({ indent, run: newRun(stack.length) });
          } else if (top.run.kind !== kind) {
            top.run = newRun(stack.length - 1);
          } else {
            top.run.items.push(item);
          }
        }
        prevBlank = false;
        return;
      }
    }

    if (stack.length > 0 && /^[ \t]/.test(line)) {
      // An indented line inside a list continues the item above it.
      out[i] = convertInline(line, changes);
      prevBlank = false;
      return;
    }
    endList();
    const heading = HEADING.exec(line);
    if (heading) {
      out[i] = convertInline(heading[1], changes);
      changes.add('headings');
    } else {
      out[i] = convertInline(line, changes);
    }
    prevBlank = false;
  });

  for (const run of runs) {
    const lettered = run.kind === 'ordered' && run.level % 2 === 1;
    const markers = run.items.map((_, k) => {
      if (run.kind === 'bullet') return '-';
      return `${lettered ? toAlpha(run.start + k) : run.start + k}.`;
    });
    const width = Math.max(...markers.map((mk) => mk.length));
    run.items.forEach((item, k) => {
      const indent = ' '.repeat(4 * run.level);
      const sep = ' '.repeat(width - markers[k].length + 1);
      if (indent !== item.indent) changes.add('list indentation');
      const origToken = item.marker.replace(/[.)]$/, '');
      const newToken = markers[k].replace(/\.$/, '');
      if (run.kind === 'bullet' ? item.marker !== '-' : item.marker.endsWith(')')) changes.add('list markers');
      if (run.kind === 'ordered' && origToken !== newToken) changes.add('list numbering');
      if (sep !== item.sep) changes.add(run.kind === 'ordered' && width > 2 ? 'list numbering' : 'list markers');
      out[item.line] = `${indent}${markers[k]}${sep}${convertInline(item.content, changes)}`;
    });
  }

  if (changes.size === 0) return { text: input, changes: [] };
  return { text: out.join(eol), changes: CHANGE_ORDER.filter((c) => changes.has(c)) };
}

export type BodyFormat = 'markdown' | 'plain';

export const BODY_FORMAT_DESCRIPTION =
  'How to treat `body`. OurFamilyWizard shows message bodies as PLAIN TEXT — Markdown is never rendered, so **bold** would reach the co-parent with its asterisks. Default "markdown": Markdown is converted to plain text before anything is saved or sent (bold/italic markers and # heading markers dropped; [text](url) → "text (url)"; lists normalized to "-" bullets and renumbered 1., 2., … with a., b. for the second level, 4 spaces per nesting level; code, URLs and ~~strikethrough~~ left as written), and the response reports what changed under bodyConversion. "plain": send the body byte-for-byte. Line breaks, blank lines and leading spaces always survive; full https:// URLs, email addresses and phone numbers become links for the reader.';

export interface PreparedBody {
  body: string;
  /** Present only when the conversion changed something. */
  conversion: { changes: BodyChange[]; note: string } | null;
  /** The NOTE line for the tool's text prefix, or null. */
  noteLine: string | null;
}

/** Apply the write tools' `bodyFormat` to a caller-supplied body. */
export function prepareBody(body: string, format: BodyFormat | undefined): PreparedBody {
  if (format === 'plain') return { body, conversion: null, noteLine: null };
  const { text, changes } = markdownToPlainText(body);
  if (changes.length === 0) return { body, conversion: null, noteLine: null };
  const note = `OurFamilyWizard shows bodies as plain text, so Markdown was converted (${changes.join(', ')}). What was saved/sent is the converted text; pass bodyFormat:"plain" to send a body exactly as written.`;
  return {
    body: text,
    conversion: { changes, note },
    noteLine: `NOTE: the body was converted from Markdown to plain text (${changes.join(', ')}).`,
  };
}
