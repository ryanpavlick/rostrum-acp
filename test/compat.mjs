/**
 * ACP compatibility probe.
 *
 * Runs one real agent through the parts of ACP that Rostrum depends on and
 * prints a matrix row. This is the harness for the 0.17 compatibility matrix:
 * the matrix itself can only be filled in on a machine that actually has the
 * agents installed and authenticated.
 *
 * Every probe is bounded and independent — an agent that hangs on
 * `session/load` must still yield a usable report for everything else, since
 * "this one method hangs" is exactly the kind of finding this is for.
 *
 * Usage:
 *   node test/compat.mjs --name "Gemini" --command gemini --args --acp
 *   node test/compat.mjs --agents ./agents.json          # {"name": {command, args}}
 *   node test/compat.mjs ... --prompt                    # also send a real prompt
 *
 * `--prompt` is opt-in because it spends tokens and needs the agent to be
 * authenticated.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { launchAgent } from "../out/test/agentProcess.js";
import { Session } from "../out/test/session.js";
import { readCapabilities } from "../out/test/capabilities.js";

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const options = { args: [], prompt: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--prompt") options.prompt = true;
    else if (flag === "--name") options.name = argv[++index];
    else if (flag === "--command") options.command = argv[++index];
    else if (flag === "--agents") options.agents = argv[++index];
    else if (flag === "--timeout") options.timeout = Number(argv[++index]);
    else if (flag === "--args") {
      // Everything after --args until the next flag.
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        options.args.push(argv[++index]);
      }
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const TIMEOUT = options.timeout ?? 30_000;

/** Bound every probe: a hang is a result, not a reason to stop. */
function withTimeout(promise, label, ms = TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const PASS = "yes";
const FAIL = "no";

async function probe(report, label, run) {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(run(), label);
    report.rows.push({ label, result: PASS, detail: detail ?? "", ms: Date.now() - startedAt });
    return true;
  } catch (error) {
    report.rows.push({
      label,
      result: FAIL,
      detail: String(error?.message ?? error).slice(0, 200),
      ms: Date.now() - startedAt,
    });
    return false;
  }
}

// --- one agent ---------------------------------------------------------------

async function check(name, definition) {
  const report = { name, command: `${definition.command} ${(definition.args ?? []).join(" ")}`.trim(), rows: [] };
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-compat-"));

  const streamed = [];
  const asked = [];
  const errors = [];
  const session = new Session(
    {
      onTurn: () => {},
      onTurnDelta: () => {},
      // Recorded, never answered. A probe that approved a tool call would be
      // running real work on the user's machine unasked.
      onPending: (request) => { if (request) asked.push(request.title); },
      onModes: () => {},
      onError: (message) => errors.push(message),
      onCommands: (commands) => streamed.push(`${commands.length} commands`),
      onPlan: () => streamed.push("plan"),
    },
    workspace,
    // A probe must never be able to approve a real tool call on the user's
    // behalf: refuse by leaving it in "ask" and answering nothing.
    "ask",
  );

  const stderr = [];
  const handle = launchAgent(
    { ...definition, cwd: workspace },
    () => session,
    (chunk) => stderr.push(chunk),
  );

  let capabilities;
  try {
    const initialised = await probe(report, "initialize", async () => {
      const init = await handle.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          plan: {},
          elicitation: { form: {} },
          session: { configOptions: { boolean: {} } },
        },
      });
      capabilities = readCapabilities(init.agentCapabilities, handle.agent);
      const prompt = init.agentCapabilities?.promptCapabilities ?? {};
      report.protocolVersion = init.protocolVersion;
      report.authMethods = (init.authMethods ?? []).map((method) => method.id);
      report.promptCapabilities = Object.entries(prompt)
        .filter(([, value]) => value === true)
        .map(([key]) => key);
      report.capabilities = capabilities;
      return `protocol v${init.protocolVersion}`;
    });
    if (!initialised) return report;

    let sessionId;
    await probe(report, "session/new", async () => {
      const response = await handle.agent.newSession({ cwd: workspace, mcpServers: [] });
      sessionId = response.sessionId;
      session.sessionId = sessionId;
      const modes = response.modes?.availableModes?.length ?? 0;
      const configOptions = Array.isArray(response.configOptions) ? response.configOptions.length : 0;
      return `${modes} mode(s), ${configOptions} option(s)`;
    });

    if (sessionId && options.prompt) {
      await probe(report, "session/prompt", async () => {
        const response = await handle.agent.prompt({
          sessionId,
          prompt: [{ type: "text", text: "Reply with exactly the word: ok" }],
        });
        const text = session
          .getTurns()
          .flatMap((turn) => turn.blocks)
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("");
        const tools = session.toolCallCount();
        return (
          `stop=${response.stopReason}, usage=${response.usage ? "yes" : "no"}, ` +
          `${text.length} chars, ${tools} tool call(s)`
        );
      });

      // A turn that stalls waiting on approval is a normal outcome for a
      // probe, not a fault in the agent — say so instead of leaving a bare
      // timeout that reads like a hang.
      if (asked.length > 0) {
        const row = report.rows.find((entry) => entry.label === "session/prompt");
        if (row && row.result === FAIL) {
          row.result = "needs approval";
          row.detail = `asked to approve: ${asked.join("; ")}`.slice(0, 200);
        }
      }
    } else if (sessionId) {
      report.rows.push({
        label: "session/prompt",
        result: "skipped",
        detail: "pass --prompt to spend tokens on a live turn",
        ms: 0,
      });
    }

    if (sessionId) {
      await probe(report, "session/cancel", async () => {
        await handle.agent.cancel({ sessionId });
        return "accepted";
      });
    }

    // Only exercise what the agent actually advertises: calling an
    // unadvertised method proves nothing except that it is missing.
    const optional = [
      ["session/load", capabilities?.loadSession, () =>
        handle.agent.loadSession({ sessionId, cwd: workspace, mcpServers: [] })],
      ["session/resume", capabilities?.resumeSession, () =>
        handle.agent.resumeSession({ sessionId, cwd: workspace, mcpServers: [] })],
      ["session/list", capabilities?.listSessions, async () => {
        const response = await handle.agent.listSessions({ cwd: workspace });
        return `${response.sessions.length} session(s)`;
      }],
      ["session/fork", capabilities?.forkSession, async () => {
        const forked = await handle.agent.unstable_forkSession({ sessionId, cwd: workspace });
        return `forked to ${forked.sessionId}`;
      }],
    ];

    for (const [label, advertised, run] of optional) {
      if (!advertised) {
        report.rows.push({ label, result: "not advertised", detail: "", ms: 0 });
        continue;
      }
      await probe(report, label, async () => (await run()) && "ok");
    }
  } finally {
    handle.dispose();
    report.stderr = stderr.join("").trim().split("\n").filter(Boolean).slice(-5);
    report.errors = errors.slice(-3);
    report.permissionsRequested = asked.length;
    await fs.rm(workspace, { recursive: true, force: true });
  }

  return report;
}

