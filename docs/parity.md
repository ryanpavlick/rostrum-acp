# Parity with MultiCoder

Assessed against what the [MultiCoder marketplace listing](https://marketplace.visualstudio.com/items?itemName=multicoder.multicoder)
actually documents, quoted where possible — not against a summary of it.

**Verdict: feature-complete on paper, parity not yet demonstrated.** Every
documented MultiCoder capability now has an implementation and headless
coverage. None of it has been run against a real ACP agent or in a remote
workspace, and the goal statement in `HANDOFF.md` explicitly rules out
claiming parity on that basis. The gap is verification, not features.

## Matrix

| MultiCoder documents | Rostrum | State |
| --- | --- | --- |
| "One UI, full VS Code integration for Claude Code, Codex, Copilot, OpenCode, Qwen, Pi, Hermes" | Any ACP agent; adapter-backed agents distinguished from native ones | Built, unverified live |
| "1-click install for 35+ agents from the ACP registry" | `rostrum.installAgent`, checksum-verified; registry currently lists 39 | Built; registry fetch verified |
| "Sessions survive window reloads and workspace switches — agents keep working" | Every saved live session is restored sequentially via the agent's own `session/load`/`resume`; state is per-workspace, so a workspace switch keeps its own set | Built, tested headlessly |
| "a small local server that outlives the VS Code window" | Detached supervisor with `status`/`logs`/`stop`/`ping`, bounded buffers, agent registry, singleton guard, stale-state self-healing | Built, integration + chaos tested |
| "By default it picks a free port; set `port` in settings.json to pin one" | `rostrum.supervisorPort`; a pinned port already in use fails with that reason | Built, tested |
| "all your agent sessions in one place — CLI history included" | Agent-side sessions synced through `session/list` into the catalog | **Partial** — only for agents that advertise `session/list`; unverified |
| "Running and finished sessions in one list, with time filters" | Sessions view: Active group above age buckets, with time-window and agent filters | Built, tested |
| "Model, thinking level, and permission mode selectors sit under the input. Choices persist per agent" | Option bar under the composer, permission selector always present, choices stored per agent and re-applied | Built, tested |
| "outline, reasoning blocks, tool calls (collapsed until you open them), subagent runs" | Outline view, reasoning blocks, collapsible tool cards, sub-agent inference from tool name | Built |
| "changed files with aggregated and per-change diffs" | Net diff across all edits on click, per-edit diffs, and step navigation between them | Built, tested |
| "per-file change history — which session last touched it" | Changes view expands each file into its edits, each naming its session and agent | Built |
| "Tool calls wait for your approval — allow or reject inline" | Inline approval, queued so concurrent asks are all reachable | Built, tested |
| "When an agent needs credentials, the chat panel shows that agent's options — subscription login or API key" | A failed first session offers the agent's advertised auth methods in the panel | Built, unverified live |
| "works in remote workspaces (SSH, WSL, containers)" | Should work — the extension host runs remotely, so the supervisor does too | **Unverified** |
| "schema-validated" settings | Agent definitions validated before launch with actionable messages | Built, tested |

## Where Rostrum goes further

Not claimed by MultiCoder's listing: MCP servers over stdio, HTTP and SSE;
terminal tool calls with output capping; `session/elicit`; agent plans; slash
commands; image, audio and embedded-resource attachments; session forking;
JSON as well as Markdown export; usage accounting including turn duration and
tool-call counts; a session switcher in the panel; and a keyboard-navigable,
screen-reader-legible transcript.

## What would actually settle this

Nothing in the matrix above is worth trusting until these are done. They need
a machine with agents installed and authenticated:

- [ ] Fill in `docs/compatibility.md` with `node test/compat.mjs --agents ./agents.json --prompt`.
- [ ] Two conversations on one agent, both prompted, switched between mid-turn.
- [ ] Window reload during a running turn, then supervisor reattach.
- [ ] A background permission request: notification, then answering after opening.
- [ ] An agent that actually requires authentication, through the panel flow.
- [ ] Terminal tool calls, and output capping.
- [ ] Attachments: image, audio, embedded text resource.
- [ ] MCP servers over each of stdio, HTTP and SSE.
- [ ] SSH, WSL and dev container workspaces — the supervisor is loopback TCP
      and has never run in any of them.
- [ ] Windows: PATHEXT agent discovery and supervisor startup.
