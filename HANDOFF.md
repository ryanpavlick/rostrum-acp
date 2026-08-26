# Rostrum ACP — parity-roadmap handoff

## Goal

Complete genuine feature parity with Multicoder before public release. Do not treat a checklist as proof: validate the behavior with live ACP agents and a live VS Code window before declaring parity.

Multicoder’s documented differentiators are a local server that outlives VS Code, concurrent background sessions, rich session/history UI, PATH onboarding, and polished transcript/diff UX. The first two were blocking architecture work; both now have a real implementation and headless coverage, but neither has been exercised against a live agent in a live window.

## Current baseline

- Package: `rostrum` / Rostrum ACP, currently `0.18.0`. CHANGELOG records 0.11–0.18 individually.
- Repository: `https://github.com/ryanpavlick/rostrum` (private), branch `main`.
- Production build: `npm run build`.
- Full automated suite: `npm test` — currently green: 24 unit, 7 regression, 9 feature, 16 supervisor, 9 chaos, 13 concurrency, 20 provider, 13 sessions view, 9 store safety, 12 preference, 7 export, 15 discovery, 19 markdown, 13 highlight, 17 workspace view, and 1 ACP round-trip check.
- Compatibility probe (not part of `npm test`, needs real agents): `node test/compat.mjs` — see `docs/compatibility.md`.
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

### 0.13 session/history UX — partly landed

- The Sessions view is a unified two-level list: an "Active" group of live conversations above saved ones bucketed by age. Lifecycle drives icon and colour; a live conversation is never also listed as history. Live rows are addressed by controller id via `rostrum.revealSession`, which also reaches a read-only transcript.
- The chat panel has a session switcher: one chip per live conversation, with status as colour plus tooltip, a pulse for "needs you", and a queue-depth badge. Hidden until there is more than one.
- Export offers Markdown or JSON, chosen by file extension. Transcript serialisation moved to `src/extension/export.ts` (no `vscode` import, so it is directly testable). Markdown fences are now sized longer than any backtick run inside the content, so agent output containing code fences cannot break out of its own block.
- Still to do here: time-period *filters* (the buckets exist, filtering does not), and richer agent-catalog sync UI.

### 0.14 onboarding — mostly landed

- `src/extension/discovery.ts` — PATH detection for ten known agents, `rostrum.detectAgents`, and schema validation for `rostrum.agents`.
- Two agent shapes are distinguished and are not interchangeable: agents that speak ACP directly, and Claude Code / Codex, which do not answer an ACP handshake and must be configured to launch their ACP adapter instead.
- Configuration is validated before launch, with actionable messages (non-array `args`, non-string `env`, missing `command`, a whole shell command line pasted into `command`). A command that is not on PATH is refused with that reason rather than hanging the handshake.
- Still to do here: per-agent auth/settings UX.

### 0.15 transcript UX — partly landed

- `src/webview/markdown.ts` parses a Markdown subset chosen for what agents emit (fenced code, lists, headings, tables, quotes, emphasis, links) and returns a **tree, never markup text**. The renderer in `main.ts` builds every node with `createElement` and fills it with `textContent`. A test asserts no webview source mentions `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` outside a comment, so this cannot quietly regress.
- Link targets are restricted to `http`, `https`, `mailto` and relative URLs. `javascript:`, `data:`, `vbscript:`, `file:` and scheme-relative `//host` are refused; control characters are stripped before the scheme check. A refused link degrades to literal visible text.
- `src/webview/highlight.ts` colours code blocks for about twenty languages with no dependency, returning tokens rather than markup. It is lossless by construction and tested to be — concatenating tokens returns the input exactly, including for unterminated strings and comments — so code a user copies cannot be corrupted. Colours come from the editor's own token colour variables.
- Accessibility: landmarks and labels throughout, a tablist session strip with roving tabindex and arrow navigation, a polite live region that announces busy transitions and errors *on transition only*, accessible names on every status dot, `role="alert"` errors, Escape to cancel, Ctrl/Cmd+Enter to send, explicit button types, and always-visible focus.
- Tool rows: status label, separate highlighted and copyable Input/Output sections, and a failed call opens itself.

