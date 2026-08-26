/** Run the deterministic suite on a clean container workspace host. */
import * as path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();

const args = [
  "run", "--rm",
  "-v", `${root}:/source:ro`,
  "-w", "/tmp",
  "node:22-alpine",
  "sh", "-lc",
  // The suite's Python mock agent is intentional coverage, so make the
  // otherwise-minimal image state that dependency explicitly.
  "apk add --no-cache python3 >/dev/null && cp -a /source repo && cd repo && npm ci --ignore-scripts && npm test",
];

const child = spawn("docker", args, { stdio: "inherit", shell: false });
child.on("error", (error) => {
  console.error(`Unable to start Docker: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`Container test stopped by ${signal}.`);
  process.exitCode = code ?? 1;
});
