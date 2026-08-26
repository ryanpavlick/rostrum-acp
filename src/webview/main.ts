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
root.append(header, sessionBar, optionBar, log, planHost, pendingHost, queueHost, attachHost, composer);

const agentSelect = el("select", "picker");
agentSelect.onchange = () => post({ type: "selectAgent", agent: agentSelect.value });


const newButton = el("button", "ghost", "New");
newButton.onclick = () => post({ type: "newSession" });

const historyButton = el("button", "ghost", "History");
historyButton.title = "Open a saved session";
historyButton.onclick = () => post({ type: "pickSession" });

const forkButton = el("button", "ghost", "Fork");
forkButton.title = "Branch this conversation";
forkButton.onclick = () => post({ type: "forkSession" });

const usageLabel = el("span", "usage");

header.append(agentSelect, newButton, historyButton, forkButton, usageLabel);

const input = el("textarea", "input");
input.rows = 3;
input.placeholder = "Ask the agent…";
input.onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
};

const sendButton = el("button", "primary", "Send");
sendButton.onclick = () => submitPrompt();

const stopButton = el("button", "danger", "Stop");
stopButton.onclick = () => post({ type: "cancel" });

const attachButton = el("button", "ghost", "Attach");
attachButton.onclick = () => post({ type: "attach" });

const queueButton = el("button", "ghost", "Queue");
queueButton.title = "Run this after the current turn";
queueButton.onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  post({ type: "queuePrompt", text });
};

const steerButton = el("button", "ghost", "Steer");
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
 * Minimal markdown: fenced code blocks become <pre>, everything else is
 * paragraphs. Deliberately not a full parser — this text is untrusted.
 */
function renderText(text: string): HTMLElement {
  const wrap = el("div", "text");
  const segments = text.split(/```/);

  segments.forEach((segment, index) => {
    if (!segment) return;
    if (index % 2 === 1) {
      const pre = el("pre", "code");
      // Drop a leading language tag, keep the body verbatim.
      pre.textContent = segment.replace(/^[a-zA-Z0-9_-]*\n/, "");
      const copy = el("button", "copy", "Copy");
      copy.onclick = () => void navigator.clipboard.writeText(pre.textContent ?? "");
      const holder = el("div", "code-wrap");
      holder.append(copy, pre);
      wrap.append(holder);
    } else {
      for (const paragraph of segment.split(/\n{2,}/)) {
        if (paragraph.trim()) wrap.append(el("p", undefined, paragraph.trim()));
      }
    }
  });

  return wrap;
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

function renderTool(block: Extract<Block, { kind: "tool" }>): HTMLElement {
  const { call } = block;
  const details = el("details", call.subAgent ? "tool sub-agent" : "tool");
  const summary = el("summary");
  summary.append(
    el("span", `dot ${call.status}`),
    el("span", "tool-kind", call.subAgent ? "sub-agent" : call.kind),
    el("span", "tool-title", call.title),
  );
  details.append(summary);

  if (call.input !== undefined) {
    details.append(el("pre", "code", JSON.stringify(call.input, null, 2)));
  }
  if (call.output) {
    details.append(el("pre", "code", call.output));
  }
  if (call.locations?.length) {
    const locations = el("div", "tool-locations");
    for (const location of call.locations) {
      const label = location.line ? `${location.path}:${location.line}` : location.path;
      const button = el("button", "location-link", label);
      button.title = "Open location in the workspace";
      button.onclick = () => post({ type: "openDiff", path: location.path, line: location.line });
      locations.append(button);
    }
    details.append(locations);
  }
  return details;
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

  for (const session of state.liveSessions) {
    const chip = el("button", `session-chip ${session.active ? "active" : ""}`);
    chip.append(el("span", `session-dot ${session.lifecycle}`));
    chip.append(el("span", "session-title", session.title));
    if (session.queued > 0) chip.append(el("span", "session-badge", String(session.queued)));
    chip.title = `${session.agentKey} — ${LIFECYCLE_TEXT[session.lifecycle]}`;
    chip.disabled = session.active;
    chip.onclick = () => post({ type: "revealSession", controllerId: session.controllerId });
    sessionBar.append(chip);
  }
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

function applyBusy(): void {
  // The composer stays live while busy so prompts can be queued or steered.
  stopButton.style.display = state.busy ? "" : "none";
  steerButton.style.display = state.busy ? "" : "none";
  queueButton.style.display = state.busy ? "" : "none";
  sendButton.textContent = state.busy ? "Queue" : "Send";
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
      log.append(banner);
      log.scrollTop = log.scrollHeight;
      break;
    }
  }
});

post({ type: "ready" });
