# ACP compatibility matrix

Results are produced on a machine that actually has the agents installed and
authenticated; they are never inferred from the code. The dated results below
are protocol-level evidence, not a claim of complete VS Code UI or remote-host
coverage.

## Running the probe

```sh
npm run build:test

# One agent
node test/compat.mjs --name "Gemini CLI" --command gemini --args --acp

# Several at once, from a JSON file of agent definitions
node test/compat.mjs --agents ./agents.json

# Also send a live turn — spends tokens, needs the agent authenticated
node test/compat.mjs --name "Gemini CLI" --command gemini --args --acp --prompt
```

`agents.json` takes the same shape as the `rostrum.agents` setting:

```json
{
  "Gemini CLI": { "command": "gemini", "args": ["--acp"] },
  "Claude Code": { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"] }
}
```

`rostrum.detectAgents` inside VS Code will write most of this for you; copy the
resulting `rostrum.agents` value out of settings.

The probe writes Markdown to stdout and progress to stderr, so redirecting
stdout appends straight into this file:

```sh
node test/compat.mjs --agents ./agents.json >> docs/compatibility.md
```

## Reading the results

- **yes / no** — the method was called and did or did not work.
- **not advertised** — the agent did not declare the capability, so it was
  never called. Not a failure.
- **needs approval** — the turn stalled on a permission request. Expected: the
  probe records permission requests and deliberately never answers them, since
  approving a tool call would run real work unasked.
- **skipped** — `--prompt` was not passed.

Every probe is bounded (60s by default, `--timeout` to change it) and
independent, so an agent that hangs on one method still yields a usable report
for the rest. A hang *is* a result worth recording.

## What still needs covering by hand

The probe only exercises the protocol. These need a real VS Code window and
cannot be automated here:

- [ ] Two conversations on one agent, both prompted, switched between mid-turn.
- [ ] Window reload while a turn is running, then supervisor reattach.
- [ ] A background permission request: notification, then answering it after
      opening the session.
- [ ] Terminal tool calls, and their output capping.
- [ ] Attachments: image, audio, embedded text resource.
- [ ] MCP servers over stdio, HTTP and SSE.
- [ ] Remote workspaces: SSH, WSL, dev container. The supervisor is loopback
      TCP and has never been run in any of them.
- [ ] Windows: PATHEXT agent discovery, and supervisor startup.

### Automated coverage completed on 2026-08-26

- [x] Headless protocol, persistence, permission, attachment, terminal, MCP
      validation, reload/recovery, and concurrency suites.
- [x] Extension Development Host activation and command registration on VS Code
      1.104.
- [x] Fresh Node 22 Alpine container workspace host; the complete deterministic
      suite passes when the image includes `python3` for the mock ACP agent.

These checks exercise the implementation and a real VS Code host, but do not
replace the interactive UI or actual Remote SSH/WSL extension-host scenarios
listed above.

## Results

### Claude Code (ACP adapter)

Probed 2026-08-27 on macOS 26 (darwin-arm64), Node v25.8.1, with
`npx -y @agentclientprotocol/claude-agent-acp`. No live prompt.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; no auth methods advertised; image and embedded-context prompts. Took 31.4s, almost all of it `npx` fetching the adapter on first run |
| session/new | yes | 6 modes, 5 configuration options |
| session/prompt | skipped | not run |
| session/cancel | yes | Accepted |
| session/load | yes | Advertised and completed |
| session/resume | yes | Advertised and completed |
| session/list | yes | Advertised and completed |
| session/fork | **no** | Advertised, then failed: `Resource not found: <session id>` |

### Codex (ACP adapter)

Probed 2026-08-27 on macOS 26 (darwin-arm64), Node v25.8.1, with
`npx -y @agentclientprotocol/codex-acp`. No live prompt.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; auth methods `api-key` and `chat-gpt`; image and embedded-context prompts. Took 20.8s including the `npx` fetch |
| session/new | yes | 3 modes, 5 configuration options |
| session/prompt | skipped | not run |
| session/cancel | yes | Accepted |
| session/load | **no** | Advertised, then failed: `Internal error` |
| session/resume | **no** | Advertised, then failed: `Internal error` |
| session/list | yes | Advertised and completed |
| session/fork | not advertised | Not called |

### Gemini CLI

