# Changelog

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
