/**
 * True end-to-end: a real prompt through the real client to the local model.
 * Exercises prompt -> session/update streaming -> text blocks -> usage.
 */
import { launchAgent } from "../out/test/agentProcess.js";
import { Session } from "../out/test/session.js";

const apiKey = process.argv[2]; // undefined to test the no-key case
const events = {
  onTurn() {}, onTurnDelta() {}, onPending() {}, onModes() {},
  onError(m) { console.error("error:", m); },
};
const session = new Session(events, process.cwd(), "yolo");

const handle = launchAgent(
  {
    command: "npx",
    args: ["@qwen-code/qwen-code@0.22.0", "--acp"],
    cwd: process.cwd(),
    env: apiKey ? { OPENAI_API_KEY: apiKey } : {},
  },
  () => session,
  (c) => process.stderr.write(c),
);

try {
  await handle.agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: {} } });
  const { sessionId } = await handle.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  session.sessionId = sessionId;

  console.log(`prompting (key=${apiKey ? "set" : "UNSET"})...`);
  const res = await handle.agent.prompt({
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly the two characters: OK" }],
  });

  console.log("stopReason:", res.stopReason);
  console.log("usage:", JSON.stringify(res.usage ?? null));
  const text = session.getTurns()
    .flatMap((t) => t.blocks)
    .filter((b) => b.kind === "text")
    .map((b) => b.text).join("").trim();
  console.log("assistant text:", JSON.stringify(text.slice(0, 200)));
  console.log(text ? "PASS: model responded through the client" : "FAIL: no text");
} catch (e) {
  console.error("FAIL:", String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  handle.dispose();
}