// --- reporting ---------------------------------------------------------------

function renderReport(report) {
  const lines = [`## ${report.name}`, "", `\`${report.command}\``, ""];
  if (report.protocolVersion !== undefined) {
    lines.push(`- Protocol version: ${report.protocolVersion}`);
    lines.push(`- Auth methods: ${report.authMethods?.length ? report.authMethods.join(", ") : "none"}`);
    lines.push(
      `- Prompt content: ${report.promptCapabilities?.length ? report.promptCapabilities.join(", ") : "text only"}`,
    );
    lines.push("");
  }
  lines.push("| Check | Result | Detail | Time |", "| --- | --- | --- | --- |");
  for (const row of report.rows) {
    lines.push(`| ${row.label} | ${row.result} | ${row.detail.replace(/\|/g, "\\|")} | ${row.ms}ms |`);
  }
  if (report.errors?.length) {
    lines.push("", `Client-side errors: ${report.errors.join(" · ")}`);
  }
  if (report.stderr?.length) {
    lines.push("", "<details><summary>Last stderr</summary>", "", "```", ...report.stderr, "```", "", "</details>");
  }
  lines.push("");
  return lines.join("\n");
}

// --- entry point -------------------------------------------------------------

const definitions = {};
if (options.agents) {
  Object.assign(definitions, JSON.parse(await fs.readFile(options.agents, "utf8")));
} else if (options.command) {
  definitions[options.name ?? options.command] = { command: options.command, args: options.args };
} else {
  console.error(
    [
      "Nothing to probe. Give an agent to run:",
      "",
      "  node test/compat.mjs --name Gemini --command gemini --args --acp",
      "  node test/compat.mjs --agents ./agents.json",
      "",
      "Add --prompt to also send a live turn (spends tokens, needs auth).",
    ].join("\n"),
  );
  process.exit(2);
}

const reports = [];
for (const [name, definition] of Object.entries(definitions)) {
  console.error(`Probing ${name}…`);
  reports.push(await check(name, definition));
}

const summary = [
  "# ACP compatibility",
  "",
  `Probed on ${new Date().toISOString()} · ${process.platform}-${process.arch} · node ${process.version}`,
  "",
  "| Agent | initialize | session/new | prompt | load | resume | list | fork |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...reports.map((report) => {
    const cell = (label) => report.rows.find((row) => row.label === label)?.result ?? "—";
    return `| ${report.name} | ${cell("initialize")} | ${cell("session/new")} | ${cell("session/prompt")} | ${cell("session/load")} | ${cell("session/resume")} | ${cell("session/list")} | ${cell("session/fork")} |`;
  }),
  "",
  ...reports.map(renderReport),
].join("\n");

console.log(summary);

const failed = reports.some((report) =>
  report.rows.some((row) => row.result === FAIL && ["initialize", "session/new"].includes(row.label)),
);
process.exit(failed ? 1 : 0);
