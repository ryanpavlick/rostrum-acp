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

export interface SessionSearchResult {
  sessionId: string;
  agentKey: string;
  title: string;
  updatedAt: number;
  excerpt: string;
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
   * Catalog changes are read-modify-write operations shared by every agent.
   * Serialising them prevents two simultaneous history syncs from each reading
   * the same old catalog and silently discarding the other's entries.
   */
  private catalogPending: Promise<void> = Promise.resolve();

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
      this.cache.delete(target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serial = 0;

  private serializeCatalog(operation: () => Promise<void>): Promise<void> {
    const result = this.catalogPending.then(operation);
    // Keep a failed operation visible to its caller, but let the next one
    // recover instead of permanently poisoning the catalog queue.
    this.catalogPending = result.catch(() => undefined);
    return result;
  }

  /**
   * Parsed transcripts keyed by file, with the stat they were read at.
   *
   * `list()` runs on every view refresh and the sessions list is rendered
   * constantly, so re-reading and re-parsing every transcript each time is
   * real work. Keying on mtime and size means a file another window changed
   * is still picked up, unlike a cache invalidated only by our own writes.
   */
  private readonly cache = new Map<
    string,
    { mtimeMs: number; size: number; session: StoredSession }
  >();

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

    const present = new Set<string>();
    const found = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json") && name !== "catalog.json")
        .map(async (name) => {
          const file = path.join(this.root, name);
          present.add(file);

          let stat;
          try {
            stat = await fs.stat(file);
          } catch {
            return [];
          }

          const cached = this.cache.get(file);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return [{ file, session: cached.session }];
          }

          const session = await readSession(file);
          if (!session) {
            this.cache.delete(file);
            return [];
          }
          this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
          return [{ file, session }];
        }),
    );

    // Deleted files must not linger in the cache.
    for (const file of [...this.cache.keys()]) {
      if (!present.has(file)) this.cache.delete(file);
    }
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

  /** Search local transcripts, including messages and tool-call output. */
  async search(query: string, limit = 100): Promise<SessionSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const matches: SessionSearchResult[] = [];
    for (const { session } of await this.readAll()) {
      const text = transcriptText(session);
      const index = `${session.title}\n${text}`.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      const source = `${session.title}\n${text}`;
      matches.push({
        sessionId: session.sessionId,
        agentKey: session.agentKey,
        title: session.title,
        updatedAt: session.updatedAt,
        excerpt: source.slice(Math.max(0, index - 60), index + needle.length + 120).replace(/\s+/g, " "),
      });
      if (matches.length >= limit) break;
    }
    return matches.sort((a, b) => b.updatedAt - a.updatedAt);
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
    await this.serializeCatalog(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const retained = (await this.readCatalog()).filter((entry) => entry.agentKey !== agentKey);
      const deduped = new Map<string, CatalogEntry>();
      for (const session of sessions) {
        deduped.set(session.sessionId, { ...session, agentKey, source: "agent" });
      }
      const target = this.catalogFile();
      const temp = `${target}.${process.pid}.${(this.serial += 1)}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify([...retained, ...deduped.values()]), "utf8");
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async delete(sessionId: string): Promise<void> {
    const found = await this.locate(sessionId);
    if (found) {
      await fs.rm(found.file, { force: true });
      this.cache.delete(found.file);
    }
    try {
      await this.serializeCatalog(async () => {
        const retained = (await this.readCatalog()).filter((entry) => entry.sessionId !== sessionId);
        const target = this.catalogFile();
        const temp = `${target}.${process.pid}.${(this.serial += 1)}.tmp`;
        try {
          await fs.writeFile(temp, JSON.stringify(retained), "utf8");
          await fs.rename(temp, target);
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
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

function transcriptText(session: StoredSession): string {
  return session.turns.flatMap((turn) => turn.blocks.map((block) => {
    if (block.kind === "text" || block.kind === "reasoning") return block.text;
    if (block.kind === "tool") return `${block.call.title}\n${block.call.output ?? ""}`;
    if (block.kind === "resource") return `${block.label}\n${block.text ?? ""}`;
    if (block.kind === "diff") return `${block.path}\n${block.oldText}\n${block.newText}`;
    return "";
  })).join("\n");
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
