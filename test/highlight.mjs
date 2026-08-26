/**
 * Syntax highlighter checks.
 *
 * The highlighter runs over untrusted agent output, so the invariant that
 * matters most is that it is lossless: concatenating the tokens must give back
 * exactly the input. A highlighter that drops or duplicates characters would
 * silently corrupt the code a user is about to copy.
 */
import assert from "node:assert/strict";
import { highlight, supportedLanguages } from "../out/test/highlight.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const joined = (tokens) => tokens.map((token) => token.text).join("");
const kindsOf = (tokens, kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);

// --- losslessness ------------------------------------------------------------
const SAMPLES = [
  ["typescript", 'const x: number = 1; // trailing\nlet s = "hi\\"there";'],
  ["python", '# comment\ndef f(a=1):\n    return "text" + str(a)'],
  ["bash", "# comment\nfor f in *.ts; do echo \"$f\"; done"],
  ["json", '{"a": 1, "b": [true, null], "c": "x"}'],
  ["sql", "SELECT * FROM t -- comment\nWHERE a = 'b';"],
  ["rust", 'fn main() { let s: &str = "hi"; /* block */ }'],
  ["go", 'func main() { var s string = "hi" // note\n}'],
  ["yaml", "key: value # comment\nother: 'quoted'"],
  ["css", "/* c */ .a { color: #fff; }"],
  ["unknownlang", "whatever this is"],
  ["", "no language at all"],
];

for (const [lang, source] of SAMPLES) {
  const tokens = highlight(source, lang);
  assert.equal(joined(tokens), source, `${lang} must round-trip exactly`);
}
ok("tokenising is lossless for every supported language");

// Every language in the table must be lossless on awkward input too.
const awkward = [
  'a "unterminated string',
  "b 'unterminated",
  "/* unterminated block",
  "// trailing line comment",
  "x = 0xFF + 1_000 + 1.5e-3",
  "",
  "\n\n",
  "   ",
  "\\",
  '"""',
  "#",
  "--",
].join("\n");
for (const lang of supportedLanguages()) {
  assert.equal(joined(highlight(awkward, lang)), awkward, `${lang} must round-trip awkward input`);
}
ok("awkward and unterminated input round-trips in every language");

// --- classification ----------------------------------------------------------
const ts = highlight('const greeting: string = "hi"; // note', "typescript");
assert.ok(kindsOf(ts, "keyword").includes("const"));
assert.ok(kindsOf(ts, "type").includes("string"));
assert.ok(kindsOf(ts, "string").includes('"hi"'));
assert.ok(kindsOf(ts, "comment").includes("// note"));
ok("keywords, types, strings and comments are classified");

const py = highlight("def f():\n    # note\n    return None", "python");
assert.ok(kindsOf(py, "keyword").includes("def"));
assert.ok(kindsOf(py, "keyword").includes("return"));
assert.ok(kindsOf(py, "type").includes("None"));
assert.ok(kindsOf(py, "comment").includes("# note"));
ok("Python uses its own keywords and comment marker, not the C-like ones");

// A '#' is a comment in Python but not in TypeScript.
assert.equal(kindsOf(highlight("# not a comment", "typescript"), "comment").length, 0);
assert.equal(kindsOf(highlight("// not a comment", "python"), "comment").length, 0);
ok("comment markers are per-language, not global");

// --- string edge cases -------------------------------------------------------
const escaped = highlight('"a\\"b" rest', "typescript");
assert.equal(kindsOf(escaped, "string")[0], '"a\\"b"', "an escaped quote does not end the string");
ok("escaped quotes inside a string are handled");

// A stray quote must not colour the remainder of the block.
const stray = highlight("it's fine\nsecond line\nthird line", "python");
const strayString = kindsOf(stray, "string")[0] ?? "";
assert.ok(!strayString.includes("second line"), "a lone apostrophe must not swallow the file");
ok("a stray quote does not colour the rest of the block");

// Backtick templates in JS legitimately span lines.
const template = highlight("const t = `line one\nline two`;", "typescript");
assert.ok(kindsOf(template, "string").some((s) => s.includes("line two")));
ok("template literals are allowed to span lines");

// --- numbers -----------------------------------------------------------------
const numbers = highlight("0xFF 0b1010 1_000 1.5e-3 42", "typescript");
assert.deepEqual(kindsOf(numbers, "number"), ["0xFF", "0b1010", "1_000", "1.5e-3", "42"]);
ok("hex, binary, separated, exponent and plain numbers are all recognised");

// An identifier containing digits is not a number.
const ident = highlight("value2 = 3", "typescript");
assert.deepEqual(kindsOf(ident, "number"), ["3"]);
ok("digits inside an identifier are not mistaken for a number");

// --- unknown languages -------------------------------------------------------
const unknown = highlight("const x = 1;", "brainfuck");
assert.deepEqual(unknown, [{ kind: "plain", text: "const x = 1;" }]);
ok("an unknown language renders as one plain token rather than failing");

assert.deepEqual(highlight("", "typescript"), [{ kind: "plain", text: "" }]);
ok("empty input is handled");

// --- no markup can escape ----------------------------------------------------
const injected = '<script>alert(1)</script>';
const tokens = highlight(injected, "html");
assert.equal(joined(tokens), injected, "markup in a code block survives verbatim as text");
assert.ok(
  tokens.every((token) => typeof token.text === "string" && typeof token.kind === "string"),
  "tokens are plain data; the renderer is what puts them in the DOM",
);
ok("markup inside a code block stays data, never becomes markup");

console.log(`\nPASS: ${passed} highlight checks`);
