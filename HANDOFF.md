# Rostrum ACP — parity-roadmap handoff

## Goal

Complete genuine feature parity with Multicoder before public release. Do not treat a checklist as proof: validate the behavior with live ACP agents and a live VS Code window before declaring parity.

Multicoder’s documented differentiators are a local server that outlives VS Code, concurrent background sessions, rich session/history UI, PATH onboarding, and polished transcript/diff UX. The first two were blocking architecture work; both now have a real implementation and headless coverage, but neither has been exercised against a live agent in a live window.

## Current baseline

- Package: `rostrum` / Rostrum ACP, currently `0.10.0`.
- Repository: `https://github.com/ryanpavlick/rostrum` (private), branch `main`.
- Production build: `npm run build`.
- Full automated suite: `npm test` — currently green: 20 unit, 7 regression, 9 feature, 16 supervisor, 13 concurrency, 7 provider, and 1 ACP round-trip check.
- Package: `npx vsce package --no-dependencies`.
- `test/mock-agent.py` is Python because an earlier sandbox suppressed Node processes spawned by another Node process. **That constraint no longer holds in the current environment** (verified: Node spawns Node, detached and piped, fine). The Python mock still works and is kept; new supervisor tests use a Node child (`test/echo-agent.mjs`) directly.

## Implemented so far

### Baseline features

- ACP session transcripts, history catalog, `session/load` / `session/resume` fallback, active-session recovery, fork/delete/export.
- Immutable historical edit snapshots, historical VS Code diffs, safe lexical + symlink workspace confinement, multi-root requests where advertised.
- Generic config options, queue/steer, attachments (text/image/audio), elicitation, plans, slash commands, terminal support, rich media/resource blocks.
- Capability-gated stdio/HTTP/SSE MCP configuration; optional auth; agent-specific MCP override.
- Rostrum rename plus `openacp.*` settings migration.

### 0.12 concurrent session runtime — landed

The `parked` agent map is gone; it was replaced, not extended.

- `src/extension/router.ts` — `SessionRouter` implements the ACP `Client` and demultiplexes every client-bound callback (`session/update`, `session/request_permission`, `fs/*`, `terminal/*`, `session/elicit`) to the owning `Session` by `sessionId`. This is what makes several live conversations on one agent process possible; previously one `Session` was the sole `Client` per connection. Unroutable notifications are dropped and logged; an unroutable permission ask is **cancelled, never approved**; unroutable `fs`/`terminal` requests throw.
- `src/extension/agentConnection.ts` — `AgentConnection` owns one agent process, its handshake, negotiated capabilities and its router. `connectionKey()` fingerprints the normalised workspace plus the effective definition (command, args, sorted env, cwd), so an edited agent definition cannot reattach to a process still running the old one.
- `src/extension/managedSession.ts` — `ManagedSession` owns one conversation: ACP session, busy state, abort controller, queue, attachments, pending request, plan, commands, config options, usage, timestamps, and a derived lifecycle (`idle` / `running` / `awaiting-approval` / `error` / `disconnected`).
- `src/extension/chatView.ts` — holds `Map<agentKey, AgentConnection>`, `Map<controllerId, ManagedSession>` and a separate active id. Every event updates its owning controller first and renders only if that controller is active. Background turns are persisted on completion.
- Background permission behavior: an off-screen session that needs the user raises a notification naming the session and the request, with an "Open session" action. It is never answered automatically, and it does not yank the user out of what they are doing.
- `pickSession` lists live conversations with lifecycle icons alongside stored and agent-discovered ones.

### 0.11 persistent server — landed

- `src/manager.ts` — the supervisor now speaks a small control protocol beside `attach`: `ping`, `status`, `logs`, and `stop` (one agent, or the whole supervisor). It captures per-agent stderr in a bounded ring buffer, tracks buffered/dropped byte counts, writes an agent registry into its state file, secures that file 0600 in a 0700 directory, and refuses to start a second supervisor for a state file whose owner still answers `ping`.
- `src/extension/agentProcess.ts` — `managerStatus`, `managerLogs`, `managerStop`, `managerStateFile`. `launchPersistentAgent` self-heals stale state: if the recorded supervisor does not answer, the state file is removed, a fresh supervisor is started, and the attach is retried once before falling back to a direct child process.
- Reattaching to a stream the supervisor had to truncate reports `droppedBytes`, and Rostrum tells the user the transcript has a hole rather than letting them infer it from a gap.
- Commands: `rostrum.supervisorStatus`, `rostrum.showAgentLog`, `rostrum.stopSupervisor`.

## Important current limitations / risks

