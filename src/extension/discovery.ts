/**
 * Find ACP agents already installed on this machine, and check that a
 * configured agent is actually runnable.
 *
 * The ACP registry publishes how to *install* an agent, not what its binary is
 * called once installed, so the mapping from a local command to an ACP
 * invocation is curated here. Two shapes exist and they are not
 * interchangeable:
 *
 * - `direct`: the CLI speaks ACP itself, given a flag.
 * - `adapter`: the CLI does not; a separate ACP adapter package wraps it. A
 *   local `claude` or `codex` binary will not answer an ACP handshake, so
 *   detecting one must configure the adapter rather than the binary.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDefinition } from "./agentProcess.js";

export type AcpInvocation =
  | { mode: "direct"; args: string[] }
  | { mode: "adapter"; package: string; args: string[] };

export interface AgentProfile {
  /** Registry id, where the agent has one. */
  id: string;
  name: string;
  /** Command names to look for on PATH, most preferred first. */
  binaries: string[];
  acp: AcpInvocation;
  /** Shown when detection finds the CLI but it still needs setting up. */
  notes?: string;
}

/**
 * Agents worth looking for by name. Invocations follow the ACP registry's
 * published distribution arguments.
 */
export const KNOWN_AGENTS: AgentProfile[] = [
  {
    id: "claude-acp",
    name: "Claude Code",
    binaries: ["claude"],
    acp: { mode: "adapter", package: "@agentclientprotocol/claude-agent-acp", args: [] },
    notes: "Claude Code speaks ACP through an adapter, which npx fetches on first launch.",
  },
  {
    id: "codex-acp",
    name: "Codex",
    binaries: ["codex"],
    acp: { mode: "adapter", package: "@agentclientprotocol/codex-acp", args: [] },
    notes: "Codex speaks ACP through an adapter, which npx fetches on first launch.",
  },
  {
    id: "github-copilot-cli",
    name: "GitHub Copilot",
    binaries: ["copilot"],
    acp: { mode: "direct", args: ["--acp"] },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binaries: ["gemini"],
    acp: { mode: "direct", args: ["--acp"] },
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    binaries: ["qwen"],
    acp: { mode: "direct", args: ["--acp", "--experimental-skills"] },
  },
  {
    id: "cline",
    name: "Cline",
    binaries: ["cline"],
    acp: { mode: "direct", args: ["--acp"] },
  },
  {
    id: "auggie",
    name: "Auggie CLI",
    binaries: ["auggie"],
    acp: { mode: "direct", args: ["--acp"] },
  },
  {
    id: "kilo",
    name: "Kilo",
    binaries: ["kilo"],
    acp: { mode: "direct", args: ["acp"] },
  },
  {
    id: "nova",
    name: "Nova",
    binaries: ["nova"],
    acp: { mode: "direct", args: ["acp"] },
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    binaries: ["qodercli", "qoder"],
    acp: { mode: "direct", args: ["--acp"] },
  },
];

export interface DetectedAgent {
  profile: AgentProfile;
  /** Absolute path to the CLI that was found. */
  resolved: string;
  definition: AgentDefinition;
}

export interface PathProbe {
  pathVar: string | undefined;
  pathExt: string | undefined;
  platform: NodeJS.Platform;
  /** Resolves true when the candidate exists and is executable. */
  isExecutable(candidate: string): Promise<boolean>;
}

