import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@agentclientprotocol/sdk";

export interface UsageTotals {
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
}

export function emptyTotals(): UsageTotals {
  return {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedReadTokens: 0,
  };
}

function add(into: UsageTotals, usage: Usage): void {
  into.turns += 1;
  into.totalTokens += usage.totalTokens ?? 0;
  into.inputTokens += usage.inputTokens ?? 0;
  into.outputTokens += usage.outputTokens ?? 0;
  into.thoughtTokens += usage.thoughtTokens ?? 0;
  into.cachedReadTokens += usage.cachedReadTokens ?? 0;
}

/**
 * Token accounting per agent, aggregated across sessions.
 *
 * Counts come from `PromptResponse.usage`, which is optional in ACP — agents
 * that omit it simply contribute nothing rather than reporting zeros.
 */
export class UsageTracker {
  private byAgent = new Map<string, UsageTotals>();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, UsageTotals>;
      this.byAgent = new Map(Object.entries(parsed));
    } catch {
      // No usage recorded yet.
    }
  }

  async record(agentKey: string, usage: Usage | null | undefined): Promise<void> {
    if (!usage) return;
    await this.load();

    const totals = this.byAgent.get(agentKey) ?? emptyTotals();
    add(totals, usage);
    this.byAgent.set(agentKey, totals);

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(
      this.file,
      JSON.stringify(Object.fromEntries(this.byAgent), null, 2),
      "utf8",
    );
  }

  entries(): { agentKey: string; totals: UsageTotals }[] {
    return [...this.byAgent.entries()]
      .map(([agentKey, totals]) => ({ agentKey, totals }))
      .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
  }

  async clear(): Promise<void> {
    this.byAgent.clear();
    await fs.rm(this.file, { force: true });
  }
}

/** Compact human-readable token count, e.g. 12.4k. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