1. **Nothing here has been validated against a live agent in a live VS Code window.** All of the above is headless. This is the single largest outstanding risk and the reason parity cannot yet be claimed.
2. **Reattach during an in-flight agent-originated request is untested against a real agent.** Specifically: a permission request outstanding when the window detaches. The supervisor buffers the request frame, but no real agent has been driven through it.
3. **Remote extension hosts are unvalidated.** The supervisor is loopback TCP. SSH, WSL, dev containers and Windows all need checking — on a remote host the supervisor runs remotely, which is probably right, but it has not been confirmed.
4. **Lifecycle states are not yet in the sidebar.** They exist on the controller and appear in the session picker, but `trees.ts` and the webview protocol do not carry them yet. `ViewState` still describes only the active conversation.
5. **One pending request per controller.** If an agent raises a second permission request while a first is outstanding, the controller's `pending` field is overwritten and only the newest is rendered. `Session.pendingResolvers` still holds both, so nothing hangs permanently, but the older ask becomes unreachable from the UI. This predates the refactor.
6. **Simultaneous sessions share one agent process.** That is the intended design, but agents that serialise work per process (rather than per session) will interleave turns poorly. Worth measuring per agent in the compatibility matrix.

## Remaining parity roadmap

1. **0.13 Session/history UX** — unified active/past list; lifecycle status colors in the tree; time-period filters; agent sync; load/continue/fork/delete; JSON + Markdown export. Start by carrying `liveSessions()` through `ViewState` and into `trees.ts`.
2. **0.14 Onboarding** — PATH detection for common agents (Claude, Codex, Copilot, Gemini at minimum), schema validation, actionable configuration failures, per-agent auth/settings UX.
3. **0.15 Transcript UX** — safe syntax-highlighted Markdown, Mermaid diagrams, KaTeX math, better tool rows/output, accessibility and keyboard navigation.
4. **0.16 Change/workspace UX** — folder/flat changes switch, timeline filters, richer usage metrics (duration/tool calls), robust native diffs.
5. **0.17–0.18 verification/release** — compatibility matrix across target agents and local/SSH/WSL/container workspaces; live VS Code UI smoke tests; reconnect chaos tests; packaging/signing/publishing materials.

## Files to start with

- `src/extension/chatView.ts` — connection pool, controller pool, active id, and all view plumbing.
- `src/extension/managedSession.ts`, `agentConnection.ts`, `router.ts` — the concurrent-session runtime.
- `src/manager.ts` — detached supervisor and its control protocol.
- `src/extension/agentProcess.ts` — direct launch, supervisor attach, and supervisor control client.
- `src/extension/session.ts` — ACP event translation, permissions, filesystem guard, terminals, blocks.
- `src/extension/store.ts`, `history.ts`, `trees.ts` — persistence/sidebar views.
- `src/shared/protocol.ts`, `src/webview/main.ts`, `src/webview/style.css` — host/webview contract and UI.
- `test/` — headless coverage. Expand it as each behavior lands.

## Testing notes

- `test/provider.mjs` drives the real `ChatViewProvider` headlessly. It works because `build:test` aliases `vscode` to `test/stubs/vscode.ts`, and because `ChatViewProvider.connect` and `AgentConnection.attach` are seams that accept a scripted agent instead of a process. The stub keeps its state on `globalThis` since esbuild inlines it into each bundle.
- `test/manager.mjs` drives a real supervisor process over its socket with a real Node child agent.
- `test/concurrency.mjs` covers the router, the connection fingerprint and the session lifecycle in isolation.

## Safety and implementation constraints

- Use `apply_patch` for edits; do not reset or discard unrelated user changes.
- Preserve user-authored branding and `rostrum.*` IDs.
- Do not use private ACP SDK internals.
- Do not claim parity from headless tests alone.
- ACP has no native steer method; current steer is intentionally a second prompt on the same session and behavior is agent-dependent.
- All file access must remain workspace-root/symlink safe; do not weaken `Session.resolve`.
- Never auto-answer a permission request on the user's behalf, on screen or off.

## Immediate next action

Run `npm run typecheck` and `npm test` first; both should be green.

Then either:

- **(preferred) validate 0.11/0.12 against a live agent in a live VS Code window** — start two conversations on one agent, prompt both, switch between them, reload the window mid-turn, and confirm the supervisor reattach and the background-approval notification behave as the headless tests claim; or
- **start 0.13** by carrying `ChatViewProvider.liveSessions()` through `ViewState` into the webview and `trees.ts`, so lifecycle state is visible in the sidebar rather than only in the picker.
