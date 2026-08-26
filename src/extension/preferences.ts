/**
 * Per-agent preferences that outlive a session.
 *
 * Model, reasoning effort and the rest arrive as generic ACP config options,
 * so Rostrum cannot special-case them — but it can remember what the user
 * chose for a given agent and put it back on the next session. Permission mode
 * is remembered the same way, because "yolo for the local scratch agent, ask
 * for the one with production credentials" is the normal shape of that choice
 * and a single global setting cannot express it.
 *
 * Storage is injected rather than reached for, so the rules are testable
 * without an extension host.
 */
import type { PermissionMode } from "./session.js";

export interface AgentPreferences {
  /** Config option id to the value last chosen for this agent. */
  configOptions: Record<string, string | boolean>;
  /** Overrides the global `rostrum.permissionMode` for this agent. */
  permissionMode?: PermissionMode;
}

export interface PreferenceStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = "rostrum.agentPreferences";
const MODES: PermissionMode[] = ["ask", "acceptEdits", "yolo"];

function empty(): AgentPreferences {
  return { configOptions: {} };
}

export class Preferences {
  constructor(private readonly storage: PreferenceStorage) {}

  private all(): Record<string, AgentPreferences> {
    const raw = this.storage.get<unknown>(KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

    // Stored by an earlier version, or hand-edited: keep only what parses.
    const out: Record<string, AgentPreferences> = {};
    for (const [agentKey, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<AgentPreferences>;
      const options: Record<string, string | boolean> = {};
      for (const [id, option] of Object.entries(entry.configOptions ?? {})) {
        if (typeof option === "string" || typeof option === "boolean") options[id] = option;
      }
      out[agentKey] = {
        configOptions: options,
        ...(entry.permissionMode && MODES.includes(entry.permissionMode)
          ? { permissionMode: entry.permissionMode }
          : {}),
      };
    }
    return out;
  }

  forAgent(agentKey: string): AgentPreferences {
    return this.all()[agentKey] ?? empty();
  }

  /** The mode for this agent, falling back to the global default. */
  permissionMode(agentKey: string, fallback: PermissionMode): PermissionMode {
    return this.forAgent(agentKey).permissionMode ?? fallback;
  }

  async setConfigOption(agentKey: string, id: string, value: string | boolean): Promise<void> {
    const all = this.all();
    const current = all[agentKey] ?? empty();
    await this.storage.update(KEY, {
      ...all,
      [agentKey]: { ...current, configOptions: { ...current.configOptions, [id]: value } },
    });
  }

  async setPermissionMode(agentKey: string, mode: PermissionMode | undefined): Promise<void> {
    const all = this.all();
    const current = all[agentKey] ?? empty();
    const next: AgentPreferences = { ...current };
    // `undefined` means "follow the global setting again", which has to remove
    // the key rather than store a value.
    if (mode) next.permissionMode = mode;
    else delete next.permissionMode;
    await this.storage.update(KEY, { ...all, [agentKey]: next });
  }

  async forget(agentKey: string): Promise<void> {
    const all = this.all();
    delete all[agentKey];
    await this.storage.update(KEY, all);
  }

  /**
   * Which saved options differ from what the agent is currently reporting.
   *
   * Only differences are worth sending: re-applying a value the agent already
   * holds costs a round trip and, on some agents, resets dependent options.
   */
  pendingOptions(
    agentKey: string,
    reported: { id: string; currentValue: string | boolean | null }[],
  ): { id: string; value: string | boolean }[] {
    const saved = this.forAgent(agentKey).configOptions;
    return reported.flatMap((option) => {
      const value = saved[option.id];
      if (value === undefined || value === option.currentValue) return [];
      return [{ id: option.id, value }];
    });
  }
}
