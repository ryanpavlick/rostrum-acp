/**
 * Which turns the transcript builds into the DOM.
 *
 * Kept apart from `main.ts` so the rules can be tested without a DOM. The
 * decisions here are the ones that quietly corrupt a transcript when they are
 * wrong: build too few and an update lands nowhere, build the wrong ones and an
 * old turn appears at the bottom out of order.
 */
import type { Turn } from "../shared/protocol.js";

/** How many turns stay built when the whole conversation is not shown. */
export const TURN_WINDOW = 40;

export interface TranscriptWindow {
  /** The turns to build, oldest first, always a suffix of the conversation. */
  shown: Turn[];
  /** How many older turns are left out. Zero when everything is shown. */
  hidden: number;
}

/**
 * The newest `size` turns, unless the whole conversation was asked for.
 * A conversation shorter than the window is never truncated, so `hidden` is
 * zero and no "show earlier" affordance appears.
 */
export function windowTurns(turns: Turn[], showAll: boolean, size = TURN_WINDOW): TranscriptWindow {
  if (showAll || turns.length <= size) return { shown: turns, hidden: 0 };
  return { shown: turns.slice(turns.length - size), hidden: turns.length - size };
}

/**
 * Whether an update for `turnId` should touch the DOM.
 *
 * A turn already built is always updated in place, even if the window has
 * since moved past it — the node exists, and leaving it stale would show
 * wrong content. A turn that is neither built nor inside the window is
 * skipped: appending it would put an old turn after newer ones.
 */
export function shouldRenderUpdate(
  turnId: string,
  window: TranscriptWindow,
  alreadyBuilt: boolean,
): boolean {
  if (alreadyBuilt) return true;
  return window.shown.some((turn) => turn.id === turnId);
}

/**
 * Whether expanding should be forgotten. Expansion belongs to one
 * conversation: a state push arrives constantly during a turn, so anything
 * coarser than an identity change would undo the user's click as the next
 * token arrived.
 */
export function shouldCollapse(previousSessionId: string | null, nextSessionId: string | null): boolean {
  return previousSessionId !== nextSessionId;
}
