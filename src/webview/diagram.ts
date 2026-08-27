/**
 * The diagram viewer, which runs in its own webview.
 *
 * Mermaid builds DOM from strings internally and has a history of XSS
 * findings, so it is deliberately kept out of the transcript panel: the
 * guarantee that agent output never becomes markup there is the one thing no
 * competing ACP client offers, and it is not worth trading for inline
 * diagrams. This bundle is loaded only when someone asks to see a diagram,
 * into a webview with no access to the transcript, no state, and a policy that
 * allows exactly its own script and inline SVG styling.
 *
 * Errors are shown as text, never as markup, so a diagram that fails to parse
 * cannot smuggle anything through the failure path either.
 */
import mermaid from "mermaid";

interface RenderMessage {
  type: "render";
  source: string;
  /** "dark" or "light", so the diagram matches the editor it opened from. */
  theme: "dark" | "light";
}

const host = document.getElementById("diagram");
const status = document.getElementById("status");

function say(text: string, failed = false): void {
  if (!status) return;
  status.textContent = text;
  status.className = failed ? "failed" : "";
}

async function render(message: RenderMessage): Promise<void> {
  if (!host) return;
  host.replaceChildren();
  say("Rendering…");

  mermaid.initialize({
    startOnLoad: false,
    theme: message.theme === "dark" ? "dark" : "default",
    // Mermaid's own guard against markup in labels. The isolation of this
    // webview is the real defence, but there is no reason to disable it.
    securityLevel: "strict",
  });

  try {
    const { svg } = await mermaid.render(`diagram-${Date.now()}`, message.source);
    // `svg` is markup by construction — this is the whole reason the renderer
    // lives here rather than in the transcript. Parse it in an inert document
    // so nothing executes, and adopt only the resulting element.
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.nodeName === "parsererror") {
      say("That diagram rendered into something this viewer could not read.", true);
      return;
    }
    host.append(document.importNode(root, true));
    say("");
  } catch (error) {
    // A malformed diagram is the common case, not an exceptional one: agents
    // emit half-finished mermaid while streaming.
    say(error instanceof Error ? error.message : String(error), true);
  }
}

window.addEventListener("message", (event: MessageEvent<RenderMessage>) => {
  if (event.data?.type === "render") void render(event.data);
});

say("Waiting for a diagram…");
