/**
 * Transcript export checks.
 *
 * An export is the one artefact that leaves the extension, so it has to hold
 * every block kind and survive agent output that contains Markdown of its own.
 */
import assert from "node:assert/strict";
import {
  formatForPath,
  serializeTranscript,
  transcriptJson,
  transcriptMarkdown,
} from "../out/test/export.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const session = {
  sessionId: "s-1",
  agentKey: "qwen",
  title: "Fix the parser",
  updatedAt: 1_700_000_000_000,
  turns: [
    { id: "t1", role: "user", blocks: [{ kind: "text", text: "Fix the parser" }] },
    {
      id: "t2",
      role: "assistant",
      blocks: [
        { kind: "reasoning", text: "The tokenizer drops escapes." },
        { kind: "text", text: "Here is the fix." },
        {
          kind: "tool",
          call: { id: "c1", title: "Edit file", kind: "edit", status: "completed", output: "1 file changed" },
        },
        { kind: "diff", path: "src/parse.ts", oldText: "old line", newText: "new line" },
        { kind: "image", mimeType: "image/png", data: "aGk=" },
        { kind: "audio", mimeType: "audio/wav", data: "aGk=" },
        { kind: "resource", label: "notes.md", uri: "file:///notes.md", text: "some notes" },
      ],
    },
  ],
};

// --- format selection --------------------------------------------------------
assert.equal(formatForPath("/tmp/a.json"), "json");
assert.equal(formatForPath("/tmp/a.JSON"), "json");
assert.equal(formatForPath("/tmp/a.md"), "markdown");
assert.equal(formatForPath("/tmp/no-extension"), "markdown");
ok("the chosen file extension picks the export format");

// --- markdown ----------------------------------------------------------------
const markdown = transcriptMarkdown(session.title, session.turns);
assert.match(markdown, /^# Fix the parser/);
assert.match(markdown, /## You/);
assert.match(markdown, /## Agent/);
for (const expected of [
  "The tokenizer drops escapes.",
  "Here is the fix.",
  "Edit file",
  "src/parse.ts",
  "image/png",
  "audio/wav",
  "[notes.md](file:///notes.md)",
  "some notes",
]) {
  assert.ok(markdown.includes(expected), `markdown export retains ${JSON.stringify(expected)}`);
}
ok("the Markdown export keeps every block kind, including media and resources");

assert.match(markdown, /- old line/);
assert.match(markdown, /\+ new line/);
ok("diffs export as diff hunks");

// --- fencing -----------------------------------------------------------------
const nested = transcriptMarkdown("Nested", [
  {
    id: "t",
    role: "assistant",
    blocks: [
      {
        kind: "tool",
        call: {
          id: "c",
          title: "Run",
          kind: "execute",
          status: "completed",
          // Agent output routinely contains fenced code of its own.
          output: "```js\nconsole.log('hi');\n```",
        },
      },
    ],
  },
]);
const fenceLine = nested.split("\n").find((line) => /^`{4,}$/.test(line));
assert.ok(fenceLine, "a block containing a fence must be wrapped in a longer one");
assert.ok(
  nested.indexOf(fenceLine) < nested.indexOf("```js"),
  "the outer fence opens before the inner one",
);
assert.equal(
  nested.split("\n").filter((line) => line === fenceLine).length,
  2,
  "the outer fence opens and closes exactly once",
);
ok("agent output containing a code fence cannot break out of its own block");

// --- multi-line diff ---------------------------------------------------------
const multi = transcriptMarkdown("Multi", [
  {
    id: "t",
    role: "assistant",
    blocks: [{ kind: "diff", path: "a.ts", oldText: "one\ntwo", newText: "three\nfour" }],
  },
]);
for (const expected of ["- one", "- two", "+ three", "+ four"]) {
  assert.ok(multi.includes(expected), `every diff line is marked: ${expected}`);
}
ok("every line of a multi-line diff is marked, not just the first");

// --- json --------------------------------------------------------------------
const parsed = JSON.parse(transcriptJson(session));
assert.equal(parsed.version, 1);
assert.equal(parsed.sessionId, "s-1");
assert.equal(parsed.agentKey, "qwen");
assert.equal(parsed.title, "Fix the parser");
assert.equal(parsed.updatedAt, session.updatedAt);
assert.deepEqual(parsed.turns, session.turns, "the JSON export round-trips the transcript exactly");
assert.ok(Date.parse(parsed.exportedAt) > 0);
ok("the JSON export is complete and round-trips");

assert.equal(
  JSON.parse(serializeTranscript(session, "json")).sessionId,
  "s-1",
);
assert.equal(serializeTranscript(session, "markdown"), markdown);
ok("serializeTranscript dispatches on the requested format");

console.log(`\nPASS: ${passed} export checks`);
