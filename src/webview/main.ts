import type {
  Block,
  Capabilities,
  HostMessage,
  PendingRequest,
  Question,
  SessionLifecycle,
  Turn,
  ViewMessage,
  ViewState,
} from "../shared/protocol.js";

import { parseMarkdown, type Inline, type MdNode } from "./markdown.js";
import { highlight } from "./highlight.js";

declare function acquireVsCodeApi(): { postMessage(message: ViewMessage): void };
const vscode = acquireVsCodeApi();

/** Local mirror of host state, so deltas can patch without a full re-render. */
const state: ViewState = {
  agents: [],
  currentAgent: null,
  sessionId: null,
  turns: [],
  busy: false,
  pending: null,
  modes: [],
  currentMode: null,
  sessions: [],
  capabilities: {
    loadSession: false,
    forkSession: false,
    listSessions: false,
    deleteSession: false,
    resumeSession: false,
    setSessionMode: false,
    additionalDirectories: false,
  } satisfies Capabilities,
  usage: null,
  configOptions: [],
  commands: [],
  plan: [],
  queued: [],
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  liveSessions: [],
};

let attachmentNames: string[] = [];

const turnNodes = new Map<string, HTMLElement>();

// --- element helpers --------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // Always textContent: agent output is untrusted and must never be parsed.
  if (text !== undefined) node.textContent = text;
  return node;
}

function post(message: ViewMessage): void {
  vscode.postMessage(message);
}

// --- layout -----------------------------------------------------------------

const root = document.getElementById("root")!;
const header = el("div", "header");
const sessionBar = el("div", "session-bar");
const optionBar = el("div", "option-bar");
const log = el("div", "log");
const planHost = el("div", "plan-host");
const pendingHost = el("div", "pending-host");
const queueHost = el("div", "queue-host");
const attachHost = el("div", "attach-host");
const composer = el("div", "composer");
// Landmarks and a live region, so the panel is navigable and announced
// rather than being an undifferentiated pile of divs.
header.setAttribute("role", "toolbar");
header.setAttribute("aria-label", "Rostrum session controls");
sessionBar.setAttribute("role", "tablist");
sessionBar.setAttribute("aria-label", "Live conversations");
log.setAttribute("role", "log");
log.setAttribute("aria-label", "Conversation");
// Streaming tokens would be far too chatty to announce; `status` carries the
// milestones instead.
log.setAttribute("aria-live", "off");
composer.setAttribute("role", "group");
composer.setAttribute("aria-label", "Compose a prompt");

/** Visually hidden, announced politely: busy transitions and errors. */
const status = el("div", "sr-only");
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");

function announce(message: string): void {
  status.textContent = message;
}

root.append(header, sessionBar, optionBar, log, planHost, pendingHost, queueHost, attachHost, composer, status);

const agentSelect = el("select", "picker");
agentSelect.onchange = () => post({ type: "selectAgent", agent: agentSelect.value });


const newButton = el("button", "ghost", "New");
newButton.type = "button";
newButton.onclick = () => post({ type: "newSession" });

const historyButton = el("button", "ghost", "History");
historyButton.type = "button";
historyButton.title = "Open a saved session";
historyButton.onclick = () => post({ type: "pickSession" });

const forkButton = el("button", "ghost", "Fork");
forkButton.type = "button";
forkButton.title = "Branch this conversation";
forkButton.onclick = () => post({ type: "forkSession" });

const usageLabel = el("span", "usage");

header.append(agentSelect, newButton, historyButton, forkButton, usageLabel);

const input = el("textarea", "input");
input.rows = 3;
input.placeholder = "Ask the agent…";
input.setAttribute("aria-label", "Prompt");
input.onkeydown = (event) => {
  // Enter sends; Shift+Enter is a newline. Ctrl/Cmd+Enter also sends, for
  // people who have the opposite habit from another editor.
  if (event.key === "Enter" && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitPrompt();
    return;
  }
  if (event.key === "Escape" && state.busy) {
    event.preventDefault();
    post({ type: "cancel" });
  }
};

const sendButton = el("button", "primary", "Send");
sendButton.type = "button";
sendButton.onclick = () => submitPrompt();

const stopButton = el("button", "danger", "Stop");
stopButton.type = "button";
stopButton.onclick = () => post({ type: "cancel" });

const attachButton = el("button", "ghost", "Attach");
attachButton.type = "button";
attachButton.onclick = () => post({ type: "attach" });