Probed 2026-08-27 on macOS 26 (darwin-arm64) with `gemini --acp`, version 0.47.0.
**Did not reach a handshake**, for two reasons worth recording separately.

Without `GEMINI_CLI_TRUST_WORKSPACE=true` it exits immediately: *"Gemini CLI is
not running in a trusted directory."* With it set, `initialize` never answers —
`~/.gemini/settings.json` selects `gemini-api-key` auth and no key was present,
so the process waits for a credential rather than failing.

`--acp` is correct for this version; `--experimental-acp` is the deprecated
spelling. The invocation in Rostrum's detection list is right.

### What these three found

Three declared-but-broken capabilities across two agents, on first contact:
Claude Code advertises `session/fork` and fails it, and Codex advertises both
`session/load` and `session/resume` and fails both. Rostrum gates optional
actions on the declaration, so each of these would have been offered and then
broken. This is what the capability ledger records, and why session
dehydration now checks observed behaviour rather than the declaration — a
Codex conversation released on its advertised `session/load` could not have
been brought back.

The Gemini result found a fault in Rostrum rather than in Gemini: the ACP
handshake had no timeout, so an agent that starts and then waits for a
credential would have hung the panel with no error. It is now bounded, and
reports the agent's own stderr.


### OpenCode

Probed 2026-08-26 on Linux with `opencode acp`. The live prompt was: “Reply
with exactly the word: ok”.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; auth method `opencode-login`; image and embedded-context prompts advertised |
| session/new | yes | 2 session configuration options |
| session/prompt | yes | Completed with `end_turn`, streamed the two-character reply, reported usage, and made no tool calls |
| session/cancel | yes | Accepted |
| session/load | yes | Advertised and completed |
| session/resume | yes | Advertised and completed |
| session/list | yes | Advertised and completed |
| session/fork | yes | Advertised and completed |

### Hermes

Probed 2026-08-26 on Linux with `hermes acp`. The live prompt used the same
minimal reply-only request.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; auth methods `custom` and `hermes-setup`; image prompts advertised |
| session/new | yes | 3 modes |
| session/prompt | yes | Completed with `end_turn`, streamed the two-character reply, reported usage, and made no tool calls in 29.1s; the probe deadline was raised to 60s so healthy local inference is not misreported as a failure |
| session/cancel | yes | Accepted |
| session/load | yes | Advertised and completed |
| session/resume | yes | Advertised and completed |
| session/list | yes | Advertised and completed |
| session/fork | yes | Advertised and completed |

Qwen Code 0.22.0 was also tested on 2026-08-26 through its `npx` ACP launch:
initialize and session creation succeeded, and it advertised load, list,
resume, session-mode, and five modes. The live ACP registry resolved 39
installable Linux agents, including Qwen Code 0.22.2.

### Goose (local llama.cpp)

Goose 1.47.0 was installed from the ACP Registry's Linux release on 2026-08-26;
its published SHA-256 was verified before installation. It was configured with
`GOOSE_PROVIDER=openai`, `OPENAI_HOST=http://127.0.0.1:8080/v1`, and the local
`Qwen3.8-27B` model.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; image and embedded-context prompts advertised |
| session/new | yes | 4 modes and 4 configuration options |
| session/prompt | yes | `end_turn` in 7.0s; 195 streamed characters; no tool calls |
| session/cancel | yes | Accepted |
| session/load | yes | Advertised and completed |
| session/list | yes | Advertised and completed |
| session/resume / session/fork | not advertised | Not called |

### Pi ACP (local llama.cpp)

The ACP Registry's `pi-acp@0.0.33` adapter was tested on 2026-08-26 with Pi
configured for the same local llama.cpp endpoint and `Qwen3.8-27B` model.

| Check | Result | Detail |
| --- | --- | --- |
| initialize | yes | ACP protocol v1; image prompts advertised |
| session/new | yes | 6 modes and 2 configuration options |
| session/prompt | yes | `end_turn` in 2.8s; 17 streamed characters; no tool calls |
| session/cancel | yes | Accepted |
| session/load | yes | Advertised and completed |
| session/list | yes | Advertised and completed |
| session/resume / session/fork | not advertised | Not called |

These are protocol-level checks only. The by-hand VS Code, permission,
attachment, MCP, and remote-host checks above remain outstanding.
