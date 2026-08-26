/**
 * Markdown parser checks.
 *
 * Agent output is untrusted, so the parser's job is twofold: render what
 * agents actually emit, and never produce a node that could become markup or
 * an executable link. The parser returns a tree — the renderer builds DOM
 * nodes and assigns text with textContent — so these checks assert on the
 * tree, which is where a dangerous link would have to appear first.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInline, parseMarkdown, safeHref } from "../out/test/markdown.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const textOf = (inlines) =>
  inlines
    .map((node) =>
      node.type === "text" || node.type === "code" ? node.text : textOf(node.children),
    )
    .join("");

// --- link safety -------------------------------------------------------------
const HOSTILE = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  // Control characters inside a scheme are stripped before the check.
  "java\nscript:alert(1)",
  "java\tscript:alert(1)",
  "jav ascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "//evil.example.com",
];
for (const hostile of HOSTILE) {
  assert.equal(safeHref(hostile), undefined, `must refuse ${JSON.stringify(hostile)}`);
}
ok("executable and scheme-relative link targets are refused");

for (const safe of [
  "https://example.com/a?b=c#d",
  "http://example.com",
  "HTTPS://EXAMPLE.COM",
  "mailto:someone@example.com",
  "./relative/path.md",
  "#anchor",
  "/absolute/path",
]) {
  assert.equal(safeHref(safe), safe.trim(), `must allow ${JSON.stringify(safe)}`);
}
ok("ordinary http, mailto, relative and anchor links are allowed");

// A refused link degrades to visible text, so nothing silently disappears.
const hostileLink = parseInline("see [here](javascript:alert(1)) now");
assert.equal(
  hostileLink.some((node) => node.type === "link"),
  false,
);
assert.match(textOf(hostileLink), /\[here\]\(javascript:alert\(1\)\)/);
ok("a refused link is shown as literal text rather than dropped");

const goodLink = parseInline("see [docs](https://example.com) now");
const link = goodLink.find((node) => node.type === "link");
assert.equal(link.href, "https://example.com");
assert.equal(textOf(link.children), "docs");
ok("a safe link parses to a link node carrying its target");

// --- inline ------------------------------------------------------------------
assert.deepEqual(parseInline("plain"), [{ type: "text", text: "plain" }]);

const emphasis = parseInline("**bold** and *italic* and ~~gone~~ and `code`");
assert.deepEqual(
  emphasis.filter((n) => n.type !== "text").map((n) => n.type),
  ["strong", "em", "strike", "code"],
);
ok("bold, italic, strikethrough and inline code are recognised");

// Inline code is literal: its contents must not be re-parsed as markup.
const literal = parseInline("`**not bold**`");
assert.equal(literal.length, 1);
assert.deepEqual(literal[0], { type: "code", text: "**not bold**" });
ok("inline code content is literal, not re-parsed");

assert.deepEqual(parseInline("a \\* b"), [{ type: "text", text: "a * b" }]);
assert.equal(parseInline("snake_case_word")[0].type, "text");
ok("escapes are honoured and snake_case is not mistaken for emphasis");

// Unclosed markers must not swallow the rest of the message.
for (const unclosed of ["**never closed", "*never closed", "`never closed", "[text](", "~~open"]) {
  const parsed = parseInline(unclosed);
  assert.equal(textOf(parsed), unclosed, `unclosed ${JSON.stringify(unclosed)} stays literal`);
}
ok("unclosed emphasis and code markers stay literal");

// --- blocks ------------------------------------------------------------------
const FENCE = "```";
const doc = parseMarkdown(
  [
    "# Title",
    "",
    "Some **text** here.",
    "",
    "## Sub",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted line",
    "",
    "---",
    "",
    FENCE + "ts",
    "const x: number = 1;",
    FENCE,
  ].join("\n"),
);
assert.deepEqual(
  doc.map((node) => node.type),
  ["heading", "paragraph", "heading", "list", "list", "blockquote", "hr", "code"],
);
assert.equal(doc[0].level, 1);
assert.equal(doc[2].level, 2);
assert.equal(doc[3].ordered, false);
assert.equal(doc[4].ordered, true);
ok("headings, paragraphs, both list kinds, quotes, rules and fences all parse");

const code = doc[7];
assert.equal(code.lang, "ts");
assert.equal(code.text, "const x: number = 1;");
ok("a fenced block keeps its language and its exact contents");

// A fence must not be closed by a shorter one inside it.
const nested = parseMarkdown(
  ["````md", FENCE + "js", "x", FENCE, "````"].join("\n"),
);
assert.equal(nested.length, 1);
assert.equal(nested[0].type, "code");
assert.equal(nested[0].text, [FENCE + "js", "x", FENCE].join("\n"));
ok("a longer fence is not closed by a shorter one inside it");

// An unterminated fence must consume the rest rather than losing it.
const unterminated = parseMarkdown([FENCE, "still code", "and more"].join("\n"));
assert.equal(unterminated.length, 1);
assert.equal(unterminated[0].text, "still code\nand more");
ok("an unterminated fence keeps its content instead of dropping it");

// --- tables ------------------------------------------------------------------
const table = parseMarkdown(
  ["| a | b |", "| --- | ---: |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"),
)[0];
assert.equal(table.type, "table");
assert.deepEqual(table.header.map(textOf), ["a", "b"]);
assert.deepEqual(
  table.rows.map((row) => row.map(textOf)),
  [
    ["1", "2"],
    ["3", "4"],
  ],
);
ok("a table parses into a header and rows");

// A pipe without a divider row is just a paragraph.
assert.equal(parseMarkdown("a | b\nc | d")[0].type, "paragraph");
ok("pipes without a divider row are not mistaken for a table");

// --- lists -------------------------------------------------------------------
const nestedList = parseMarkdown("- outer\n  - inner\n- second")[0];
assert.equal(nestedList.items.length, 2, "the nested item belongs to its parent");
assert.equal(textOf(nestedList.items[0][0].children), "outer");
assert.equal(nestedList.items[0][1].type, "list", "the nested list hangs off the first item");
assert.equal(textOf(nestedList.items[1][0].children), "second");
ok("an indented list nests under its parent item rather than flattening");

const mixed = parseMarkdown("- bullet\n1. number");
assert.deepEqual(
  mixed.map((n) => n.ordered),
  [false, true],
);
ok("switching marker kind starts a new list");

// --- robustness --------------------------------------------------------------
for (const input of ["", "\n\n\n", "   ", "|||", "#", "> ", "- ", FENCE, "*", "]("]) {
  assert.doesNotThrow(() => parseMarkdown(input), `parsing ${JSON.stringify(input)} must not throw`);
}
ok("degenerate input parses without throwing or hanging");

// Inline content must round-trip to exactly its visible text.
const messy = "Mixed *stuff* with `code` and a [link](https://x.test) plus **bold**.";
assert.equal(textOf(parseMarkdown(messy)[0].children), "Mixed stuff with code and a link plus bold.");
ok("inline content round-trips to its visible text");

// --- the invariant the whole design rests on ---------------------------------
// Rendering builds DOM nodes and assigns text with textContent. If any of this
// ever turns agent output into markup text, every check above becomes moot.
{
  const webview = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "webview");
  const files = (await fs.readdir(webview)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "the webview sources must be where this check expects them");

  const offenders = [];
  for (const name of files) {
    const source = await fs.readFile(path.join(webview, name), "utf8");
    for (const [number, line] of source.split("\n").entries()) {
      // Comments may name the hazard; code may not use it.
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(code)) {
        offenders.push(`${name}:${number + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "the webview must never build markup from a string");
  ok("no webview source turns agent output into markup");
}

console.log(`\nPASS: ${passed} markdown checks`);