const queueButton = el("button", "ghost", "Queue");
queueButton.type = "button";
queueButton.title = "Run this after the current turn";
queueButton.onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  post({ type: "queuePrompt", text });
};

const steerButton = el("button", "ghost", "Steer");
steerButton.type = "button";
steerButton.title = "Inject guidance into the running turn";
steerButton.onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  post({ type: "steer", text });
};

const commandList = el("div", "command-list");
commandList.style.display = "none";

const composerRow = el("div", "composer-row");
composerRow.append(sendButton, stopButton, queueButton, steerButton, attachButton);
composer.append(commandList, input, composerRow);

/** Offer the agent's slash commands while the line starts with "/". */
input.oninput = () => {
  const value = input.value;
  const match = /^\/(\w*)$/.exec(value);
  if (!match || state.commands.length === 0) {
    commandList.style.display = "none";
    return;
  }
  const term = match[1].toLowerCase();
  const hits = state.commands.filter((c) => c.name.toLowerCase().startsWith(term));
  commandList.replaceChildren();
  if (hits.length === 0) {
    commandList.style.display = "none";
    return;
  }
  for (const command of hits) {
    const row = el("button", "command-row");
    row.append(el("span", "command-name", `/${command.name}`));
    if (command.description) row.append(el("span", "command-desc", command.description));
    row.onclick = () => {
      input.value = `/${command.name} `;
      commandList.style.display = "none";
      input.focus();
    };
    commandList.append(row);
  }
  commandList.style.display = "";
};

function submitPrompt(): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  commandList.style.display = "none";
  // Sending while busy queues instead of being silently dropped.
  post(state.busy ? { type: "queuePrompt", text } : { type: "prompt", text });
}

// --- rendering --------------------------------------------------------------

/**
 * Render agent text as Markdown.
 *
 * Every node here is built with `createElement` and filled with `textContent`.
 * Agent output is untrusted, so `innerHTML` must never appear in this file:
 * the parser hands back a tree precisely so nothing has to be turned into
 * markup text on the way to the DOM. Link targets are already restricted to
 * non-executable schemes by the parser.
 */
function renderText(text: string): HTMLElement {
  const wrap = el("div", "text");
  for (const node of parseMarkdown(text)) wrap.append(renderMdNode(node));
  return wrap;
}

