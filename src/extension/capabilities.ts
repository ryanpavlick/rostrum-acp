import type { Capabilities } from "../shared/protocol.js";

export const NO_CAPABILITIES: Capabilities = {
  loadSession: false,
  forkSession: false,
  listSessions: false,
  deleteSession: false,
  resumeSession: false,
  setSessionMode: false,
  additionalDirectories: false,
};

/** The subset of the connection we need to probe for optional methods. */
export interface MethodProbe {
  loadSession?: unknown;
  unstable_forkSession?: unknown;
  listSessions?: unknown;
  deleteSession?: unknown;
  resumeSession?: unknown;
    setSessionMode?: unknown;
}

/**
 * Decide which optional ACP methods are actually usable.
 *
 * Two signals must agree: the agent has to advertise the capability, and the
 * method has to exist on the connection. The SDK defines every optional method
 * on the class, so presence alone would claim support the agent never
 * declared — hence the pairing.
 *
 * `loadSession` is advertised as a plain boolean on `agentCapabilities`, while
 * the session operations sit under `sessionCapabilities` as objects; an empty
 * object there means "supported", so presence is what counts, not truthiness
 * of a flag.
 */
export function readCapabilities(advertised: unknown, methods: MethodProbe): Capabilities {
  const caps = (advertised ?? {}) as {
    loadSession?: boolean;
    sessionCapabilities?: Record<string, unknown> | null;
  };
  const session = caps.sessionCapabilities ?? {};
  const declared = (name: string) => session[name] != null;

  return {
    loadSession: caps.loadSession === true && methods.loadSession != null,
    forkSession: declared("fork") && methods.unstable_forkSession != null,
    listSessions: declared("list") && methods.listSessions != null,
    deleteSession: declared("delete") && methods.deleteSession != null,
    resumeSession: declared("resume") && methods.resumeSession != null,
    setSessionMode: methods.setSessionMode != null,
    additionalDirectories: declared("additionalDirectories"),
  };
}
