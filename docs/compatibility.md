# ACP compatibility matrix

This matrix is **not filled in yet**. It has to be produced on a machine that
actually has the agents installed and authenticated; nothing here can be
inferred from the code.

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

Every probe is bounded (30s by default, `--timeout` to change it) and
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

## Results

_None recorded yet._
