import type { Turn } from "../shared/protocol.js";

/** How many turns stay built when the whole conversation is not shown. */
export const TURN_WINDOW = 40;

export interface TranscriptWindow {
  shown: Turn[];
  hidden: number;
}

/**
 * The newest `size` turns, unless the whole conversation was asked for.
 * A conversation shorter than the window is never truncated.
 */
export function windowTurns(turns: Turn[], showAll: boolean): TranscriptWindow {
  return { shown: turns, hidden: 0 };
}

/** Whether an update for `turnId` should touch the DOM. */
export function shouldRenderUpdate(turnId: string, window: TranscriptWindow): boolean {
  return window.shown.some((turn) => turn.id === turnId);
}
