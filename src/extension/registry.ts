import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition } from "./agentProcess.js";

const run = promisify(execFile);

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

interface NpxDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

interface BinaryTarget {
  archive: string;
  cmd: string;
  sha256?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  website?: string;
  license?: string;
  distribution?: {
    npx?: NpxDistribution;
    uvx?: NpxDistribution;
    binary?: Record<string, BinaryTarget>;
  };
}

interface Registry {
  version: string;
  agents: RegistryAgent[];
}

export async function fetchRegistry(): Promise<RegistryAgent[]> {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Registry request failed with HTTP ${response.status}`);
  }
  const registry = (await response.json()) as Registry;
  return registry.agents ?? [];
}

/**
 * The registry keys binaries by `<os>-<arch>` using its own spelling, which
 * differs from Node's `process.platform` / `process.arch`.
 */
export function platformKey(): string {
  const osPart =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const archPart = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${osPart}-${archPart}`;
}

/** How an agent can be installed on this machine, if at all. */
export function availability(
  agent: RegistryAgent,
): { kind: "npx" | "uvx" } | { kind: "binary"; target: BinaryTarget } | undefined {
  const distribution = agent.distribution ?? {};
  if (distribution.npx) return { kind: "npx" };
  if (distribution.uvx) return { kind: "uvx" };

  const target = distribution.binary?.[platformKey()];
  return target ? { kind: "binary", target } : undefined;
}

/**
 * Turn a registry entry into a runnable agent definition, downloading a
 * platform binary if that is the only distribution on offer.
 *
 * `npx`/`uvx` entries need no install step: the runner resolves the package on
 * first launch.
 */
export async function toDefinition(
  agent: RegistryAgent,
  storageDir: string,
  report: (message: string) => void,
): Promise<AgentDefinition> {
  const distribution = agent.distribution ?? {};

  if (distribution.npx) {
    return {
      command: "npx",
      args: [distribution.npx.package, ...(distribution.npx.args ?? [])],
      env: distribution.npx.env,
    };
  }

  if (distribution.uvx) {
    return {
      command: "uvx",
      args: [distribution.uvx.package, ...(distribution.uvx.args ?? [])],
      env: distribution.uvx.env,
    };
  }

  const target = distribution.binary?.[platformKey()];
  if (!target) {
    throw new Error(`${agent.name} publishes no build for ${platformKey()}.`);
  }

  const installDir = path.join(storageDir, "agents", agent.id, agent.version ?? "latest");
  const command = path.resolve(installDir, target.cmd);

  // Already installed: reuse rather than re-downloading on every launch.
  if (await exists(command)) {
    return { command, args: target.args ?? [], env: target.env };
  }

  report(`Downloading ${agent.name}…`);
  await fs.mkdir(installDir, { recursive: true });

  const response = await fetch(target.archive);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  if (target.sha256) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== target.sha256) {
      throw new Error(
        `Checksum mismatch for ${agent.name}: expected ${target.sha256}, got ${digest}.`,
      );
    }
    report("Checksum verified.");
  }

  const archivePath = path.join(installDir, path.basename(new URL(target.archive).pathname));
  await fs.writeFile(archivePath, bytes);

  report(`Extracting ${agent.name}…`);
  await extract(archivePath, installDir);
  await fs.rm(archivePath, { force: true });

  // Archives do not always preserve the executable bit.
  await fs.chmod(command, 0o755).catch(() => undefined);

  if (!(await exists(command))) {
    throw new Error(`Archive for ${agent.name} did not contain ${target.cmd}.`);
  }

  return { command, args: target.args ?? [], env: target.env };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Extract via the system tools; Node ships no archive support. */
async function extract(archivePath: string, destination: string): Promise<void> {
  if (/\.zip$/i.test(archivePath)) {
    if (process.platform === "win32") {
      await run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
      ]);
    } else {
      await run("unzip", ["-o", "-q", archivePath, "-d", destination]);
    }
    return;
  }

  if (/\.tar\.(gz|xz|bz2)$|\.tgz$/i.test(archivePath)) {
    await run("tar", ["-xf", archivePath, "-C", destination]);
    return;
  }

  // A bare executable: move it into place under its own name.
  await fs.rename(archivePath, path.join(destination, path.basename(archivePath)));
}

/** A stable settings key for an installed agent. */
export function settingsKey(agent: RegistryAgent): string {
  return agent.name;
}

export { os };
