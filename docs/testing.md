# Testing plan

This plan separates proof that can run on every pull request from checks that
need a real, authenticated agent or a particular VS Code host. A green CI run
does not claim that every agent or remote host has been exercised.

## Automated gates

| Tier | Command | Where it runs | What it proves | Gate |
| --- | --- | --- | --- | --- |
| 0 | `npm run typecheck` | CI and local | TypeScript contract is sound. | Required |
| 0 | `npm test` | CI and local | Deterministic protocol, storage, recovery, routing, concurrency, UI-provider, export, workspace, and preference regressions. | Required |
| 0 | `npm run build` | CI and local | Production extension bundle builds. | Required |
| 0 | `npx vsce package --no-dependencies` | CI and local | The installable VSIX, manifest, icon, and package contents are valid. | Required |
| 1 | `npm run test:compat` | Developer machine or trusted self-hosted runner | Real ACP initialize/new-session/cancel and advertised session operations for installed direct agents. | Required before claiming a tested agent version |
| 2 | `ROSTRUM_LIVE_PROMPT=1 npm run test:compat` | Explicit local/manual run only | A minimal real prompt and streamed turn. It can spend tokens. | Release-candidate sample |
| 3 | `npm run test:extension` | Local or GUI-capable self-hosted runner | Launches a real Extension Development Host, activates Rostrum, and verifies its core commands are registered. | Required before release |

The GitHub Actions matrix runs Tier 0 on Node 20 and 22 across Linux, macOS,
and Windows. This is intentionally the merge gate: it has no agent credentials
and must not download, authenticate, or authorize third-party agents.

## ACP compatibility automation

`npm run test:compat` discovers only the direct ACP CLIs it can safely find
today: `opencode acp` and `hermes acp`. If neither is installed, it reports a
skip and exits successfully. It creates a temporary empty workspace, sends no
prompt by default, never answers a permission request, bounds each operation,
and removes its temporary files.

For any other agent or adapter, provide an explicit configuration file:

```json
{
  "My agent": { "command": "agent-command", "args": ["--acp"] }
}
```

```bash
npm run build:test
node test/compat.mjs --agents ./agents.json
```

Add `--prompt` only when an authenticated test account and an intentional
token budget are available. Save the resulting Markdown output in
[`compatibility.md`](compatibility.md) with the tested CLI version, platform,
and date. Adapter checks are opt-in because `npx` may download packages and
may use the developer's credentials.

## Release-candidate matrix

Run this small manual matrix for a release candidate or whenever the ACP
client, process launcher, session restore, or webview protocol changes.

| Scenario | Evidence to record |
| --- | --- |
| Fresh local workspace | New session, stream, cancel, permission allow/deny, attachment, diff, and export. |
| Restore and recovery | Reload VS Code during/after a turn; try `all`, `recent`, and `active` restore strategies; verify recovery retry. |
| Agent capability edges | One native direct agent and one adapter-backed agent; record unsupported load/resume/list/fork/MCP behavior. |
| Permission and tool safety | Verify `ask`, `acceptEdits`, and `yolo` only in a disposable workspace; confirm questions remain visible. |
| Remote host | Repeat fresh-session and changed-file checks in Remote SSH, WSL, and a dev container when those platforms are released. |
| Platform | Exercise the packaged VSIX at least once on the supported desktop platforms represented by the CI matrix. |

Use a disposable workspace for all live agent tests. Do not put credentials in
the compatibility output, logs, or fixtures.

## Desktop automation boundary

`npm run test:extension` uses `@vscode/test-electron`, downloads the VS Code
release matching the published API baseline, and starts a clean Extension
Development Host against an empty fixture workspace. It verifies extension
activation and the public command surface. Override the download target with
`ROSTRUM_VSCODE_VERSION=<version>` when testing another VS Code release.

The first run can take longer because it downloads VS Code; run it on a
GUI-capable developer machine or self-hosted runner, not the credential-free
hosted ACP compatibility gate. The test intentionally has no real agent
credentials. A later self-hosted expansion can run the existing mock ACP agent
through a new session and cancellation. Remote SSH, WSL, and dev containers
remain release-matrix coverage because a generic desktop host cannot reproduce
them.

## Exit criteria

Before merge: all Tier 0 checks pass. Before documenting an agent as tested:
Tier 1 has a dated result. Before a release: Tier 0 passes on CI, Tier 3
passes on a supported desktop host, one Tier 2 probe is reviewed for each
supported agent family, and applicable release-candidate matrix rows have
recorded outcomes or an explicit exception.
