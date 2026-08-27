/**
 * A small Markdown parser for agent output.
 *
 * Agent output is untrusted. This deliberately parses to a tree and never
 * produces HTML text: the renderer builds DOM nodes and assigns text through
 * `textContent`, so there is no path by which agent output can become markup.
 * `innerHTML` must never appear in the rendering of this tree.
 *
 * The subset is chosen for what agents actually emit — fenced code, lists,
 * headings, tables, emphasis, links — rather than for CommonMark coverage.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  /** TeX source, left unrendered here — the tree never contains markup. */
  | { type: "math"; text: string; display: boolean };

export type MdNode =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: MdNode[][] }
  | { type: "blockquote"; children: MdNode[] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

/**
 * Allow only schemes that cannot execute.
 *
 * `javascript:` is the obvious one, but `data:` is equally dangerous in a
 * link, and a scheme-relative `//host` URL would inherit the webview's own
 * scheme. Anything not recognised renders as plain text instead of a link.
 */
export function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  if (!href || href.startsWith("//")) return undefined;
  // Strip control characters and whitespace first: "java\nscript:" is still
  // javascript: to a URL parser.
  const collapsed = href.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  if (/^(https?|mailto):/.test(collapsed)) return href;
  // A relative or fragment link has no scheme at all.
  if (!/^[a-z][a-z0-9+.-]*:/.test(collapsed)) return href;
  return undefined;
}

// --- inline ------------------------------------------------------------------

const INLINE_PATTERNS: {
  regex: RegExp;
  build(match: RegExpExecArray): Inline;
}[] = [
  // Code first: its content is literal and must not be re-parsed.
  { regex: /^`+([^`]|[^`][\s\S]*?[^`])`+/, build: (m) => ({ type: "code", text: m[1].trim() }) },
  // Display maths before inline, or `$$x$$` reads as an empty inline pair.
  {
    regex: /^\$\$([\s\S]+?)\$\$/,
    build: (m) => ({ type: "math", text: m[1].trim(), display: true }),
  },
  {
    // A dollar in prose is usually money, not maths. Requiring a non-space
    // just inside each delimiter leaves "it cost $5 and $10" alone, because
    // the closing candidate is preceded by a space.
    regex: /^\$(?=\S)([^\n$]*[^\s$])\$/,
    build: (m) => ({ type: "math", text: m[1], display: false }),
  },
  {
    regex: /^\[([^\]]*)\]\(([^)\s]*)\)/,
    build: (m) => {
      const href = safeHref(m[2]);
      // An unusable scheme degrades to text rather than to a dead or unsafe link.
      return href
        ? { type: "link", href, children: parseInline(m[1]) }
        : { type: "text", text: `[${m[1]}](${m[2]})` };
    },
  },
  { regex: /^\*\*([\s\S]+?)\*\*/, build: (m) => ({ type: "strong", children: parseInline(m[1]) }) },
  { regex: /^__([\s\S]+?)__/, build: (m) => ({ type: "strong", children: parseInline(m[1]) }) },
  { regex: /^~~([\s\S]+?)~~/, build: (m) => ({ type: "strike", children: parseInline(m[1]) }) },
  { regex: /^\*([^*\s][\s\S]*?)\*/, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
  { regex: /^_([^_\s][\s\S]*?)_/, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
  {
    regex: /^<(https?:\/\/[^>\s]+)>/,
    build: (m) => ({ type: "link", href: m[1], children: [{ type: "text", text: m[1] }] }),
  },
];

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let index = 0;

  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };

  while (index < source.length) {
    const rest = source.slice(index);

    // A backslash escape makes the next character literal.
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_~[\]()<>#+\-.!]/.test(rest[1])) {
      text += rest[1];
      index += 2;
      continue;
    }

    let matched = false;
    if (/[`[*_~<$]/.test(rest[0])) {
      for (const pattern of INLINE_PATTERNS) {
        const match = pattern.regex.exec(rest);
        if (!match) continue;
        flush();
        out.push(pattern.build(match));
        index += match[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    text += rest[0];
    index += 1;
  }

  flush();
  return out;
}

// --- blocks ------------------------------------------------------------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): MdNode[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): MdNode[] {
  const nodes: MdNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = fence[2][0];
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = FENCE.exec(lines[index]);
        // Only a fence of the same character and at least the same length closes.
        if (candidate && candidate[2][0] === closer && candidate[2].length >= fence[2].length) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      nodes.push({ type: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      nodes.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])![1]);
        index += 1;
      }
      nodes.push({ type: "blockquote", children: parseBlocks(body) });
      continue;
    }

    // A table needs its divider row to be a table at all.
    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const header = splitRow(line);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      nodes.push({ type: "table", header, rows });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, index);
      nodes.push(list);
      index = next;
      continue;
    }

    // Otherwise a paragraph, running until a blank line or a new block start.
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      body.push(lines[index].trim());
      index += 1;
    }
    if (body.length === 0) {
      // Defensive: never fail to consume a line, or this loop would not end.
      body.push(lines[index].trim());
      index += 1;
    }
    nodes.push({ type: "paragraph", children: parseInline(body.join("\n")) });
  }

  return nodes;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]))
  );
}

function splitRow(line: string): Inline[][] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => parseInline(cell.trim()));
}

/** Consume one list, folding more-indented lines into nested lists. */
function parseList(lines: string[], start: number): [MdNode, number] {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start])!;
  const ordered = !BULLET.test(lines[start]);
  const indent = first[1].length;
  const items: MdNode[][] = [];

  let index = start;
  let current: string[] | null = null;

  const commit = () => {
    if (current) items.push(parseBlocks(current));
    current = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = lines[index + 1];
      if (!next || !(BULLET.test(next) || ORDERED.test(next))) break;
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = ORDERED.exec(line);
    const marker = bullet ?? numbered;

    if (marker && marker[1].length <= indent) {
      // A marker at this level but of the other kind starts a new list.
      if (Boolean(numbered) !== ordered) break;
      commit();
      current = [marker[2]];
      index += 1;
      continue;
    }

    if (!current) break;
    // More-indented content belongs to the item that is open.
    if (marker || line.startsWith(" ".repeat(indent + 1))) {
      current.push(line.slice(indent + (marker ? 0 : 1)));
      index += 1;
      continue;
    }
    // A lazy continuation line of the current item's paragraph.
    current.push(line.trim());
    index += 1;
  }

  commit();
  return [{ type: "list", ordered, items }, index];
}
