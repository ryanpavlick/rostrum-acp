/**
 * Agent discovery and configuration-validation checks.
 *
 * Onboarding fails in two ways that both look like "nothing happened": the
 * agent isn't installed, or it is installed but configured in a way that can
 * never launch. Both need to be caught before a handshake hangs.
 */
import assert from "node:assert/strict";
import {
  KNOWN_AGENTS,
  checkCommandExists,
  definitionFor,
  detectAgents,
  findOnPath,
  validateAgentDefinition,
} from "../out/test/discovery.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

/** A fake PATH, so these checks do not depend on what the machine has. */
function probe(files, { platform = "linux", pathVar, pathExt } = {}) {
  const present = new Set(files);
  return {
    platform,
    pathVar: pathVar ?? (platform === "win32" ? "C:\\bin;C:\\tools" : "/usr/bin:/usr/local/bin"),
    pathExt,
    async isExecutable(candidate) {
      return present.has(candidate);
    },
  };
}

// --- PATH resolution ---------------------------------------------------------
assert.equal(await findOnPath("gemini", probe(["/usr/local/bin/gemini"])), "/usr/local/bin/gemini");
assert.equal(await findOnPath("missing", probe(["/usr/local/bin/gemini"])), undefined);
ok("a bare command is resolved against PATH");

assert.equal(
  await findOnPath("gemini", probe(["/usr/bin/gemini", "/usr/local/bin/gemini"])),
  "/usr/bin/gemini",
  "the first PATH entry wins, as it would when the shell resolves it",
);
ok("PATH order decides which copy is used");

// Windows: the extensionless name is not what gets spawned.
const windows = probe(["C:\\bin\\gemini.CMD"], { platform: "win32", pathExt: ".COM;.EXE;.BAT;.CMD" });
assert.equal(await findOnPath("gemini", windows), "C:\\bin\\gemini.CMD");
ok("Windows resolution honours PATHEXT rather than the bare name");

assert.equal(await findOnPath("gemini", probe([], { pathVar: undefined })), undefined);
ok("an absent PATH is handled rather than throwing");

// --- detection ---------------------------------------------------------------
const detected = await detectAgents(
  probe(["/usr/bin/gemini", "/usr/bin/claude", "/usr/bin/copilot"]),
);
assert.deepEqual(detected.map((entry) => entry.profile.name).sort(), [
  "Claude Code",
  "Gemini CLI",
  "GitHub Copilot",
]);
ok("installed agents are detected and uninstalled ones are not");

const gemini = detected.find((entry) => entry.profile.id === "gemini");
assert.deepEqual(gemini.definition, { command: "/usr/bin/gemini", args: ["--acp"] });
ok("an agent that speaks ACP itself is configured to run directly");

// Claude and Codex do not answer an ACP handshake; the adapter does.
const claude = detected.find((entry) => entry.profile.id === "claude-acp");
assert.equal(claude.resolved, "/usr/bin/claude", "the CLI is what was found");
assert.deepEqual(claude.definition, {
  command: "npx",
  args: ["-y", "@agentclientprotocol/claude-agent-acp"],
});
ok("an agent needing an ACP adapter is configured to launch the adapter, not the CLI");

assert.deepEqual(await detectAgents(probe([])), []);
ok("a machine with nothing installed detects nothing");

// Every profile must produce a launchable definition.
for (const profile of KNOWN_AGENTS) {
  const definition = definitionFor(profile, "/usr/bin/x");
  assert.ok(definition.command, `${profile.name} yields a command`);
  assert.ok(Array.isArray(definition.args), `${profile.name} yields args`);
  assert.equal(
    validateAgentDefinition(profile.name, definition).filter((p) => p.severity === "error").length,
    0,
    `${profile.name}'s generated definition must itself be valid`,
  );
}
ok("every known agent profile generates a valid definition");

// --- validation --------------------------------------------------------------
const errorsOf = (key, value) =>
  validateAgentDefinition(key, value).filter((p) => p.severity === "error").map((p) => p.message);

assert.deepEqual(errorsOf("qwen", { command: "qwen", args: ["--acp"] }), []);
ok("a well-formed definition reports no problems");

assert.equal(errorsOf("qwen", {}).length, 1);
assert.match(errorsOf("qwen", {})[0], /has no "command"/);
assert.equal(errorsOf("qwen", { command: "   " }).length, 1);
assert.equal(errorsOf("qwen", "npx qwen").length, 1);
assert.equal(errorsOf("qwen", null).length, 1);
assert.equal(errorsOf("qwen", ["npx"]).length, 1);
ok("a missing or non-object definition is reported, not left to fail at spawn");

assert.match(errorsOf("qwen", { command: "qwen", args: "--acp" })[0], /must be an array/);
assert.match(errorsOf("qwen", { command: "qwen", args: [1] })[0], /only strings/);
assert.match(errorsOf("qwen", { command: "qwen", env: ["A=1"] })[0], /must be an object/);
assert.match(errorsOf("qwen", { command: "qwen", env: { A: 1 } })[0], /must all be strings/);
assert.match(errorsOf("qwen", { command: "qwen", cwd: 5 })[0], /must be a string path/);
ok("malformed args, env and cwd are each reported specifically");

// The single most common mistake: pasting a shell command line.
const shellish = validateAgentDefinition("qwen", { command: "npx qwen-code --acp" });
assert.equal(shellish.filter((p) => p.severity === "error").length, 0);
assert.equal(shellish.length, 1);
assert.equal(shellish[0].severity, "warning");
assert.match(shellish[0].message, /does not use a shell/);
ok("a whole command line pasted into command is flagged with what to do about it");

assert.equal(
  validateAgentDefinition("qwen", { command: "/opt/my agent/bin/qwen", args: ["--acp"] }).length,
  0,
  "a real path containing a space is not a mistake",
);
ok("a path with a space is not mistaken for a shell command line");

// --- existence ---------------------------------------------------------------
const installed = probe(["/usr/bin/qwen"]);
assert.equal(await checkCommandExists({ command: "qwen" }, installed), undefined);
assert.equal(await checkCommandExists({ command: "/usr/bin/qwen" }, installed), undefined);

const missingOnPath = await checkCommandExists({ command: "nope" }, installed);
assert.equal(missingOnPath.severity, "error");
assert.match(missingOnPath.message, /not found on PATH/);

const missingAbsolute = await checkCommandExists({ command: "/opt/gone/qwen" }, installed);
assert.match(missingAbsolute.message, /does not exist or is not executable/);
ok("a command that is not installed is reported before the handshake can hang");

console.log(`\nPASS: ${passed} discovery checks`);
