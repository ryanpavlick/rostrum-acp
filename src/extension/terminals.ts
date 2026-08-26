import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

interface Running {
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: string;
  truncated: boolean;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  settled?: { exitCode: number | null; signal: string | null };
}

/** Cap retained output so a runaway command cannot exhaust the host. */
const MAX_OUTPUT = 1_000_000;

/**
 * Terminals the agent creates through ACP.
 *
 * These are real child processes, not VS Code terminal UI: the agent needs to
 * read their output back, which the VS Code terminal API does not expose.
 */
export class TerminalRegistry {
  private readonly terminals = new Map<string, Running>();

  create(params: {
    command: string;
    args?: string[] | null;
    cwd?: string | null;
    env?: { name: string; value: string }[] | null;
    outputByteLimit?: number | null;
  }): string {
    const id = randomUUID();
    const env = { ...process.env };
    for (const entry of params.env ?? []) env[entry.name] = entry.value;

    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const limit = params.outputByteLimit ?? MAX_OUTPUT;
    const running: Running = {
      child,
      output: "",
      truncated: false,
      exit: new Promise((resolve) => {
        child.once("exit", (exitCode, signal) => {
          const result = { exitCode, signal: signal ?? null };
          running.settled = result;
          resolve(result);
        });
      }),
    };

    const append = (chunk: Buffer) => {
      running.output += chunk.toString("utf8");
      if (running.output.length > limit) {
        running.output = running.output.slice(-limit);
        running.truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    this.terminals.set(id, running);
    return id;
  }

  output(id: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const running = this.require(id);
    return {
      output: running.output,
      truncated: running.truncated,
      exitStatus: running.settled,
    };
  }

  waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.require(id).exit;
  }

  kill(id: string): void {
    this.require(id).child.kill("SIGTERM");
  }

  release(id: string): void {
    const running = this.terminals.get(id);
    if (!running) return;
    if (running.settled === undefined) running.child.kill("SIGTERM");
    this.terminals.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  private require(id: string): Running {
    const running = this.terminals.get(id);
    if (!running) throw new Error(`Unknown terminal: ${id}`);
    return running;
  }
}
