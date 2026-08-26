# Rostrum ACP

One chat UI for every Agent Client Protocol (ACP) coding agent.

Rostrum runs any ACP-compatible coding agent as a local subprocess and talks JSON-RPC over stdio. It is built on the official Apache-2.0 `@agentclientprotocol/sdk`.

## Features

- Streams agent text, reasoning ("thinking") blocks, tool calls with status, and file diffs into a sidebar chat.
- Handles permission requests (allow/deny) with three modes: ask, acceptEdits, yolo.
- Renders structured question prompts from agents that use them, and returns the answers correctly. Specifically supports Qwen Code's `ask_user_question`, whose payload arrives in vendor `_meta` fields.
- Session transcripts persist to disk; the Sessions view merges local transcripts with the agent's cursor-paginated ACP session catalog.
- A Changes view lists files the agent edited.

- Installs agents from the [ACP registry](https://agentclientprotocol.com/get-started/registry): 39 agents, via npx, uvx, or a checksum-verified platform binary.
- Reopens the last active workspace session automatically. Past conversations use `session/load`, then `session/resume`, then a clearly read-only saved-transcript fallback.
- Exports any saved transcript to Markdown from the Sessions view.
- Forks sessions on agents that advertise it.
- Tracks token usage per agent in a Usage Stats view.
- Records a durable per-file edit history: which session and agent last touched each file, surviving reloads.
- Flags sub-agent delegation calls distinctly in the transcript.
- Runs on the remote host in SSH, WSL, and container workspaces (`extensionKind: workspace`), so the agent executes where your code is; multi-root folders are passed to agents that advertise ACP additional-directory support.

The UI only offers what the connected agent advertises: optional ACP methods are capability-gated, so nothing is shown that would fail if clicked.

Also supported: agent-driven session options (model, reasoning effort, and anything else an agent exposes), prompt queueing and mid-turn steering, file/image/audio attachments, rich ACP media and resource output, slash-command completion, agent plan/todo rendering, ACP elicitation, agent-run terminals, MCP servers, and optional agent authentication.

## Layout

The chat panel docks in the **secondary sidebar** (right-hand panel), and the activity bar holds five views: Sessions, Outline, Changes, Timeline, and Usage Stats. Outline lets you jump to any turn or tool call in a long conversation; Timeline is a cross-file chronological log of every agent edit.

## Configuration

Configuration is under the `rostrum.agents` setting: a map of display name to `{ command, args, env, cwd, mcpServers? }`. Agent-specific MCP servers override same-named entries in `rostrum.mcpServers`; global entries apply to every agent. MCP values can be stdio (`{ command, args, env }`) or capability-gated HTTP/SSE (`{ type, url, headers? }`).

```json
{
  "rostrum.agents": {
    "Qwen Code": {
      "command": "npx",
      "args": ["@qwen-code/qwen-code@0.22.0", "--acp"],
      "env": {}
    }
  }
}
```

## Build

```bash
npm install
npm run build
npm test          # unit + question round-trip against a mock agent
npm run test:live # handshake against real Qwen Code (needs a model endpoint)
```

`npm test` uses Python 3 for its stdio ACP mock, so it remains an end-to-end child-process check even in environments that restrict nested Node processes.

## Why

ACP is an open protocol, so agents stay interchangeable. Rostrum gives you one chat UI for any ACP-compatible agent without tying you to a single vendor.

## License

Apache-2.0
