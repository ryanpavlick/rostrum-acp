# Support

Rostrum is beta software. Compatibility depends on the ACP features each agent
advertises and on the workspace host where VS Code runs the extension.

## Getting Help

Open an issue at:

https://github.com/ryanpavlick/rostrum-acp/issues

For an agent compatibility report, include:

- ACP agent name and version.
- Operating system and whether the workspace is local, SSH, WSL, or a dev container.
- The configured command and arguments, with secrets removed.
- What you expected to happen and what happened instead.
- A redacted Rostrum log from **Rostrum: Show Agent Log** or the **Rostrum** output channel.

Do not include API keys, access tokens, private prompts, proprietary source
code, workspace archives, or unredacted logs.

## Beta Expectations

Before filing a bug, try **Rostrum: Show Agent Diagnostics** and confirm the
agent is installed and authenticated according to its own documentation. If the
extension state looks stale after a crash or reload, use **Rostrum: Stop
Background Agents** first.

For a clean local reset, use **Rostrum: Clear Local Data**. It stops Rostrum
background agents and removes saved transcripts, synced session catalog
entries, change history, usage stats, remembered per-agent choices, and reload
recovery state. It does not edit your VS Code settings or remove installed
agents.

## Security Reports

Please do not open public issues for vulnerabilities. Email the project
maintainers or use GitHub private vulnerability reporting if it is enabled for
the repository.
