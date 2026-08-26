import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionMeta, Turn } from "../shared/protocol.js";

export interface StoredSession {
  sessionId: string;
  agentKey: string;
  title: string;
  updatedAt: number;
  turns: Turn[];
}

/** Metadata for a session discovered from an ACP agent but not downloaded. */
interface CatalogEntry extends SessionMeta {
  /** Agent-owned sessions have no locally persisted transcript yet. */
  source: "agent";
}

/**
 * Session transcripts persisted as one JSON file per session, with an index
 * for the sessions list. Kept deliberately simple: a session is small enough
 * to rewrite wholesale, and a corrupt file should cost one conversation
 * rather than the whole history.
 */
export class SessionStore {
  constructor(private readonly root: string) {}

  private file(sessionId: string): string {
    return path.join(this.root, `${sessionId}.json`);
  }

  private catalogFile(): string {
    return path.join(this.root, "catalog.json");
  }

  async save(session: StoredSession): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the transcript.
    const target = this.file(session.sessionId);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(session), "utf8");
    await fs.rename(temp, target);
  }

  async load(sessionId: string): Promise<StoredSession | undefined> {
    try {
      const raw = await fs.readFile(this.file(sessionId), "utf8");
      return JSON.parse(raw) as StoredSession;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }

    const local = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json") && name !== "catalog.json")
        .map(async (name): Promise<SessionMeta[]> => {
          const session = await this.load(name.replace(/\.json$/, ""));
          if (!session) return [];
          return [
            {
              sessionId: session.sessionId,
              agentKey: session.agentKey,
              title: session.title,
              updatedAt: session.updatedAt,
            },
          ];
        }),
    );

    // A local transcript is richer than a catalog-only entry for the same id,
    // so it wins while still retaining sessions discovered from the agent.
    const merged = new Map<string, SessionMeta>();
    for (const entry of await this.readCatalog()) merged.set(entry.sessionId, entry);
    for (const entry of local.flat()) merged.set(entry.sessionId, entry);
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Look up the owning agent even when no local transcript exists. */
  async meta(sessionId: string): Promise<SessionMeta | undefined> {
    const local = await this.load(sessionId);
    if (local) {
      return {
        sessionId: local.sessionId,
        agentKey: local.agentKey,
        title: local.title,
        updatedAt: local.updatedAt,
      };
    }
    return (await this.readCatalog()).find((entry) => entry.sessionId === sessionId);
  }

  /**
   * Replace one agent's remote catalog page set after a complete ACP sync.
   * This deliberately does not touch transcript files: losing network access
   * must not make locally saved conversations disappear.
   */
  async replaceAgentCatalog(agentKey: string, sessions: SessionMeta[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const retained = (await this.readCatalog()).filter((entry) => entry.agentKey !== agentKey);
    const deduped = new Map<string, CatalogEntry>();
    for (const session of sessions) {
      deduped.set(session.sessionId, { ...session, agentKey, source: "agent" });
    }
    const target = this.catalogFile();
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...retained, ...deduped.values()]), "utf8");
    await fs.rename(temp, target);
  }

  async delete(sessionId: string): Promise<void> {
    await fs.rm(this.file(sessionId), { force: true });
    const retained = (await this.readCatalog()).filter((entry) => entry.sessionId !== sessionId);
    try {
      const target = this.catalogFile();
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, JSON.stringify(retained), "utf8");
      await fs.rename(temp, target);
    } catch {
      // A missing catalog is normal for local-only sessions.
    }
  }

  private async readCatalog(): Promise<CatalogEntry[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.catalogFile(), "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(isCatalogEntry);
    } catch {
      return [];
    }
  }
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CatalogEntry>;
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.agentKey === "string" &&
    typeof entry.title === "string" &&
    typeof entry.updatedAt === "number" &&
    entry.source === "agent"
  );
}

/** First line of the opening user turn, trimmed for the sessions list. */
export function deriveTitle(turns: Turn[]): string {
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    for (const block of turn.blocks) {
      if (block.kind === "text" && block.text.trim()) {
        const line = block.text.trim().split("\n")[0];
        return line.length > 60 ? `${line.slice(0, 57)}…` : line;
      }
    }
  }
  return "New session";
}