**Mermaid and KaTeX are deliberately deferred, not forgotten.** Three reasons, which should be weighed rather than assumed away:
1. The webview CSP is `default-src 'none'` with no `font-src`. KaTeX without its fonts renders badly, so adopting it means widening the CSP and bundling fonts as data URIs.
2. Both are large — KaTeX around 280 KB plus fonts, Mermaid well over 1 MB — against a current webview bundle of roughly 40 KB.
3. Mermaid builds DOM from strings internally and has a history of XSS findings. Feeding it untrusted agent output directly contradicts the invariant the rest of the renderer now guarantees.
   A safer route, if these are wanted: render diagrams and math in an isolated child webview with its own restrictive CSP, or offer "open this diagram in a Mermaid preview" rather than inlining it.

### 0.16 change/workspace UX — landed

Each part's shaping logic lives outside the tree classes so it can be tested directly.

- **Changes view**: a folder/flat toggle (`rostrum.changesAsTree` / `rostrum.changesAsList`, swapped by the `rostrum.changesGrouped` context key). Flat stays the default. `src/extension/changeTree.ts` compacts single-child folder chains, but never folds a folder that holds a file of its own. Paths are shown relative to the containing workspace root, matched on a separator boundary so `/work` cannot swallow `/work-other`; a file edited outside every root keeps its absolute path.
- **Timeline**: `src/extension/timeline.ts` filters by time window, agent and session. Windows are half-open ranges, so "yesterday" is a bounded day rather than everything before today.
- **Usage**: `UsageTotals` gained `durationMs` and `toolCalls`, recorded per turn in `sendPrompt` (tool calls from `Session.toolCallCount()` before/after). Each agent expands into its measures plus an average turn time. Metrics an agent never reports are omitted rather than shown as a misleading zero, and totals written by an earlier version are upgraded field by field so a missing field starts at zero instead of turning later sums into NaN.
- **Diffs**: `src/extension/diffs.ts` serves historical snapshots through a `rostrum-diff:` virtual document scheme. Read-only, never prompts to save, and syntax-highlighted from the filename in the URI even when the original file is gone. Both sides are named in the title; a created file says so rather than showing an empty left pane. `rostrum.compareWithCurrent` diffs the agent's version against what is on disk now.

### 0.17 verification — partly landed

- `test/chaos.mjs` attacks the reconnect promise: twenty detach/reattach cycles mid-stream, two windows racing for one agent, agents side by side, the agent exiting under its client, the supervisor SIGKILLed, and five simultaneous attaches for one key. **It found two real supervisor bugs**, both now fixed:
  1. Concurrent `writeState()` calls shared one temp filename; the loser's `rename` failed with ENOENT, and because those writes are fire-and-forget it surfaced as an unhandled rejection that killed the whole supervisor and every agent with it. State writes are now serialised, use unique temp names, and cannot reject; the supervisor also no longer exits on an unexpected rejection anywhere.
  2. When an agent exited, the client socket was left open. A persistent handle resolves `exited` on socket close, so the extension never learned the agent had died and its sessions would have stayed "running" forever. The client is now ended on the child's `close` event, after stdio drains, so final frames still arrive.
- `test/compat.mjs` is the compatibility-matrix harness: it runs one or more real agents through initialize, `session/new`, an optional live prompt, cancel, and each advertised optional method, and prints a Markdown matrix. Every probe is bounded and independent, so a method that hangs is recorded rather than stopping the run. It records permission requests and **never answers them** — approving a tool call would run real work unasked — and reports a stalled turn as "needs approval" rather than a bare timeout.
- `docs/compatibility.md` holds the running instructions and the by-hand checklist. **The matrix itself is empty**: it needs a machine with the agents installed and authenticated.

### Review fixes — landed

A review against MultiCoder's documented feature set found eight things. Seven were actionable and are fixed; the eighth is the live-validation gap already recorded below.

1. **Session ids reached the filesystem.** Ids come from the agent and were used directly as path components, so `../../evil` wrote and deleted outside the store. Transcripts are now named by SHA-256 of the id, with the real id inside the file; legacy files are still found by scanning. Covered by `test/store-safety.mjs`.
2. **Only one pending request was reachable.** The view held a single request while the protocol session held a map. Each new ask overwrote the last, leaving the earlier one unanswerable and the agent blocked on a promise nothing could resolve. Requests are now a per-session queue, oldest shown first, with a count of what is waiting.
3. **Reload restored one conversation.** Now the whole set is recorded and reopened through the agent's own `session/load`/`resume`, with the previously visible one restored to screen. Capped at eight and sequential.
4. **Sessions view had no filters.** It now takes the Timeline's time-window and agent filters; the on-screen conversation is always exempt.
5. **Preferences were not per agent.** `src/extension/preferences.ts` remembers config options and permission mode per agent and restores them, sending only values that actually differ.
6. **Diffs were per-edit only.** Clicking a changed file now shows the net diff across every edit, with `rostrum.nextEdit` / `rostrum.previousEdit` (alt+right / alt+left) stepping through them.
7. **Authentication sat outside the chat flow.** A failed first session on an agent advertising auth methods now offers them in the panel with the agent's own error text. The opt-in startup prompt remains, unchanged.