function renderMdNode(node: MdNode): HTMLElement {
  switch (node.type) {
    case "heading": {
      const tag = `h${Math.min(6, Math.max(1, node.level))}` as "h1";
      const heading = el(tag, "md-heading");
      appendInline(heading, node.children);
      return heading;
    }
    case "paragraph": {
      const paragraph = el("p");
      appendInline(paragraph, node.children);
      return paragraph;
    }
    case "code":
      return renderCodeBlock(node.lang, node.text);
    case "hr":
      return el("hr", "md-rule");
    case "blockquote": {
      const quote = el("blockquote", "md-quote");
      for (const child of node.children) quote.append(renderMdNode(child));
      return quote;
    }
    case "list": {
      const list = el(node.ordered ? "ol" : "ul", "md-list");
      for (const item of node.items) {
        const entry = el("li");
        for (const child of item) entry.append(renderMdNode(child));
        list.append(entry);
      }
      return list;
    }
    case "table": {
      const table = el("table", "md-table");
      const head = el("thead");
      const headRow = el("tr");
      for (const cell of node.header) {
        const th = el("th");
        appendInline(th, cell);
        headRow.append(th);
      }
      head.append(headRow);
      const body = el("tbody");
      for (const row of node.rows) {
        const tr = el("tr");
        for (const cell of row) {
          const td = el("td");
          appendInline(td, cell);
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(head, body);
      // Wide tables scroll inside themselves rather than the whole panel.
      const scroller = el("div", "md-table-wrap");
      scroller.append(table);
      return scroller;
    }
  }
}

function appendInline(host: HTMLElement, nodes: Inline[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        host.append(document.createTextNode(node.text));
        break;
      case "code":
        host.append(el("code", "md-code", node.text));
        break;
      case "strong":
        host.append(wrapInline("strong", node.children));
        break;
      case "em":
        host.append(wrapInline("em", node.children));
        break;
      case "strike":
        host.append(wrapInline("s", node.children));
        break;
      case "link": {
        const anchor = el("a", "md-link");
        anchor.href = node.href;
        anchor.title = node.href;
        // Untrusted destination: never let it reach back into this window.
        anchor.rel = "noopener noreferrer";
        appendInline(anchor, node.children);
        host.append(anchor);
        break;
      }
    }
  }
}

function wrapInline(tag: "strong" | "em" | "s", children: Inline[]): HTMLElement {
  const node = el(tag);
  appendInline(node, children);
  return node;
}

function renderCodeBlock(lang: string, text: string): HTMLElement {
  const holder = el("div", "code-wrap");
  const pre = el("pre", "code");

  const tokens = highlight(text, lang);
  for (const token of tokens) {
    if (token.kind === "plain") pre.append(document.createTextNode(token.text));
    else pre.append(el("span", `tok-${token.kind}`, token.text));
  }

  const label = el("span", "code-lang", lang || "text");
  const copy = el("button", "copy", "Copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Copy ${lang || "code"} block`);
  copy.onclick = () => {
    void navigator.clipboard.writeText(text);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  };

  const bar = el("div", "code-bar");
  bar.append(label, copy);
  holder.append(bar, pre);
  return holder;
}

function renderDiff(block: Extract<Block, { kind: "diff" }>): HTMLElement {
  const details = el("details", "diff");
  details.append(el("summary", undefined, block.path));

  const body = el("div", "diff-body");
  const oldLines = block.oldText ? block.oldText.split("\n") : [];
  const newLines = block.newText.split("\n");

  for (const line of oldLines) body.append(el("div", "del", `- ${line}`));
  for (const line of newLines) body.append(el("div", "add", `+ ${line}`));

  details.append(body);
  return details;
}

function renderImage(block: Extract<Block, { kind: "image" }>): HTMLElement {
  const image = el("img", "content-image") as HTMLImageElement;
  image.src = `data:${block.mimeType};base64,${block.data}`;
  image.alt = "Image supplied by the agent";
  image.loading = "lazy";
  return image;
}

function renderAudio(block: Extract<Block, { kind: "audio" }>): HTMLElement {
  const audio = el("audio", "content-audio") as HTMLAudioElement;
  audio.controls = true;
  audio.src = `data:${block.mimeType};base64,${block.data}`;
  return audio;
}

function renderResource(block: Extract<Block, { kind: "resource" }>): HTMLElement {
  const details = el("details", "resource");
  details.append(el("summary", undefined, block.label));
  if (block.uri) details.append(el("div", "resource-uri", block.uri));
  if (block.text) details.append(el("pre", "code", block.text));
  return details;
}

const TOOL_STATUS_TEXT: Record<string, string> = {
  pending: "pending",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
};

function renderTool(block: Extract<Block, { kind: "tool" }>): HTMLElement {
  const { call } = block;
  const details = el("details", call.subAgent ? "tool sub-agent" : "tool");
  // A failed call is the one a user is looking for, so it opens itself.
  details.open = call.status === "failed";

  const summary = el("summary");
  const status = TOOL_STATUS_TEXT[call.status] ?? call.status;
  const dot = el("span", `dot ${call.status}`);
  // The dot carries meaning by colour alone, so name it for assistive tech.
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", status);
  summary.append(
    dot,
    el("span", "tool-kind", call.subAgent ? "sub-agent" : call.kind),
    el("span", "tool-title", call.title),
    el("span", "tool-status", status),
  );
  details.append(summary);

  if (call.input !== undefined) {
    details.append(toolSection("Input", jsonText(call.input), "json"));
  }
  if (call.output) {
    details.append(toolSection("Output", call.output, ""));
  }
  if (call.locations?.length) {
    const locations = el("div", "tool-locations");
    locations.setAttribute("aria-label", "Files this tool touched");
    for (const location of call.locations) {
      const label = location.line ? `${location.path}:${location.line}` : location.path;
      const button = el("button", "location-link", label);
      button.type = "button";
      button.title = "Open location in the workspace";
      button.onclick = () => post({ type: "openDiff", path: location.path, line: location.line });
      locations.append(button);
    }
    details.append(locations);
  }
  return details;
}

/** A labelled, copyable, highlighted chunk of tool input or output. */
function toolSection(label: string, text: string, lang: string): HTMLElement {
  const section = el("div", "tool-section");
  const heading = el("div", "tool-section-label", label);
  const block = renderCodeBlock(lang, text);
  block.classList.add("tool-code");
  section.append(heading, block);
  return section;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Cyclic or otherwise unserialisable input still has to show something.
    return String(value);
  }
}

function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case "text":
      return renderText(block.text);
    case "reasoning": {
      const details = el("details", "reasoning");
      details.append(el("summary", undefined, "Thinking"), renderText(block.text));
      return details;
    }
    case "image":
      return renderImage(block);
    case "audio":
      return renderAudio(block);
    case "resource":
      return renderResource(block);
    case "tool":
      return renderTool(block);
    case "diff":
      return renderDiff(block);
  }
}

