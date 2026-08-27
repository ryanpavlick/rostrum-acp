# Changelog

## 0.19.0

First pre-release published to the VS Code Marketplace. Mostly packaging and
listing work, plus beta support/reset polish.

- Published as a pre-release under the `ryanpavlick` publisher.
- Repository moved to `ryanpavlick/rostrum-acp`; every stale link updated.
- Declared virtual workspaces unsupported, matching the existing untrusted-workspace
  declaration: agents run as local processes and edit files on disk.
- Dropped the inaccurate `Programming Languages` category; the extension
  contributes no languages.
- Trimmed the VSIX from 4.15 MB to under 1 MB by excluding the unreferenced
  Marketplace icon and the documentation images, which are now hosted rather than
  packaged.
- Rewrote the Marketplace description to lead with concurrent background sessions
  and approval gating.
- Added a support policy and **Rostrum: Clear Local Data** for beta users who
  need to stop background agents and reset local Rostrum history/state without
  changing their VS Code settings.
- Added editor-aware context: attach the active file, current selection,
  diagnostics, open editors, workspace layout, `@`-mentioned files, or pasted
  images to the next prompt.
- Background sessions now notify when an off-screen turn finishes, with an
  action to open that session.
- Expanded **Rostrum: Show Agent Diagnostics** into a capability report with
  protocol version, session capabilities, prompt content, MCP transports, and
  detected agent methods.

## 0.18.0

Review fixes, several of them correctness rather than polish.

- A tool-call update arriving after the next turn had begun overwrote an unrelated block in that newer turn, and never updated the real card. Tool cards now record their turn.
- A session whose agent had exited reported itself idle again as soon as it stopped being busy.
- An interrupted session restore permanently forgot the conversations it had not reached.
- Discarding a session while it held a prompt hung whatever was waiting on the answer.
- Deleting a session asked whichever agent was on screen rather than the one that owns it.
- Model, thinking and permission selectors now sit under the input, with the permission selector always present; the supervisor port can be pinned with `rostrum.supervisorPort`.
- `SessionStore.list()` no longer re-parses every transcript on every view refresh.
- Detect locally installed Goose and Pi, with the correct direct/adapter ACP
  launchers. The compatibility probe now allows a bounded 60 seconds per
  operation so healthy local-model turns are not reported as false timeouts.

- **Security:** session ids come from the agent and were used directly as filesystem paths, so an id like `../../evil` let an agent write and delete outside the session store. Transcripts are now named by the hash of the id.
- Several concurrent permission or elicitation requests are all reachable. Previously each new one overwrote the last, leaving the earlier ask unanswerable and the agent blocked forever.
- Every live conversation is restored after a window reload, with the one that was on screen restored to it — not just the visible one.
- The Sessions view can be filtered by time window and agent.
- Model, reasoning and permission mode are remembered per agent and restored on later sessions, including across a reload.
- Clicking a changed file shows the net diff across every agent edit, with commands to step through the individual edits.
- Authentication is offered in the chat panel when a first session fails, instead of a settings-gated quick pick shown before the user asked for anything.
- Fixed a latent bug where optional agent methods were detached from the connection before being called, losing their receiver.

## 0.17.0

- Add reconnect chaos tests for the persistent supervisor, and fix the two faults they found: concurrent state writes racing on a shared temp file could kill the supervisor and every agent with it, and an agent that exited left its client socket open so the extension never learned it had died.
- Add an ACP compatibility probe (`test/compat.mjs`) that runs a real agent through the protocol surface Rostrum depends on and prints a matrix row. Bounded and independent per method, and it never answers a permission request.

## 0.16.0

- Changes view gains a folder/flat toggle, with single-child folder chains compacted and paths shown relative to the containing workspace root.
- Timeline gains filters by time window, agent and session.
- Usage stats now record turn duration and tool-call counts alongside tokens, expandable per agent.
- Historical diffs open through a read-only virtual document scheme: syntax-highlighted from the filename even when the original file is gone, with both sides named. Added a command to compare an agent's edit against the current file on disk.

## 0.15.0

- Render agent output as Markdown — headings, lists, tables, quotes, emphasis, links and fenced code — built as DOM nodes rather than markup, so untrusted output can never become markup.
- Restrict link targets to non-executable schemes; refused links degrade to literal text.
- Syntax-highlight code blocks for about twenty languages with no added dependency, losslessly by construction.
- Accessibility: landmarks and labels, a tablist session switcher with arrow-key navigation, a polite live region announcing busy transitions and errors, accessible names on every status indicator, Escape to cancel, and Ctrl/Cmd+Enter to send.
- Tool rows gain a status label, separate highlighted and copyable input/output, and failed calls open themselves.

## 0.14.0

- Detect installed ACP agents on `PATH` and offer to configure them, distinguishing agents that speak ACP directly from those needing an ACP adapter.
- Validate agent configuration before launching, with actionable messages instead of an opaque spawn failure or a silent handshake hang.

## 0.13.0

- Sessions view now lists live conversations above saved ones, bucketed by age, with lifecycle driving icon and colour.
- Add a session switcher to the chat panel, showing each live conversation's status and queue depth.
- Export transcripts as JSON as well as Markdown, and size Markdown fences so agent output containing code fences cannot break out of its block.

## 0.12.0

- Support several live conversations per agent process: client-side ACP callbacks are demultiplexed to the session that owns them.
- Sessions became first-class controllers, so a turn keeps running, recording and persisting while the user works in another conversation.
- Background permission requests raise a notification and are never answered automatically.

## 0.11.0

- The persistent supervisor gained a control protocol: status, per-agent logs, and clean shutdown, with commands for each.
- Supervisor state is stored privately with an agent registry, and a second supervisor stands down rather than racing the first.
- Attaching to stale supervisor state now self-heals, and output dropped while unattended is reported instead of silently lost.
- Supervised agents are keyed by a hash of the normalised workspace and effective definition, so an edited command cannot reattach to a process running the previous one.

## 0.10.0

- Release hardening: full automated suite, command-registration audit, VSIX packaging, and renamed-setting migration that preserves workspace-scoped values.
- Restored active-agent restart behavior: restart now reloads the actual running session where ACP permits.

## 0.9.0

- Persist sent image, audio, and embedded-resource attachments in user turns, session history, and Markdown exports.
- Make tool-reported file locations actionable, opening the exact workspace line.

## 0.8.0

- Preserve rich ACP media and resources in streamed and tool output.
- Add session picking and safe deletion from the chat header and Sessions tree.

## 0.7.0

- Add durable agent session catalog synchronization, cursor-loop protection, `session/resume`, active-session recovery, and Markdown transcript export.
- Add immutable historical diff snapshots, duplicate-update suppression, and symlink-safe workspace file access.

## 0.6.0

- Add capability-gated HTTP and SSE MCP transports alongside stdio configuration.
- Advertise the client capabilities Rostrum implements: terminals, plans, form elicitation, and boolean session configuration.

## 0.5.0

- Rename OpenACP to Rostrum ACP and migrate existing settings without overwriting new values.
