/**
 * Manifest integrity.
 *
 * The manifest and the code have to agree about things no unit test touches:
 * which commands exist, what a menu points at, which settings are actually
 * read. Drift here is invisible until someone clicks the thing — the delete
 * command contributed to a context menu but written to take an id rather than
 * the tree element it is handed was exactly this shape, and no headless test
 * could see it because the argument only takes its real form when VS Code
 * invokes the menu.
 *
 * These checks are static and cheap. They do not prove a command works; they
 * prove the manifest is not pointing at something that no longer exists, and
 * that anything reachable from a tree row is written to accept a tree row.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const contributes = manifest.contributes;

const sourceOf = (file) => fs.readFileSync(path.join(root, "src", "extension", file), "utf8");
const extensionSource = sourceOf("extension.ts");
const allExtensionSource = fs
  .readdirSync(path.join(root, "src", "extension"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => sourceOf(name))
  .join("\n");

const declaredCommands = contributes.commands.map((entry) => entry.command);

// --- every contributed command is registered --------------------------------
{
  const registered = new Set(
    [...extensionSource.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  const missing = declaredCommands.filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(", ")}`);
  ok("every command in the manifest is registered in the extension");
}

// --- every registered command is contributed --------------------------------
{
  const registered = [...extensionSource.matchAll(/registerCommand\(\s*"(rostrum\.[^"]+)"/g)].map(
    (m) => m[1],
  );
  const undeclared = registered.filter((command) => !declaredCommands.includes(command));
  // A registered command that the manifest never declares cannot be found in
  // the palette, so it exists only for whoever already knows its id.
  assert.deepEqual(undeclared, [], `registered but not contributed: ${undeclared.join(", ")}`);
  ok("every registered command is declared in the manifest");
}

// --- menus and keybindings point at real commands ---------------------------
{
  const referenced = [];
  for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
    for (const item of items) if (item.command) referenced.push([menu, item.command]);
  }
  for (const binding of contributes.keybindings ?? []) referenced.push(["keybindings", binding.command]);

  const dangling = referenced.filter(([, command]) => !declaredCommands.includes(command));
  assert.deepEqual(dangling, [], `menu or keybinding points at a missing command: ${JSON.stringify(dangling)}`);
  ok("every menu entry and keybinding points at a contributed command");
}

// --- anything reachable from a tree row must accept a tree row --------------
{
  // VS Code hands a `view/item/context` command the tree element, never the id
  // a palette invocation passes. A handler that takes only an id compares an
  // object against a string, matches nothing, and returns having done nothing.
  const contextCommands = (contributes.menus?.["view/item/context"] ?? []).map((i) => i.command);
  assert.ok(contextCommands.length > 0, "there are context-menu commands to check");

  const offenders = [];
  for (const command of contextCommands) {
    // Grab the handler body: from its registration to the next registration.
    const start = extensionSource.indexOf(`registerCommand("${command}"`);
    assert.ok(start >= 0, `${command} is not registered`);
    const after = extensionSource.indexOf("registerCommand(", start + 20);
    const body = extensionSource.slice(start, after === -1 ? undefined : after);

    // Either it resolves the node explicitly, or it inspects the argument
    // before using it. A signature typed as a bare string is the bug.
    const tolerant =
      /sessionIdOf\s*\(/.test(body) || /\?\.\w+/.test(body) || /:\s*unknown/.test(body);
    if (!tolerant) offenders.push(command);
  }
  assert.deepEqual(
    offenders,
    [],
    `context-menu command(s) that would be handed a tree node but do not accept one: ${offenders.join(", ")}`,
  );
  ok("every context-menu command accepts the tree element it will be handed");
}

// --- every contributed setting is actually read -----------------------------
{
  const settings = Object.keys(contributes.configuration?.properties ?? {});
  const unread = settings.filter((key) => {
    const short = key.replace(/^rostrum\./, "");
    return !allExtensionSource.includes(`"${short}"`);
  });
  // A setting nobody reads is a promise the manifest makes and the code does
  // not keep.
  assert.deepEqual(unread, [], `contributed but never read: ${unread.join(", ")}`);
  ok("every contributed setting is read somewhere in the extension");
}

// --- views declared in the manifest exist in one container ------------------
{
  // Containers can be contributed to the activity bar, the secondary sidebar
  // or the bottom panel, and a view may live in any of them.
  const containers = Object.values(contributes.viewsContainers ?? {})
    .flat()
    .map((c) => c.id);
  for (const container of Object.keys(contributes.views ?? {})) {
    assert.ok(
      containers.includes(container),
      `views are contributed to ${container}, which is not a declared container`,
    );
  }
  ok("every view is contributed to a container the manifest declares");
}

// --- the packaged extension can actually start ------------------------------
{
  assert.equal(manifest.main, "./out/extension.cjs");
  assert.ok(
    (contributes.commands ?? []).every((c) => typeof c.title === "string" && c.title.length > 0),
    "every command needs a title, or it cannot be found in the palette",
  );
  ok("the entry point and command titles are present");
}

console.log(`\nPASS: ${passed} manifest checks`);