function renderTurn(turn: Turn): HTMLElement {
  const node = el("div", `turn ${turn.role}`);
  for (const block of turn.blocks) node.append(renderBlock(block));
  return node;
}

function atBottom(): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function pinScroll(wasAtBottom: boolean): void {
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

function upsertTurn(turn: Turn): void {
  const wasAtBottom = atBottom();
  const fresh = renderTurn(turn);
  const existing = turnNodes.get(turn.id);

  if (existing) existing.replaceWith(fresh);
  else log.append(fresh);

  turnNodes.set(turn.id, fresh);
  pinScroll(wasAtBottom);
}

function renderAll(): void {
  log.replaceChildren();
  turnNodes.clear();
  for (const turn of state.turns) upsertTurn(turn);

  agentSelect.replaceChildren();
  for (const agent of state.agents) {
    const option = el("option", undefined, agent);
    option.value = agent;
    option.selected = agent === state.currentAgent;
    agentSelect.append(option);
  }

  renderSessions();
  renderOptions();
  renderPlan();
  renderQueue();
  forkButton.style.display = state.capabilities.forkSession ? "" : "none";
  attachButton.style.display =
    state.promptCapabilities.image || state.promptCapabilities.audio || state.promptCapabilities.embeddedContext ? "" : "none";
  renderUsage();
  applyBusy();
  renderPending(state.pending);
}

const LIFECYCLE_TEXT: Record<SessionLifecycle, string> = {
  idle: "idle",
  running: "running",
  "awaiting-approval": "needs you",
  error: "error",
  disconnected: "disconnected",
};

/**
 * A switcher across every conversation this window is running.
 *
 * Concurrency is only useful if a background turn is reachable, so each
 * conversation gets a chip carrying its status: one that needs the user is
 * marked as such rather than looking the same as one still working. The strip
 * stays hidden while there is nothing to switch between.
 */
function renderSessions(): void {
  sessionBar.replaceChildren();
  if (state.liveSessions.length < 2) {
    sessionBar.style.display = "none";
    return;
  }
  sessionBar.style.display = "";

  const chips: HTMLButtonElement[] = [];
  state.liveSessions.forEach((session, index) => {
    const chip = el("button", `session-chip ${session.active ? "active" : ""}`);
    chip.type = "button";
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(session.active));
    // Roving tabindex: one stop for the whole strip, arrows move within it.
    chip.tabIndex = session.active ? 0 : -1;

    chip.append(el("span", `session-dot ${session.lifecycle}`));
    chip.append(el("span", "session-title", session.title));
    if (session.queued > 0) chip.append(el("span", "session-badge", String(session.queued)));

    const description = `${session.agentKey} — ${LIFECYCLE_TEXT[session.lifecycle]}`;
    chip.title = description;
    // The dot and the badge are visual; the label spells them out.
    chip.setAttribute(
      "aria-label",
      `${session.title}, ${description}${session.queued > 0 ? `, ${session.queued} queued` : ""}`,
    );

    chip.onclick = () => post({ type: "revealSession", controllerId: session.controllerId });
    chip.onkeydown = (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = chips[(index + step + chips.length) % chips.length];
      next.focus();
      next.click();
    };

    chips.push(chip);
    sessionBar.append(chip);
  });
}

/**
 * Render whatever knobs the agent exposes. Nothing here is hard-coded to
 * "model" or "mode": an agent's own option list drives the UI.
 */
function renderOptions(): void {
  optionBar.replaceChildren();

  // Fall back to session modes when the agent exposes no config options.
  if (state.configOptions.length === 0 && state.modes.length > 0) {
    const select = el("select", "picker");
    for (const mode of state.modes) {
      const option = el("option", undefined, mode.name);
      option.value = mode.id;
      option.selected = mode.id === state.currentMode;
      select.append(option);
    }
    select.disabled = !state.capabilities.setSessionMode;
    select.onchange = () => post({ type: "selectMode", mode: select.value });
    optionBar.append(labelled("Mode", select));
    return;
  }

  for (const option of state.configOptions) {
    if (option.type === "boolean") {
      const box = el("input");
      box.type = "checkbox";
      box.checked = option.currentValue === true;
      box.onchange = () => post({ type: "setConfigOption", id: option.id, value: box.checked });
      optionBar.append(labelled(option.name, box));
      continue;
    }

    const select = el("select", "picker");
    for (const choice of option.options ?? []) {
      const node = el("option", undefined, choice.name);
      node.value = choice.value;
      node.selected = choice.value === option.currentValue;
      if (choice.description) node.title = choice.description;
      select.append(node);
    }
    select.disabled = (option.options ?? []).length < 2;
    select.onchange = () => post({ type: "setConfigOption", id: option.id, value: select.value });
    optionBar.append(labelled(option.name, select));
  }
}

