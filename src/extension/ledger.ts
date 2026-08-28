/**
 * What an agent claims, against what it has actually done.
 *
 * Capability negotiation tells us what an agent advertises at initialize. It
 * says nothing about whether the method works: an agent can declare
 * `session/load` and fail every call. Rostrum gates optional actions on the
 * declaration, so a lie shows up as a feature that is offered and then breaks
 * — which is exactly the report a compatibility matrix needs and the hardest
 * thing to collect by hand.
 *
 * This records the outcome of every optional call and derives a state per
 * method. No `vscode` import, so it is directly testable.
 */

/** How a declared capability is actually behaving. */
export type CapabilityState =
  /** Not advertised. Rostrum never calls it, so silence here is expected. */
  | "not-declared"
  /** Advertised but never called yet — no evidence either way. */
  | "unexercised"
  /** Advertised, called, and has always worked. */
  | "working"
  /** Advertised, called, and has never once worked. The interesting case. */
  | "failing"
  /** Advertised, works sometimes. Worth reporting; worth not trusting. */
  | "unreliable"
  /**
   * Worked without ever being advertised. Should be unreachable while every
   * call site gates on the declaration — if it appears, the gate has a hole.
   */
  | "undeclared-but-working";

export interface CapabilityRecord {
  declared: boolean;
  attempts: number;
  failures: number;
  /** The most recent failure, trimmed. The first is rarely the useful one. */
  lastError?: string;
  lastAt?: number;
}

export interface CapabilityReport extends CapabilityRecord {
  method: string;
  state: CapabilityState;
}

const EMPTY: CapabilityRecord = { declared: false, attempts: 0, failures: 0 };

export function stateOf(record: CapabilityRecord): CapabilityState {
  const successes = record.attempts - record.failures;
  if (!record.declared) return successes > 0 ? "undeclared-but-working" : "not-declared";
  if (record.attempts === 0) return "unexercised";
  if (successes === 0) return "failing";
  if (record.failures > 0) return "unreliable";
  return "working";
}

/** One line of plain English per state, for the diagnostics report. */
export const STATE_TEXT: Record<CapabilityState, string> = {
  "not-declared": "not declared — never called",
  unexercised: "declared, not yet exercised",
  working: "declared and working",
  failing: "declared but every call has failed",
  unreliable: "declared, works only sometimes",
  "undeclared-but-working": "used without being declared",
};

export class CapabilityLedger {
  private readonly byAgent = new Map<string, Map<string, CapabilityRecord>>();

  private entry(agentKey: string, method: string): CapabilityRecord {
    let methods = this.byAgent.get(agentKey);
    if (!methods) {
      methods = new Map();
      this.byAgent.set(agentKey, methods);
    }
    let record = methods.get(method);
    if (!record) {
      record = { ...EMPTY };
      methods.set(method, record);
    }
    return record;
  }

  /** Note what the agent advertised. Re-declaring keeps the call history. */
  declare(agentKey: string, declared: Record<string, boolean>): void {
    for (const [method, value] of Object.entries(declared)) {
      this.entry(agentKey, method).declared = value;
    }
  }

  /** Note the outcome of one optional call. */
  record(agentKey: string, method: string, ok: boolean, error?: unknown): void {
    const entry = this.entry(agentKey, method);
    entry.attempts += 1;
    entry.lastAt = Date.now();
    if (ok) return;
    entry.failures += 1;
    const text = error instanceof Error ? error.message : String(error ?? "failed");
    // A stack trace is not a compatibility finding; the first line usually is.
    entry.lastError = text.split("\n")[0].slice(0, 300);
  }

  /**
   * Run `call`, recording whether it worked. The error is re-thrown: this
   * observes, it does not change how a failure is handled.
   */
  async watch<T>(agentKey: string, method: string, call: () => T | Promise<T>): Promise<T> {
    try {
      const result = await call();
      this.record(agentKey, method, true);
      return result;
    } catch (error) {
      this.record(agentKey, method, false, error);
      throw error;
    }
  }

  report(agentKey: string): CapabilityReport[] {
    const methods = this.byAgent.get(agentKey);
    if (!methods) return [];
    return [...methods.entries()]
      .map(([method, record]) => ({ method, ...record, state: stateOf(record) }))
      .sort((a, b) => a.method.localeCompare(b.method));
  }

  /** The observed state of one method, without building the whole report. */
  stateFor(agentKey: string, method: string): CapabilityState {
    const record = this.byAgent.get(agentKey)?.get(method);
    return record ? stateOf(record) : "not-declared";
  }

  /**
   * Whether a capability can still be relied on. A method that has been called
   * and has never once worked is not usable, whatever it advertised — the
   * declaration is a claim, and this is the evidence against it.
   */
  usable(agentKey: string, method: string, declared: boolean): boolean {
    if (!declared) return false;
    return this.stateFor(agentKey, method) !== "failing";
  }

  /** Everything worth a user's attention: declared and not behaving. */
  suspect(agentKey: string): CapabilityReport[] {
    return this.report(agentKey).filter(
      (entry) => entry.state === "failing" || entry.state === "unreliable",
    );
  }

  forget(agentKey: string): void {
    this.byAgent.delete(agentKey);
  }
}
