/** Live check that the real ACP registry parses and resolves on this platform. */
import assert from "node:assert/strict";
import { fetchRegistry, availability, platformKey, toDefinition } from "../out/test/registry.js";

const agents = await fetchRegistry();
assert.ok(agents.length > 0, "registry returned no agents");

const usable = agents.filter((a) => availability(a));
console.log(`registry: ${agents.length} agents, ${usable.length} installable on ${platformKey()}`);

const kinds = {};
for (const a of usable) kinds[availability(a).kind] = (kinds[availability(a).kind] ?? 0) + 1;
console.log("by kind:", kinds);

const qwen = agents.find((a) => a.id === "qwen-code");
assert.ok(qwen, "qwen-code missing from registry");
const def = await toDefinition(qwen, "/tmp/rostrum-unused", () => {});
assert.equal(def.command, "npx");
console.log("qwen resolves to:", def.command, def.args.join(" "));
console.log("PASS: live registry");
