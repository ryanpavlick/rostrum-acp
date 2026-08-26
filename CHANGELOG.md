# Changelog

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
