/**
 * Probe ACP CLIs which are already installed on this machine.
 *
 * This deliberately performs only the no-prompt part of compat.mjs unless
 * ROSTRUM_LIVE_PROMPT=1 is set. It never installs an agent or auto-approves a
 * request, so it is safe to run as a local compatibility smoke check.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const candidates = [
  { name: "OpenCode", command: "opencode", args: ["acp"] },
  { name: "Hermes", command: "hermes", args: ["acp"] },
];

function installed(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
    timeout: 5_000,
  });
  return !result.error && result.status === 0;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const agents = Object.fromEntries(
  candidates.filter(({ command }) => installed(command)).map(({ name, command, args }) => [name, { command, args }]),
);

if (Object.keys(agents).length === 0) {
  console.log("Compatibility probe skipped: no supported local direct ACP CLI found (OpenCode or Hermes).");
  process.exit(0);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-compat-config-"));
const config = path.join(dir, "agents.json");
try {
  await fs.writeFile(config, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
  const args = ["test/compat.mjs", "--agents", config];
  if (process.env.ROSTRUM_LIVE_PROMPT === "1") args.push("--prompt");
  const exitCode = await run(process.execPath, args);
  process.exitCode = exitCode;
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
