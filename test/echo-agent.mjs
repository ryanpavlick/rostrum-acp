/**
 * A scriptable stand-in for an ACP agent, used to exercise the supervisor.
 *
 * It speaks newline-delimited JSON on stdio like a real agent, but every
 * response is dictated by the test: echo a line, emit a given number of bytes
 * after a delay (so the supervisor has to buffer them while nothing is
 * attached), write to stderr, or exit.
 */
import { stderr, stdin, stdout } from "node:process";

stderr.write("echo-agent: ready\n");

let buffer = "";
stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(line);
    newline = buffer.indexOf("\n");
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    stderr.write(`echo-agent: unparseable line ${JSON.stringify(line)}\n`);
    return;
  }

  switch (message.cmd) {
    case "echo":
      stdout.write(`${JSON.stringify({ echo: message.text })}\n`);
      break;
    case "emit": {
      const run = () => {
        // One long line plus a sentinel, so a test can tell truncation from loss.
        const filler = "x".repeat(Math.max(0, message.bytes ?? 0));
        stdout.write(`${JSON.stringify({ filler })}\n`);
        stdout.write(`${JSON.stringify({ done: message.tag ?? "emit" })}\n`);
      };
      if (message.delayMs) setTimeout(run, message.delayMs);
      else run();
      break;
    }
    case "log":
      stderr.write(`${message.text}\n`);
      break;
    case "exit":
      process.exit(message.code ?? 0);
      break;
    default:
      stderr.write(`echo-agent: unknown command ${JSON.stringify(message.cmd)}\n`);
  }
}
