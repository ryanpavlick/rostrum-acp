import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EditRecord {
  /** Absolute path of the edited file. */
  path: string;
  sessionId: string;
  agentKey: string;
  at: number;
  /** ACP tool call that produced this edit, when supplied. */
  toolCallId?: string;
  /** Immutable before/after snapshot when the agent supplied a diff. */
  oldText?: string;
  newText?: string;
}

export interface FileHistory {
  /** Newest edit first. */
  path: string;
  edits: EditRecord[];
}

/**
 * The net change to a file across every recorded edit.
 *
 * A per-edit diff answers "what did this tool call do"; this answers "what has
 * the agent done to this file overall", which is the question you have when
 * reviewing. Built from the oldest snapshot's `oldText` and the newest one's
 * `newText`, so intermediate states collapse.
 */
export function aggregateDiff(
  file: FileHistory,
): { oldText: string; newText: string; edits: number; from: number; to: number } | undefined {
  const snapshots = file.edits.filter((edit) => typeof edit.newText === "string");
  if (snapshots.length === 0) return undefined;

  const newest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];
  return {
    // A file the agent created has no prior text at all.
    oldText: oldest.oldText ?? "",
    newText: newest.newText as string,
    edits: snapshots.length,
    from: oldest.at,
    to: newest.at,
  };
}

/**
 * A durable log of every file the agents edited, so "which session last
 * touched this file?" survives a window reload.
 *
 * Appended as JSON Lines: an edit is a fact, and appending avoids rewriting
 * the whole log on every tool call.
 */
export class ChangeHistory {
  private readonly records: EditRecord[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.records.push(JSON.parse(line) as EditRecord);
        } catch {
          // Skip a torn trailing line rather than losing the whole log.
        }
      }
    } catch {
      // No history yet.
    }
  }

  async record(entry: EditRecord): Promise<void> {
    await this.load();
    // Tool calls often repeat the same completed diff in several update
    // notifications. Keep a single immutable snapshot for that edit.
    if (
      entry.toolCallId &&
      this.records.some(
        (existing) =>
          existing.sessionId === entry.sessionId &&
          existing.toolCallId === entry.toolCallId &&
          existing.path === entry.path &&
          existing.oldText === entry.oldText &&
          existing.newText === entry.newText,
      )
    ) {
      return;
    }
    this.records.push(entry);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** Files touched, most recently edited first. */
  files(): FileHistory[] {
    const byPath = new Map<string, EditRecord[]>();
    for (const record of this.records) {
      const list = byPath.get(record.path);
      if (list) list.push(record);
      else byPath.set(record.path, [record]);
    }

    return [...byPath.entries()]
      .map(([filePath, edits]) => ({
        path: filePath,
        edits: [...edits].sort((a, b) => b.at - a.at),
      }))
      .sort((a, b) => (b.edits[0]?.at ?? 0) - (a.edits[0]?.at ?? 0));
  }

  /** The session that last touched a given file, if any. */
  lastTouchedBy(filePath: string): EditRecord | undefined {
    let latest: EditRecord | undefined;
    for (const record of this.records) {
      if (record.path !== filePath) continue;
      if (!latest || record.at > latest.at) latest = record;
    }
    return latest;
  }

  async clear(): Promise<void> {
    this.records.length = 0;
    await fs.rm(this.file, { force: true });
  }
}
