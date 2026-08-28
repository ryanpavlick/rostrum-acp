/**
 * A scripted ACP agent that exists to be photographed.
 *
 * Rostrum's README ships concept illustrations because a real screenshot needs
 * a real agent, and a real agent needs credentials, a network, and luck with
 * whatever it decides to say. This one is deterministic: any prompt produces
 * the same turn, exercising every part of the panel worth showing — reasoning,
 * a plan, a tool call with input and output, a file diff, a rendered diagram,
 * maths, and finally a permission request that is left outstanding so the
 * approval card is on screen when the shutter goes.
 *
 * It performs no work and touches nothing on disk. Run it through
 * `npm run demo`, not as an agent you would actually use.
 */
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 9000;
const awaiting = new Map();
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

const update = (sessionId, u) => notify("session/update", { sessionId, update: u });

/** Stream text a few characters at a time, so the shot shows a live turn. */
async function say(sessionId, kind, text, chunk = 24) {
  for (let i = 0; i < text.length; i += chunk) {
    update(sessionId, {
      sessionUpdate: kind,
      content: { type: "text", text: text.slice(i, i + chunk) },
    });
    await sleep(20);
  }
}

const OLD_TEXT = `export function windowTurns(turns, showAll) {
  return turns;
}
`;

const NEW_TEXT = `export function windowTurns(turns, showAll, size = TURN_WINDOW) {
  if (showAll || turns.length <= size) return { shown: turns, hidden: 0 };
  return { shown: turns.slice(turns.length - size), hidden: turns.length - size };
}
`;

async function runTurn(sessionId) {
  await say(
    sessionId,
    "agent_thought_chunk",
    "The transcript rebuilds every turn on each delta. Bounding the window is the smaller change, so I will start there.",
  );

  update(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "Read how the transcript renders today", status: "completed" },
      { content: "Bound the window to the newest turns", status: "in_progress" },
      { content: "Cover the rules with tests", status: "pending" },
    ],
  });

  await say(
    sessionId,
    "agent_message_chunk",
    "Only the newest turns need to exist in the DOM. Here is the shape of it:\n\n",
  );

  await say(
    sessionId,
    "agent_message_chunk",
    "```mermaid\nflowchart LR\n  A[Agent delta] --> B{In window?}\n  B -- yes --> C[Repaint turn]\n  B -- no --> D[Skip]\n  C --> E[Coalesce per frame]\n```\n\n",
    400,
  );

  await say(
    sessionId,
    "agent_message_chunk",
    "Cost per delta falls from $O(n)$ in the whole conversation to $O(1)$ in the window.\n\n",
  );

  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-read",
    title: "Read src/webview/transcript.ts",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "src/webview/transcript.ts", limit: 40 },
  });
  await sleep(240);
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-read",
    status: "completed",
    rawOutput: { lines: 38, bytes: 1204 },
    content: [{ type: "content", content: { type: "text", text: "38 lines read." } }],
  });

  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-edit",
    title: "Edit src/webview/transcript.ts",
    kind: "edit",
    status: "completed",
    locations: [{ path: "src/webview/transcript.ts", line: 24 }],
    content: [
      {
        type: "diff",
        path: "src/webview/transcript.ts",
        oldText: OLD_TEXT,
        newText: NEW_TEXT,
      },
    ],
  });

  await say(
    sessionId,
    "agent_message_chunk",
    "That bounds the DOM. Running the suite next — it wants to write outside the workspace, so it needs your approval.",
  );

  // Left outstanding on purpose: the approval card is the point of the shot.
  await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "call-run",
      title: "Run `npm test` and write ./out/test",
      kind: "execute",
      content: [
        {
          type: "content",
          content: { type: "text", text: "npm test  # 18 suites, writes out/test" },
        },
      ],
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id !== undefined && message.method === undefined) {
    awaiting.get(message.id)?.(message.result);
    awaiting.delete(message.id);
    return;
  }

  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: 1,
        // Advertised so the panel shows the controls that depend on them.
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, fork: {}, resume: {} },
        },
        authMethods: [],
      });
      break;

    case "session/new":
      reply(message.id, {
        sessionId: "demo-session-1",
        modes: {
          currentModeId: "build",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "build", name: "Build" },
          ],
        },
      });
      break;

    case "session/load":
    case "session/resume":
      reply(message.id, {});
      break;

    case "session/list":
      reply(message.id, { sessions: [] });
      break;

    case "session/prompt":
      await runTurn(message.params.sessionId);
      // The turn never ends: the permission request above is still waiting,
      // which is exactly the state worth photographing.
      break;

    case "session/cancel":
      reply(message.id, {});
      break;

    default:
      if (message.id !== undefined) reply(message.id, {});
  }
});
