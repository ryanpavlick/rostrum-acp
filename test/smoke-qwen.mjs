/**
 * Smoke test against the real Qwen Code ACP agent: proves the transport and
 * handshake work against a genuine implementation, not just the mock.
 *
 * Requires qwen-code to be resolvable via npx and a local model endpoint.
 */
import { launchAgent } from "../out/test/agentProcess.js";
import { Session } from "../out/test/session.js";
import { readCapabilities } from "../out/test/capabilities.js";

const events = {
  onTurn() {},
  onTurnDelta() {},
  onPending() {},
  onModes() {},
  onError(message) {
    console.error("error:", message);
  },
};

const session = new Session(events, process.cwd(), "ask");

const handle = launchAgent(
  {
    command: "npx",
    args: ["@qwen-code/qwen-code@0.22.0", "--acp"],
    cwd: process.cwd(),
  },
  () => session,
  (chunk) => process.stderr.write(chunk),
);

const timeout = setTimeout(() => {
  console.error("FAIL: timed out");
  handle.dispose();
  process.exit(1);
}, 120000);

try {
  const init = await handle.agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log("initialize ok:", JSON.stringify(init.agentInfo ?? {}));

  const caps = readCapabilities(init.agentCapabilities, handle.agent);
  console.log("capabilities:", JSON.stringify(caps));

  const created = await handle.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log("newSession ok:", created.sessionId);
  console.log(
    "modes:",
    created.modes?.availableModes?.map((m) => m.id).join(", ") ?? "(none)",
  );
  console.log("PASS: real Qwen Code handshake succeeded");
} catch (error) {
  console.error("FAIL:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  handle.dispose();
}
