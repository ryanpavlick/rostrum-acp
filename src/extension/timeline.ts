/**
 * Filtering and grouping for the Timeline view.
 *
 * Kept free of `vscode` so the selection rules are testable. A timeline that
 * shows everything is only useful for a few minutes of work; the filters are
 * what make it answer "what did this agent do this morning?".
 */
import type { EditRecord } from "./history.js";

export type TimeWindow = "all" | "hour" | "today" | "yesterday" | "week" | "month";

export interface TimelineFilter {
  window: TimeWindow;
  /** Empty means every agent. */
  agentKey?: string;
  /** Empty means every session. */
  sessionId?: string;
}

export const DEFAULT_FILTER: TimelineFilter = { window: "all" };

export const TIME_WINDOWS: { id: TimeWindow; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "hour", label: "Past hour" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Past 7 days" },
  { id: "month", label: "Past 30 days" },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The half-open interval a window covers, as `[from, to)`.
 *
 * "Yesterday" is a bounded day rather than "anything older than today", which
 * is why this returns a range rather than a single cutoff.
 */
export function windowRange(window: TimeWindow, now: number): { from: number; to: number } {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  switch (window) {
    case "hour":
      return { from: now - HOUR, to: Infinity };
    case "today":
      return { from: startOfToday, to: Infinity };
    case "yesterday":
      return { from: startOfToday - DAY, to: startOfToday };
    case "week":
      return { from: startOfToday - 7 * DAY, to: Infinity };
    case "month":
      return { from: startOfToday - 30 * DAY, to: Infinity };
    default:
      return { from: -Infinity, to: Infinity };
  }
}

export function filterEdits(
  edits: EditRecord[],
  filter: TimelineFilter,
  now: number = Date.now(),
): EditRecord[] {
  const { from, to } = windowRange(filter.window, now);
  return edits.filter(
    (edit) =>
      edit.at >= from &&
      edit.at < to &&
      (!filter.agentKey || edit.agentKey === filter.agentKey) &&
      (!filter.sessionId || edit.sessionId === filter.sessionId),
  );
}

/** A short description of what is currently being shown. */
export function describeFilter(filter: TimelineFilter): string {
  const parts: string[] = [];
  const window = TIME_WINDOWS.find((entry) => entry.id === filter.window);
  if (filter.window !== "all" && window) parts.push(window.label.toLowerCase());
  if (filter.agentKey) parts.push(filter.agentKey);
  if (filter.sessionId) parts.push("one session");
  return parts.length > 0 ? parts.join(" · ") : "all edits";
}

export function isFiltered(filter: TimelineFilter): boolean {
  return filter.window !== "all" || Boolean(filter.agentKey) || Boolean(filter.sessionId);
}

/** Distinct agents present in the log, for building the filter picker. */
export function agentsIn(edits: EditRecord[]): string[] {
  return [...new Set(edits.map((edit) => edit.agentKey))].sort();
}
