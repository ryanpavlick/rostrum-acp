/**
 * Reap what a disposable VS Code profile left behind.
 *
 * Rostrum's supervisor is spawned detached on purpose — outliving the window
 * is the whole point of it — and it owns the agent process in turn. Killing
 * the editor therefore orphans both to PID 1 rather than ending them, so any
 * script that launches a throwaway profile has to clean up after itself or
 * leave a supervisor and an agent running for the rest of the session.
 *
 * Matching on the profile path is exact: it is unique to the run that created
 * it, so nothing belonging to the user's real editor can be caught by it.
 */
import { execFileSync } from "node:child_process";

/** Process ids whose command line mentions `marker`, excluding this process. */
function pidsMatching(marker) {
  if (process.platform === "win32") return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, command] = match;
    if (Number(pid) === process.pid) continue;
    if (command.includes(marker)) pids.push(Number(pid));
  }
  return pids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask everything from this profile to stop, then insist. Returns how many
 * processes were still alive when asked, so a caller can report a leak rather
 * than silently papering over one.
 */
export async function reapProfile(profile, { quiet = false } = {}) {
  const initial = pidsMatching(profile);
  if (initial.length === 0) return 0;

  for (const pid of initial) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between listing and signalling.
    }
  }
  await sleep(1200);

  const stubborn = pidsMatching(profile);
  for (const pid of stubborn) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (stubborn.length > 0) await sleep(400);

  const remaining = pidsMatching(profile).length;
  if (!quiet && remaining > 0) {
    console.warn(`warning: ${remaining} process(es) from ${profile} survived cleanup`);
  }
  return initial.length;
}