Also fixed while testing these: several optional agent methods were pulled off the connection into a local before being called, which loses the receiver on any agent whose methods live on a prototype.

## Important current limitations / risks

1. **Nothing here has been validated against a live agent in a live VS Code window.** All of the above is headless. This is the single largest outstanding risk and the reason parity cannot yet be claimed.
2. **Reattach during an in-flight agent-originated request is untested against a real agent.** Specifically: a permission request outstanding when the window detaches. The supervisor buffers the request frame, but no real agent has been driven through it.
3. **Remote extension hosts are unvalidated.** The supervisor is loopback TCP. SSH, WSL, dev containers and Windows all need checking — on a remote host the supervisor runs remotely, which is probably right, but it has not been confirmed.
6. **Simultaneous sessions share one agent process.** That is the intended design, but agents that serialise work per process (rather than per session) will interleave turns poorly. Worth measuring per agent in the compatibility matrix.

## Remaining parity roadmap

1. **0.17–0.18 verification/release** — fill in `docs/compatibility.md` against real agents; work the by-hand checklist in a live VS Code window; validate SSH/WSL/container/Windows; packaging/signing/publishing materials. Reconnect chaos tests are done.

### 0.18 release materials — partly landed

- Version bumped to 0.17.0 with a CHANGELOG entry per roadmap milestone.
- `.github/workflows/ci.yml` runs typecheck, tests, build and packaging on Linux, macOS and Windows against Node 20 and 22. The supervisor is loopback TCP and spawns detached processes, so proving it on every claimed platform matters more here than usual. Two portability fixes were needed for this: the test clean is now a Node call rather than `rm -rf`, and the state-file permission assertion is skipped on Windows, which has no POSIX mode bits.
- Still to do: a 128×128 PNG `icon` and `galleryBanner` for the Marketplace listing (`resources/sidebar.svg` is the activity-bar icon, not a Marketplace icon), publisher verification, and signing.

### Packaging notes

`npx vsce package --no-dependencies` produces a 2.4 MB vsix, of which 2.4 MB is the two README images in `docs/images/`. They render in the in-editor extension pane, but relative image paths do not render on the Marketplace, so before publishing either host them absolutely or compress them. `HANDOFF.md` and `test/**` are excluded from the package.

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

## Where this stands

Every roadmap section from 0.11 through 0.18 now has an implementation and headless coverage: 165 automated checks across 14 suites, green, plus typecheck, build and packaging. Cross-platform CI runs all of it on Linux, macOS and Windows.

**What none of it has is a single run against a real agent in a real VS Code window.** That is the whole of what remains, and it cannot be faked from here. Until it is done, parity is claimed by construction and by test, not demonstrated — which the goal statement above explicitly rules out.

## Immediate next action

Run `npm run typecheck` and `npm test` first; both should be green.

Then either:

- **(preferred) validate 0.11–0.14 against live agents in a live VS Code window.** Everything below is headless. Run `rostrum.detectAgents` on a machine with a real agent installed, start two conversations on one agent, prompt both, switch between them, reload the window mid-turn, and confirm the supervisor reattach, the session switcher and the background-approval notification behave as the headless tests claim; or
- **fill in the compatibility matrix.** Every roadmap section through 0.16 now has an implementation and headless coverage, and 0.17's harness is built; what none of it has is a single run against a real agent. Run `rostrum.detectAgents` in VS Code, copy the resulting `rostrum.agents` into an `agents.json`, then `node test/compat.mjs --agents ./agents.json --prompt >> docs/compatibility.md`, and work down the by-hand checklist in that file.

Optional remainders, neither blocking: Mermaid/KaTeX (see the trade-offs above), and time-period *filters* in the Sessions view (the buckets exist, filtering does not).