function labelled(name: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "option");
  wrap.append(el("span", "option-name", name), control);
  return wrap;
}

function renderPlan(): void {
  planHost.replaceChildren();
  if (state.plan.length === 0) return;

  const done = state.plan.filter((entry) => entry.status === "completed").length;
  const details = el("details", "plan");
  details.open = done < state.plan.length;
  details.append(el("summary", undefined, `Plan — ${done}/${state.plan.length} done`));

  for (const entry of state.plan) {
    const row = el("div", `plan-row ${entry.status}`);
    const mark = entry.status === "completed" ? "\u2713" : entry.status === "in_progress" ? "\u2192" : "\u25cb";
    row.append(el("span", "plan-mark", mark), el("span", "plan-text", entry.content));
    details.append(row);
  }
  planHost.append(details);
}

function renderQueue(): void {
  queueHost.replaceChildren();
  if (state.queued.length === 0) return;

  const wrap = el("div", "queue");
  wrap.append(el("div", "queue-title", `Queued (${state.queued.length})`));
  state.queued.forEach((text, index) => {
    const row = el("div", "queue-row");
    row.append(el("span", "queue-text", text));
    const remove = el("button", "ghost", "\u00d7");
    remove.onclick = () => post({ type: "unqueuePrompt", index });
    row.append(remove);
    wrap.append(row);
  });
  queueHost.append(wrap);
}

function renderAttachments(): void {
  attachHost.replaceChildren();
  if (attachmentNames.length === 0) return;

  const wrap = el("div", "attachments");
  attachmentNames.forEach((name, index) => {
    const chip = el("span", "attach-chip");
    chip.append(el("span", undefined, name));
    const remove = el("button", "ghost", "\u00d7");
    remove.onclick = () => post({ type: "removeAttachment", index });
    chip.append(remove);
    wrap.append(chip);
  });
  attachHost.append(wrap);
}

function renderUsage(): void {
  if (!state.usage || state.usage.totalTokens === 0) {
    usageLabel.textContent = "";
    return;
  }
  const { totalTokens } = state.usage;
  const compact =
    totalTokens < 1000
      ? String(totalTokens)
      : totalTokens < 1_000_000
        ? `${(totalTokens / 1000).toFixed(1)}k`
        : `${(totalTokens / 1_000_000).toFixed(2)}M`;
  usageLabel.textContent = `${compact} tok`;
  usageLabel.title = `${state.usage.inputTokens} in / ${state.usage.outputTokens} out over ${state.usage.turns} turns`;
}

let lastAnnouncedBusy: boolean | undefined;

function applyBusy(): void {
  // The composer stays live while busy so prompts can be queued or steered.
  stopButton.style.display = state.busy ? "" : "none";
  steerButton.style.display = state.busy ? "" : "none";
  queueButton.style.display = state.busy ? "" : "none";
  sendButton.textContent = state.busy ? "Queue" : "Send";
  log.setAttribute("aria-busy", String(state.busy));

  // Announce the transition, not every render, or the status region repeats
  // itself on each token.
  if (lastAnnouncedBusy !== state.busy) {
    lastAnnouncedBusy = state.busy;
    announce(state.busy ? "Agent is working." : "Agent finished responding.");
  }
}

// --- pending requests -------------------------------------------------------

/**
 * Render a question form. Answers are collected keyed by question index as a
 * string, which is what the host expects to hand back to the agent.
 */