export function nodeProbe(env: NodeJS.ProcessEnv = process.env): PathProbe {
  return {
    pathVar: env.PATH ?? env.Path,
    pathExt: env.PATHEXT,
    platform: process.platform,
    async isExecutable(candidate) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) return false;
        // The executable bit is meaningless on Windows; extension is the test.
        if (process.platform === "win32") return true;
        await fs.access(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Resolve a bare command name against PATH.
 *
 * Windows needs PATHEXT: `gemini` on PATH is really `gemini.cmd`, and spawning
 * the extensionless name fails.
 */
export async function findOnPath(command: string, probe: PathProbe): Promise<string | undefined> {
  // Join with the target platform's rules, not the host's: resolution has to
  // be correct for the platform being probed, and that is what makes it
  // testable off Windows.
  const join = probe.platform === "win32" ? path.win32.join : path.posix.join;
  const separator = probe.platform === "win32" ? ";" : ":";
  const directories = (probe.pathVar ?? "").split(separator).filter(Boolean);
  const extensions =
    probe.platform === "win32"
      ? ["", ...(probe.pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (await probe.isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Turn a located CLI into a runnable ACP agent definition. */
export function definitionFor(profile: AgentProfile, resolved: string): AgentDefinition {
  if (profile.acp.mode === "direct") {
    return { command: resolved, args: [...profile.acp.args] };
  }
  // The adapter is the ACP speaker; the located CLI is what it drives, and it
  // finds that itself on PATH.
  return { command: "npx", args: ["-y", profile.acp.package, ...profile.acp.args] };
}

/** Every known agent whose CLI is present on this machine. */
export async function detectAgents(
  probe: PathProbe,
  profiles: AgentProfile[] = KNOWN_AGENTS,
): Promise<DetectedAgent[]> {
  const found: DetectedAgent[] = [];
  for (const profile of profiles) {
    for (const binary of profile.binaries) {
      const resolved = await findOnPath(binary, probe);
      if (!resolved) continue;
      found.push({ profile, resolved, definition: definitionFor(profile, resolved) });
      break;
    }
  }
  return found;
}

// --- validation --------------------------------------------------------------

export interface DefinitionProblem {
  /** Something that will certainly fail, versus something merely suspicious. */
  severity: "error" | "warning";
  message: string;
}

/**
 * Check a configured agent before launching it.
 *
 * A misconfigured agent otherwise surfaces as an opaque spawn failure or, far
 * worse, as a silent hang while the ACP handshake waits for a process that was
 * never going to answer.
 */
export function validateAgentDefinition(key: string, value: unknown): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const error = (message: string) => problems.push({ severity: "error", message });
  const warn = (message: string) => problems.push({ severity: "warning", message });

  if (!key.trim()) error("The agent name is empty. Give it a name in rostrum.agents.");

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    error(`"${key}" must be an object with at least a "command" property.`);
    return problems;
  }

  const definition = value as Record<string, unknown>;

  if (typeof definition.command !== "string" || !definition.command.trim()) {
    error(`"${key}" has no "command". Set it to the agent executable, for example "npx".`);
  }

  if (definition.args !== undefined) {
    if (!Array.isArray(definition.args)) {
      error(`"${key}.args" must be an array of strings.`);
    } else if (definition.args.some((entry) => typeof entry !== "string")) {
      error(`"${key}.args" must contain only strings.`);
    } else if (
      typeof definition.command === "string" &&
      /\s/.test(definition.command.trim()) &&
      definition.args.length === 0
    ) {
      warn(
        `"${key}.command" looks like a whole command line. Rostrum does not use a shell, so put the arguments in "${key}.args".`,
      );
    }
  } else if (typeof definition.command === "string" && /\s/.test(definition.command.trim())) {
    warn(
      `"${key}.command" contains spaces and will be run as a single program name. Rostrum does not use a shell, so split the arguments into "${key}.args".`,
    );
  }

  if (definition.env !== undefined) {
    if (typeof definition.env !== "object" || definition.env === null || Array.isArray(definition.env)) {
      error(`"${key}.env" must be an object of string values.`);
    } else if (Object.values(definition.env).some((entry) => typeof entry !== "string")) {
      error(`"${key}.env" values must all be strings.`);
    }
  }

  if (definition.cwd !== undefined && typeof definition.cwd !== "string") {
    error(`"${key}.cwd" must be a string path.`);
  }

  return problems;
}

/**
 * Check a configured agent's command actually exists.
 *
 * Separate from the shape check because it touches the filesystem, and because
 * an absolute path that has since been deleted is a different failure from a
 * malformed setting.
 */
export async function checkCommandExists(
  definition: { command: string },
  probe: PathProbe,
): Promise<DefinitionProblem | undefined> {
  const command = definition.command.trim();
  if (!command) return undefined;

  if (command.includes("/") || command.includes("\\")) {
    return (await probe.isExecutable(command))
      ? undefined
      : {
          severity: "error",
          message: `"${command}" does not exist or is not executable.`,
        };
  }

  return (await findOnPath(command, probe))
    ? undefined
    : {
        severity: "error",
        message: `"${command}" was not found on PATH. Install it, or give its full path in rostrum.agents.`,
      };
}
