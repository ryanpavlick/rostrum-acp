# Rostrum ACP — parity-roadmap handoff

## Goal

Complete genuine feature parity with Multicoder before public release. Do not treat a checklist as proof: validate the behavior with live ACP agents and a live VS Code window before declaring parity.

Multicoder’s documented differentiators are a local server that outlives VS Code, concurrent background sessions, rich session/history UI, PATH onboarding, and polished transcript/diff UX. The first two are blocking architecture work.

## Current baseline

- Package: `rostrum` / Rostrum ACP, currently `0.10.0`.
- Production build: `npm run build`.
- Full automated suite: `npm test` (currently green: 20 unit, 7 regression, 9 feature, and 1 ACP round-trip check).
- Package: `npx vsce package --no-dependencies`.
- The test ACP child is Python (`test/mock-agent.py`) because this sandbox suppresses Node processes spawned by another Node process. This is a test-environment constraint, not an extension limitation.

## Implemented so far

- ACP session transcripts, history catalog, `session/load` / `session/resume` fallback, active-session recovery, fork/delete/export.
- Immutable historical edit snapshots, historical VS Code diffs, safe lexical + symlink workspace confinement, multi-root requests where advertised.
- Generic config options, queue/steer, attachments (text/image/audio), elicitation, plans, slash commands, terminal support, rich media/resource blocks.
- Capability-gated stdio/HTTP/SSE MCP configuration; optional auth; agent-specific MCP override.
- Rostrum rename plus `openacp.*` settings migration.
- A first persistent-manager implementation:
  - `src/manager.ts` is bundled as `out/agent-manager.cjs`.
  - It owns ACP agent stdio on loopback TCP, authenticates attachments with a random token, buffers unattended output up to 1 MiB, and caches the initialize response.
  - `src/extension/agentProcess.ts` exposes `launchPersistentAgent`.
  - `ChatViewProvider.startAgent` uses it and falls back to direct launch if the manager cannot start.
- A first parked-agent pool in `ChatViewProvider`: switching agents retains their connections instead of disposing them; inactive session events no longer render into the active chat.

## Important current limitations / risks

### Persistent manager is incomplete

It is only a foundation, not yet parity-complete.

1. It has no command/UI for status or clean shutdown.
2. It does not expose supervisor stderr/log history to Rostrum.
3. It does not persist a robust agent/session registry, only a state file containing port/token.
4. Reattach needs real-agent validation, especially during in-flight agent-originated requests such as permissions.
5. It uses TCP loopback; validate remote SSH/WSL/container extension hosts and Windows.
6. The manager key is currently `${agentKey}:${workspaceRoot}`; replace it with a stable hash of normalized workspace and effective agent definition.

### Parallel sessions are incomplete

`ChatViewProvider` is still fundamentally built around mutable active fields. `parked` preserves old connections but is only an interim layer.

Required refactor:

- Introduce a first-class `ManagedSession` / `SessionController` with independent agent, handle, ACP `Session`, busy state, abort controller, queue, pending request, plan, usage, config options, timestamps, and lifecycle state.
- Keep a `Map<sessionId, ManagedSession>` and a separate active-session ID.
- Make all events update their owning controller, then render only if it is active.
- Persist background completions (`persistSession` was just introduced for this; finish checking callers).
- Support multiple simultaneous sessions on the same agent server, not merely multiple parked agents.
- Implement background permission behavior: inactive sessions must either surface a notification and activate on click, or follow a documented safe default. Never silently auto-approve a prompt that needs user input.
- Add session lifecycle states: running, idle, awaiting approval, disconnected/error, unloaded/archive. Show them in the tree and picker.

### Remaining parity roadmap

1. **0.11 Persistent server**
   - Finish supervisor lifecycle/status/stop command and secure state storage.
   - Add reconnect/manager integration tests and bounded-buffer tests.
2. **0.12 Concurrent session runtime**
   - Complete the controller/pool refactor above.
   - Verify a prompt continues while user switches to another agent/session.
3. **0.13 Session/history UX**
   - Unified active/past list; status colors; time-period filters; agent sync; load/continue/fork/delete; JSON + Markdown export.
4. **0.14 Onboarding**
   - PATH detection for common agents (Claude, Codex, Copilot, Gemini at minimum), schema validation, actionable configuration failures, per-agent auth/settings UX.
5. **0.15 Transcript UX**
   - Safe syntax-highlighted Markdown, Mermaid diagrams, KaTeX math, better tool rows/output, accessibility and keyboard navigation.
6. **0.16 Change/workspace UX**
   - Folder/flat changes switch, timeline filters, richer usage metrics (duration/tool calls), robust native diffs.
7. **0.17–0.18 verification/release**
   - Compatibility matrix across target agents and local/SSH/WSL/container workspaces.
   - Live VS Code UI smoke tests, reconnect chaos tests, packaging/signing/publishing materials.

## Files to start with

- `src/extension/chatView.ts` — current single-session UI state plus interim `parked` map; primary refactor target.
- `src/manager.ts` — detached raw ACP relay.
- `src/extension/agentProcess.ts` — direct and persistent launch adapters.
- `src/extension/session.ts` — ACP event translation, permissions, filesystem guard, terminals, blocks.
- `src/extension/store.ts`, `history.ts`, `trees.ts` — persistence/sidebar views.
- `src/shared/protocol.ts`, `src/webview/main.ts`, `src/webview/style.css` — host/webview contract and UI.
- `test/` — headless coverage. Expand it as each behavior lands.

## Safety and implementation constraints

- Use `apply_patch` for edits; do not reset or discard unrelated user changes.
- Preserve user-authored branding and `rostrum.*` IDs.
- Do not use private ACP SDK internals.
- Do not claim parity from headless tests alone.
- ACP has no native steer method; current steer is intentionally a second prompt on the same session and behavior is agent-dependent.
- All file access must remain workspace-root/symlink safe; do not weaken `Session.resolve`.

## Immediate next action

Run `npm run typecheck` first. Then complete the `ManagedSession` extraction before adding UI features: the existing parked-agent layer should be replaced, not expanded indefinitely.