function renderQuestions(request: PendingRequest, questions: Question[]): HTMLElement {
  const card = el("div", "card");
  card.append(el("div", "card-title", request.title));

  const reads: (() => string)[] = [];
  const name = `q${Date.now()}`;

  questions.forEach((question, index) => {
    const group = el("div", "question");
    if (question.header) group.append(el("span", "chip", question.header));
    group.append(el("div", "question-text", question.question));

    const inputs: HTMLInputElement[] = [];
    const other = el("input", "other-input");
    other.type = "text";
    other.placeholder = "Your answer…";
    other.style.display = "none";

    const choices = [...question.options.map((o) => o.label), "Other…"];

    choices.forEach((label) => {
      const row = el("label", "choice");
      const box = el("input");
      box.type = question.multiSelect ? "checkbox" : "radio";
      box.name = `${name}-${index}`;
      box.value = label;
      box.onchange = () => {
        const otherPicked = inputs.some((i) => i.checked && i.value === "Other…");
        other.style.display = otherPicked ? "" : "none";
      };
      inputs.push(box);

      row.append(box, el("span", "choice-label", label));
      const description = question.options.find((o) => o.label === label)?.description;
      if (description) row.append(el("span", "choice-desc", description));
      group.append(row);
    });

    group.append(other);
    card.append(group);

    reads.push(() => {
      const picked = inputs.filter((i) => i.checked).map((i) => i.value);
      const resolved = picked.map((value) =>
        value === "Other…" ? other.value.trim() : value,
      );
      return resolved.filter(Boolean).join(", ");
    });
  });

  const submit = el("button", "primary", "Submit");
  const cancel = el("button", "ghost", "Cancel");

  const submitId = request.options.find((o) => o.kind.startsWith("allow"))?.optionId;
  const cancelId = request.options.find((o) => o.kind.startsWith("reject"))?.optionId;

  submit.onclick = () => {
    if (!submitId) return;
    const answers: Record<string, string> = {};
    reads.forEach((read, index) => {
      const value = read();
      if (value) answers[String(index)] = value;
    });
    post({ type: "respond", requestId: request.requestId, optionId: submitId, answers });
    renderPending(null);
  };

  cancel.onclick = () => {
    if (!cancelId) return;
    post({ type: "respond", requestId: request.requestId, optionId: cancelId });
    renderPending(null);
  };

  const actions = el("div", "card-actions");
  actions.append(submit, cancel);
  card.append(actions);
  return card;
}

function renderPermission(request: PendingRequest): HTMLElement {
  const card = el("div", "card");
  card.append(el("div", "card-title", request.title));
  for (const block of request.content ?? []) card.append(renderBlock(block));

  const actions = el("div", "card-actions");
  for (const option of request.options) {
    const button = el(
      "button",
      option.kind.startsWith("allow") ? "primary" : "ghost",
      option.name,
    );
    button.onclick = () => {
      post({ type: "respond", requestId: request.requestId, optionId: option.optionId });
      renderPending(null);
    };
    actions.append(button);
  }

  card.append(actions);
  return card;
}

function renderPending(request: PendingRequest | null): void {
  state.pending = request;
  pendingHost.replaceChildren();
  if (!request) return;

  pendingHost.append(
    request.questions?.length
      ? renderQuestions(request, request.questions)
      : renderPermission(request),
  );
  log.scrollTop = log.scrollHeight;
}

// --- host messages ----------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      Object.assign(state, message.state);
      renderAll();
      break;
    case "turn": {
      const index = state.turns.findIndex((t) => t.id === message.turn.id);
      if (index === -1) state.turns.push(message.turn);
      else state.turns[index] = message.turn;
      upsertTurn(message.turn);
      break;
    }
    case "turnDelta": {
      const turn = state.turns.find((t) => t.id === message.turnId);
      if (turn) {
        // Targeted write: never replace the whole list, or blocks the update
        // does not mention (an earlier tool call) would be erased.
        turn.blocks[message.index] = message.block;
        upsertTurn(turn);
      }
      break;
    }
    case "pending":
      renderPending(message.request);
      break;
    case "busy":
      state.busy = message.busy;
      applyBusy();
      break;
    case "configOptions":
      state.configOptions = message.options;
      renderOptions();
      break;
    case "commands":
      state.commands = message.commands;
      break;
    case "plan":
      state.plan = message.plan;
      renderPlan();
      break;
    case "queued":
      state.queued = message.queued;
      renderQueue();
      break;
    case "attachments":
      attachmentNames = message.names;
      renderAttachments();
      break;
    case "usage":
      state.usage = message.usage;
      renderUsage();
      break;
    case "revealTurn": {
      const node = turnNodes.get(message.turnId);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
        // Brief highlight so the eye lands on the right turn.
        node.classList.add("revealed");
        setTimeout(() => node.classList.remove("revealed"), 1200);
      }
      break;
    }
    case "error": {
      const banner = el("div", "error", message.message);
      banner.setAttribute("role", "alert");
      announce(message.message);
      log.append(banner);
      log.scrollTop = log.scrollHeight;
      break;
    }
  }
});

post({ type: "ready" });
