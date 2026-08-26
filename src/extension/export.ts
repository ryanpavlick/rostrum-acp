/**
 * Transcript serialisation.
 *
 * Kept free of `vscode` so the formats can be tested directly: an export is
 * the one artefact a user takes outside the extension, so it has to survive
 * every block kind the transcript can hold rather than only the common ones.
 */
import type { Block, Turn } from "../shared/protocol.js";
import type { StoredSession } from "./store.js";

export type ExportFormat = "markdown" | "json";

/** Pick the format from the file the user chose to save as. */
export function formatForPath(filePath: string): ExportFormat {
  return filePath.toLowerCase().endsWith(".json") ? "json" : "markdown";
}

export function serializeTranscript(session: StoredSession, format: ExportFormat): string {
  return format === "json" ? transcriptJson(session) : transcriptMarkdown(session.title, session.turns);
}

/**
 * The full record, for tooling rather than reading.
 *
 * Media stays base64 in place: an export that silently dropped an image would
 * not round-trip, and this format exists precisely to be complete.
 */
export function transcriptJson(session: StoredSession): string {
  return `${JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId: session.sessionId,
      agentKey: session.agentKey,
      title: session.title,
      updatedAt: session.updatedAt,
      turns: session.turns,
    },
    null,
    2,
  )}\n`;
}

export function transcriptMarkdown(title: string, turns: Turn[]): string {
  const parts = [`# ${title}`, ""];
  for (const turn of turns) {
    parts.push(`## ${turn.role === "user" ? "You" : "Agent"}`, "");
    for (const block of turn.blocks) parts.push(...blockMarkdown(block));
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * Fence content at a length no inner run of backticks can close.
 *
 * Agent output routinely contains fenced code, so a fixed three-backtick fence
 * would let a transcript break out of its own block.
 */
function fence(body: string, info = ""): string[] {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return [`${ticks}${info}`, body, ticks, ""];
}

function blockMarkdown(block: Block): string[] {
  switch (block.kind) {
    case "text":
      return [block.text, ""];
    case "reasoning":
      return ["<details><summary>Thinking</summary>", "", block.text, "", "</details>", ""];
    case "tool": {
      const lines = [`> **${block.call.kind}** — ${block.call.title} (${block.call.status})`, ""];
      if (block.call.output) lines.push(...fence(block.call.output));
      return lines;
    }
    case "diff":
      return [
        `### Diff: \`${block.path}\``,
        "",
        ...fence(
          [
            ...block.oldText.split("\n").map((line) => `- ${line}`),
            ...block.newText.split("\n").map((line) => `+ ${line}`),
          ].join("\n"),
          "diff",
        ),
      ];
    case "image":
      return [`_[Image attachment: ${block.mimeType}]_`, ""];
    case "audio":
      return [`_[Audio attachment: ${block.mimeType}]_`, ""];
    case "resource":
      return [
        block.uri ? `[${block.label}](${block.uri})` : `_${block.label}_`,
        ...(block.text ? ["", ...fence(block.text)] : [""]),
      ];
  }
}
