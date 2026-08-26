import { createHash } from "node:crypto";
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

  /**
   * Name a transcript file by the hash of its session id, never by the id.
   *
   * Session ids come from the agent, so treating one as a path component lets
   * a malicious or faulty agent write and delete outside this directory —
   * `../../evil` resolves straight out of it. Hashing removes the class of
   * bug rather than blacklisting the spellings of it, and a 64-character hex
   * name can never collide with `catalog.json` either.
   */
  private file(sessionId: string): string {
    return path.join(this.root, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  }

  private catalogFile(): string {
    return path.join(this.root, "catalog.json");
  }

  async save(session: StoredSession): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the transcript.
    // The temp name is unique so two saves of one session cannot race.
    const target = this.file(session.sessionId);
    const temp = `${target}.${process.pid}.${(this.serial += 1)}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(session), "utf8");
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serial = 0;

  async load(sessionId: string): Promise<StoredSession | undefined> {
    const found = await this.locate(sessionId);
    return found?.session;
  }

  /**
   * Find a transcript by session id.
   *
   * Falls back to scanning when the hashed name is absent, so transcripts
   * written by an earlier version — which named files by the raw id — are
   * still readable and deletable rather than being orphaned.
   */
  private async locate(
    sessionId: string,
  ): Promise<{ file: string; session: StoredSession } | undefined> {
    const hashed = this.file(sessionId);
    const direct = await readSession(hashed);
    if (direct) return { file: hashed, session: direct };

    for (const { file, session } of await this.readAll()) {
      if (session.sessionId === sessionId) return { file, session };
    }
    return undefined;
  }

  /** Every stored transcript, whatever its file is called. */
  private async readAll(): Promise<{ file: string; session: StoredSession }[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }

    const found = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json") && name !== "catalog.json")
        .map(async (name) => {
          const file = path.join(this.root, name);
          const session = await readSession(file);
          return session ? [{ file, session }] : [];
        }),
    );
    return found.flat();
  }

  async list(): Promise<SessionMeta[]> {
    // The id comes from the file's contents, never from its name: the name is
    // a hash, and a file written by an older version cannot be trusted to be
    // named after a well-formed id.
    const local = (await this.readAll()).map(({ session }) => ({
      sessionId: session.sessionId,
      agentKey: session.agentKey,
      title: session.title,
      updatedAt: session.updatedAt,
    }));

    // A local transcript is richer than a catalog-only entry for the same id,
    // so it wins while still retaining sessions discovered from the agent.
    const merged = new Map<string, SessionMeta>();
    for (const entry of await this.readCatalog()) merged.set(entry.sessionId, entry);
    for (const entry of local) merged.set(entry.sessionId, entry);
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
    const found = await this.locate(sessionId);
    if (found) await fs.rm(found.file, { force: true });
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

async function readSession(file: string): Promise<StoredSession | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<StoredSession>;
    // A file that does not carry its own id is unusable: the name no longer
    // tells us what it is.
    if (typeof value?.sessionId !== "string" || !Array.isArray(value.turns)) return undefined;
    return value as StoredSession;
  } catch {
    return undefined;
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
