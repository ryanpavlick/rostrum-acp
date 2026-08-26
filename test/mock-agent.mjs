/**
 * A minimal ACP agent that reproduces Qwen Code's `ask_user_question` dialect:
 * the question payload rides in `_meta.qwenQuestions`, and the answers are
 * expected back as a top-level `answers` map keyed by question index.
 *
 * Used to verify the client actually renders the question and returns answers,
 * rather than silently approving an empty permission card.
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

let nextId = 1000;
const awaiting = new Map();

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  // A response to something we asked the client.
  if (message.id !== undefined && message.method === undefined) {
    awaiting.get(message.id)?.(message.result);
    awaiting.delete(message.id);
    return;
  }

  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      });
      break;

    case "session/new":
      reply(message.id, { sessionId: "mock-session-1" });
      break;

    case "session/prompt": {
      const sessionId = message.params.sessionId;

      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me check a couple of things.\n" },
        },
      });

      // Announce the tool call, exactly as Qwen does: title only, no rawInput.
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "AskUserQuestion",
          kind: "other",
          status: "in_progress",
          _meta: { toolName: "ask_user_question" },
        },
      });

      const result = await request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "Please answer the following question(s):",
          kind: "other",
          // Note: no `content` — the questions live only in `_meta`.
          _meta: {
            toolName: "ask_user_question",
            qwenInteractionKind: "user_question",
            qwenQuestions: [
              {
                header: "Mount type",
                question: "Which mount style should I design?",
                options: [
                  { label: "Clamp-on", description: "Grips the desk edge, no drilling." },
                  { label: "Bolt-through", description: "Stronger, needs a hole." },
                ],
                multiSelect: false,
              },
              {
                header: "Material",
                question: "Which materials should it target?",
                options: [
                  { label: "PLA", description: "Easy to print." },
                  { label: "PETG", description: "Tougher, more heat resistant." },
                ],
                multiSelect: true,
              },
            ],
          },
        },
        options: [
          { optionId: "proceed_once", name: "Submit", kind: "allow_once" },
          { optionId: "cancel", name: "Cancel", kind: "reject_once" },
        ],
      });

      // Report what actually came back so the harness can assert on it.
      process.stderr.write(`PERMISSION_RESULT:${JSON.stringify(result)}\n`);

      reply(message.id, { stopReason: "end_turn" });
      break;
    }

    case "session/cancel":
      reply(message.id, {});
      break;

    default:
      if (message.id !== undefined) reply(message.id, {});
  }
});
