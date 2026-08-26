import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  Agent,
  Client,
  ContentBlock,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCallContent,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
  Block,
  ConfigOption,
  ModeOption,
  PlanEntry,
  SlashCommand,
  PendingRequest,
  PermissionOption,
  Question,
  ToolCall,
  ToolStatus,
  Turn,
} from "../shared/protocol.js";
import { detectQuestions, encodeAnswers, type DetectedQuestions } from "./questions.js";
import { TerminalRegistry } from "./terminals.js";

export type PermissionMode = "ask" | "acceptEdits" | "yolo";

export interface SessionEvents {
  onTurn(turn: Turn): void;
  onTurnDelta(turnId: string, index: number, block: Block): void;
  onPending(request: PendingRequest | null): void;
  onModes(modes: ModeOption[], current: string | null): void;
  onError(message: string): void;
  onCommands?(commands: SlashCommand[]): void;
  /**
   * An agent asking for structured input outside a tool permission.
   * Reuses the question widget; resolve with the chosen values.
   */
  onElicit?(request: PendingRequest, resolve: (answers?: Record<string, string>) => void): void;
  onPlan?(plan: PlanEntry[]): void;
  /** Full option set sent by an agent after an autonomous config change. */
  onConfigOptions?(options: unknown): void;
  /** Fired for each file the agent reports editing, including a diff when ACP supplies one. */
  onFileEdited?(edit: { path: string; oldText?: string; newText?: string; toolCallId?: string }): void;
}

interface Resolver {
  detected?: DetectedQuestions;
  options: PermissionOption[];
  resolve(response: RequestPermissionResponse): void;
}

/**
 * ACP carries no parent/child linkage between tool calls, so a delegating call
 * can only be recognised by its name. These are the names the common agents
 * use for spawning a sub-agent.
 */
const SUB_AGENT_TOOLS = new Set([
  "task",
  "agent",
  "subagent",
  "sub_agent",
  "dispatch_agent",
  "run_agent",
  "delegate",
]);

export function isSubAgentCall(name: string | undefined, kind: string): boolean {
  if (kind === "think") return false;
  if (!name) return false;
  return SUB_AGENT_TOOLS.has(name.toLowerCase().replace(/[\s-]/g, "_"));
}

function textOf(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

/** Preserve every standard ACP content block instead of silently dropping media and resources. */
export function displayBlocks(content: ContentBlock): Block[] {
  if (content.type === "text") return content.text ? [{ kind: "text", text: content.text }] : [];
  if (content.type === "image") {
    return [{ kind: "image", mimeType: content.mimeType, data: content.data }];
  }
  if (content.type === "audio") {
    return [{ kind: "audio", mimeType: content.mimeType, data: content.data }];
  }
  if (content.type === "resource") {
    const resource = content.resource as { uri?: string; mimeType?: string; text?: string };
    return [{
      kind: "resource",
      label: resource.uri?.split("/").pop() || "Embedded resource",
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: resource.text,
    }];
  }
  return [{
    kind: "resource",
    label: content.name || "Resource link",
    uri: content.uri,
    mimeType: content.mimeType ?? undefined,
  }];
}

/**
 * Owns one ACP conversation: translates `session/update` notifications into
 * renderable turns, and brokers permission requests to the UI.
 *
 * Implements the ACP `Client` interface, so it is what the agent calls back
 * into.
 */
export class Session implements Client {
  private turns: Turn[] = [];
  private assistantTurn: Turn | null = null;
  private readonly toolCalls = new Map<string, ToolCall>();
  /** Where each tool call sits in its turn, so updates target it directly. */
  private readonly toolBlockIndex = new Map<string, number>();
  /** Content notifications can be repeated; render each immutable item once. */
  private readonly renderedToolContent = new Set<string>();
  private readonly pendingResolvers = new Map<string, Resolver>();
  private readonly terminals = new TerminalRegistry();
  private readonly workspaceRoots: string[];

  sessionId: string | null = null;
  modes: ModeOption[] = [];
  currentMode: string | null = null;

  constructor(
    private readonly events: SessionEvents,
    workspaceRoots: string | readonly string[],
    private permissionMode: PermissionMode,
  ) {
    this.workspaceRoots = (typeof workspaceRoots === "string" ? [workspaceRoots] : [...workspaceRoots])
      .map((root) => path.resolve(root));
  }

  getTurns(): Turn[] {
    return this.turns;
  }

  /** Distinct tool calls seen so far, for per-turn usage accounting. */
  toolCallCount(): number {
    return this.toolCalls.size;
  }

  setTurns(turns: Turn[]): void {
    this.turns = turns;
    this.assistantTurn = null;
    this.toolCalls.clear();
    this.toolBlockIndex.clear();
    this.renderedToolContent.clear();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Record a user turn locally; the agent echoes nothing back for prompts. */
  addUserTurn(text: string, attachments: Block[] = []): void {
    const turn: Turn = {
      id: randomUUID(),
      role: "user",
      blocks: [{ kind: "text", text }, ...attachments],
    };
    this.turns.push(turn);
    this.events.onTurn(turn);
    // The next agent output belongs to a fresh assistant turn.
    this.assistantTurn = null;
  }

  // --- ACP Client implementation ------------------------------------------

  async sessionUpdate({ update }: SessionNotification): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendContent("text", update.content);
        break;
      case "agent_thought_chunk":
        this.appendContent("reasoning", update.content);
        break;
      case "tool_call":
      case "tool_call_update":
        this.applyToolCall(update);
        break;
      case "current_mode_update":
        this.currentMode = update.currentModeId;
        this.events.onModes(this.modes, this.currentMode);
        break;
      case "available_commands_update":
        this.events.onCommands?.(
          update.availableCommands.map((command) => ({
            name: command.name,
            description: command.description ?? undefined,
            hint: command.input?.hint ?? undefined,
          })),
        );
        break;
      case "plan":
        this.events.onPlan?.(
          update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status as PlanEntry["status"],
            priority: entry.priority ?? undefined,
          })),
        );
        break;
      case "config_option_update":
        this.events.onConfigOptions?.(update.configOptions);
        break;
      default:
        // user_message_chunk is echoed back during replay; the transcript
        // already holds it.
        break;
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const options: PermissionOption[] = params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));

    const detected = detectQuestions(params);

    // Auto-approval must never swallow a question: doing so returns no answers
    // and the agent proceeds on nothing. Questions always reach the user.
    if (!detected) {
      const auto = this.autoDecision(params, options);
      if (auto) return { outcome: { outcome: "selected", optionId: auto } };
    }

    const requestId = randomUUID();
    const pending: PendingRequest = {
      requestId,
      title: params.toolCall?.title ?? "Permission required",
      questions: detected?.questions,
      options,
      content: this.permissionContent(params),
    };

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingResolvers.set(requestId, { detected, options, resolve });
      this.events.onPending(pending);
    });
  }

  /** Called by the view when the user answers a pending request. */
  respond(requestId: string, optionId: string, answers?: Record<string, string>): void {
    const resolver = this.pendingResolvers.get(requestId);
    if (!resolver) return;
    this.pendingResolvers.delete(requestId);

    const extra =
      resolver.detected && answers
        ? encodeAnswers(resolver.detected.encoding, resolver.detected.questions, answers)
        : {};

    resolver.resolve({
      outcome: { outcome: "selected", optionId },
      ...extra,
    } as RequestPermissionResponse);
    this.events.onPending(null);
  }

  /** Resolve every outstanding prompt as cancelled (turn aborted, agent died). */
  cancelPending(): void {
    for (const [, resolver] of this.pendingResolvers) {
      resolver.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingResolvers.clear();
    this.events.onPending(null);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    const content = await fs.readFile(await this.resolve(params.path), "utf8");
    if (params.line == null && params.limit == null) return { content };

    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit == null ? lines.length : start + params.limit;
    return { content: lines.slice(start, end).join("\n") };
  }

  // --- terminals -----------------------------------------------------------

  async createTerminal(params: {
    command: string;
    args?: string[] | null;
    cwd?: string | null;
    env?: { name: string; value: string }[] | null;
    outputByteLimit?: number | null;
  }): Promise<{ terminalId: string }> {
    // Confine the agent's shell to the workspace unless it names a path we
    // have already validated.
    const cwd = params.cwd ? await this.resolve(params.cwd) : await this.resolve(".");
    return { terminalId: this.terminals.create({ ...params, cwd }) };
  }

  async terminalOutput(params: { terminalId: string }) {
    return this.terminals.output(params.terminalId);
  }

  async waitForTerminalExit(params: { terminalId: string }) {
    // The response is flat: exitCode/signal, not a nested exitStatus.
    const { exitCode, signal } = await this.terminals.waitForExit(params.terminalId);
    return { exitCode, signal };
  }

  async killTerminal(params: { terminalId: string }): Promise<void> {
    this.terminals.kill(params.terminalId);
  }

  async releaseTerminal(params: { terminalId: string }): Promise<void> {
    this.terminals.release(params.terminalId);
  }

  /** Free every child process when the session ends. */
  dispose(): void {
    this.terminals.disposeAll();
    this.cancelPending();
  }

  // --- elicitation ---------------------------------------------------------

  /**
   * `session/elicit` asks the user for input without a tool call behind it.
   * Present it with the same widget as a question-style permission request.
   */
  async createElicitation(params: {
    message?: string | null;
    requestedSchema?: unknown;
    _meta?: Record<string, unknown> | null;
  }): Promise<{ action: string; content?: Record<string, string> }> {
    const questions = elicitationQuestions(params.requestedSchema);
    if (!this.events.onElicit || questions.length === 0) {
      return { action: "decline" };
    }

    const requestId = randomUUID();
    const answers = await new Promise<Record<string, string> | undefined>((resolve) => {
      this.events.onElicit?.(
        {
          requestId,
          title: params.message ?? "The agent needs some information",
          questions,
          options: [
            { optionId: "accept", name: "Submit", kind: "allow_once" },
            { optionId: "decline", name: "Cancel", kind: "reject_once" },
          ],
        },
        resolve,
      );
    });

    if (!answers) return { action: "cancel" };

    // Re-key by field name: the widget answers by question index.
    const content: Record<string, string> = {};
    questions.forEach((question, index) => {
      const value = answers[String(index)];
      if (value) content[question.header ?? String(index)] = value;
    });
    return { action: "accept", content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<void> {
    const target = await this.resolve(params.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, params.content, "utf8");
  }

  // --- internals -----------------------------------------------------------

  /**
   * Reject paths that escape the workspace, whatever the agent claims.
   *
   * Must resolve `..` and compare on a separator boundary: a bare prefix test
   * lets `/work-evil` pass for root `/work`.
   */
  private async resolve(candidate: string): Promise<string> {
    const primaryRoot = this.workspaceRoots[0] ?? process.cwd();
    const target = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(primaryRoot, candidate);
    // Check every workspace root, longest first in case roots are nested.
    const lexicalRoot = [...this.workspaceRoots]
      .sort((a, b) => b.length - a.length)
      .find((root) => target === root || target.startsWith(root + path.sep));
    if (!lexicalRoot) {
      throw new Error(`Refusing to access path outside the workspace: ${candidate}`);
    }

    // The lexical guard above rejects `..` and prefix escapes. Resolve the
    // nearest existing parent as well, so a symlink inside the workspace
    // cannot silently redirect a read, write, or terminal outside it.
    const realRoot = await fs.realpath(lexicalRoot).catch(() => lexicalRoot);
    const realTarget = await this.realPathWithMissingTail(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error(`Refusing to access path outside the workspace: ${candidate}`);
    }
    return realTarget;
  }

  /** Resolve the existing prefix of a prospective write without requiring its leaf to exist. */
  private async realPathWithMissingTail(target: string): Promise<string> {
    const missing: string[] = [];
    let existing = target;
    while (true) {
      try {
        const real = await fs.realpath(existing);
        return path.join(real, ...missing);
      } catch (error: unknown) {
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
  }

  private autoDecision(
    params: RequestPermissionRequest,
    options: PermissionOption[],
  ): string | undefined {
    if (this.permissionMode === "ask") return undefined;

    const allow = options.find((option) => option.kind === "allow_once")?.optionId;
    if (!allow) return undefined;

    if (this.permissionMode === "yolo") return allow;

    // acceptEdits: auto-allow file edits only, still ask for anything else.
    return params.toolCall?.kind === "edit" ? allow : undefined;
  }

  private permissionContent(params: RequestPermissionRequest): Block[] {
    return (params.toolCall?.content ?? []).flatMap((entry) =>
      this.toolContentToBlocks(entry),
    );
  }

  private toolContentToBlocks(entry: ToolCallContent, toolCallId?: string): Block[] {
    if (entry.type === "content") {
      return displayBlocks(entry.content);
    }
    if (entry.type === "diff") {
      this.events.onFileEdited?.({
        path: entry.path,
        oldText: entry.oldText ?? undefined,
        newText: entry.newText,
        toolCallId,
      });
      return [
        {
          kind: "diff",
          path: entry.path,
          oldText: entry.oldText ?? "",
          newText: entry.newText,
        },
      ];
    }
    return [];
  }

  private ensureAssistantTurn(): Turn {
    if (!this.assistantTurn) {
      this.assistantTurn = { id: randomUUID(), role: "assistant", blocks: [] };
      this.turns.push(this.assistantTurn);
      this.events.onTurn(this.assistantTurn);
    }
    return this.assistantTurn;
  }

  /**
   * Append streamed text, coalescing into the trailing block of the same kind
   * so a token stream does not become thousands of blocks.
   */
  private appendText(kind: "text" | "reasoning", text: string): void {
    if (!text) return;
    const turn = this.ensureAssistantTurn();
    const last = turn.blocks.at(-1);

    if (last && last.kind === kind) {
      last.text += text;
      this.events.onTurnDelta(turn.id, turn.blocks.length - 1, last);
      return;
    }

    const block: Block = { kind, text };
    turn.blocks.push(block);
    this.events.onTurnDelta(turn.id, turn.blocks.length - 1, block);
  }

  private appendContent(kind: "text" | "reasoning", content: ContentBlock): void {
    const text = textOf(content);
    if (text) {
      this.appendText(kind, text);
      return;
    }
    const turn = this.ensureAssistantTurn();
    for (const block of displayBlocks(content)) {
      // There is no meaningful "reasoning image" representation; standard
      // content remains visible as-is rather than being discarded.
      turn.blocks.push(block);
      this.events.onTurnDelta(turn.id, turn.blocks.length - 1, block);
    }
  }

  private applyToolCall(update: {
    toolCallId: string;
    title?: string | null;
    kind?: string | null;
    status?: string | null;
    content?: ToolCallContent[] | null;
    locations?: { path: string; line?: number | null }[] | null;
    rawInput?: unknown;
    _meta?: { [key: string]: unknown } | null;
  }): void {
    const turn = this.ensureAssistantTurn();
    let call = this.toolCalls.get(update.toolCallId);

    if (!call) {
      call = {
        id: update.toolCallId,
        title: update.title ?? "Tool call",
        kind: update.kind ?? "other",
        status: (update.status as ToolStatus | undefined) ?? "pending",
      };
      const toolName =
        typeof update._meta?.toolName === "string" ? update._meta.toolName : undefined;
      if (isSubAgentCall(toolName ?? update.title ?? undefined, call.kind)) {
        call.subAgent = true;
      }
      this.toolCalls.set(update.toolCallId, call);
      turn.blocks.push({ kind: "tool", call });
      this.toolBlockIndex.set(update.toolCallId, turn.blocks.length - 1);
    }

    if (update.title) call.title = update.title;
    if (update.kind) call.kind = update.kind;
    if (update.status) call.status = update.status as ToolStatus;
    if (update.rawInput !== undefined) call.input = update.rawInput;
    if (update.locations) {
      call.locations = update.locations.map((location) => ({
        path: location.path,
        line: location.line ?? undefined,
      }));
      // An edit tool reporting a location is an edit to that file.
      if (call.kind === "edit" && call.status === "completed") {
        for (const location of call.locations) this.events.onFileEdited?.({
          path: location.path,
          toolCallId: call.id,
        });
      }
    }

    // Fall back to the agent's `_meta.toolName` when no title was supplied.
    const metaName = update._meta?.toolName;
    if (typeof metaName === "string" && call.title === "Tool call") {
      call.title = metaName;
    }

    if (update.content?.length) {
      const text = update.content
        .flatMap((entry) => entry.type === "content" ? displayBlocks(entry.content) : [])
        .flatMap((block) => {
          if (block.kind === "text") return [block.text];
          if (block.kind === "resource" && block.text) return [block.text];
          return [];
        })
        .join("\n");
      if (text) call.output = (call.output ?? "") + text;

      // Surface non-text results (diffs, media, resources) inline. Text stays
      // inside the collapsible tool card, avoiding duplicated tool output.
      for (const entry of update.content) {
        for (const block of this.toolContentToBlocks(entry, call.id)) {
          if (block.kind === "text" || block.kind === "reasoning" || block.kind === "tool") continue;
          const key = `${call.id}:${stableBlockKey(block)}`;
          if (this.renderedToolContent.has(key)) continue;
          this.renderedToolContent.add(key);
          turn.blocks.push(block);
          this.events.onTurnDelta(turn.id, turn.blocks.length - 1, block);
        }
      }
    }

    const index = this.toolBlockIndex.get(update.toolCallId);
    if (index !== undefined) {
      this.events.onTurnDelta(turn.id, index, { kind: "tool", call });
    }
  }
}

function stableBlockKey(block: Exclude<Block, { kind: "text" } | { kind: "reasoning" } | { kind: "tool" }>): string {
  switch (block.kind) {
    case "diff": return `diff:${block.path}:${block.oldText}:${block.newText}`;
    case "image": return `image:${block.mimeType}:${block.data}`;
    case "audio": return `audio:${block.mimeType}:${block.data}`;
    case "resource": return `resource:${block.uri ?? ""}:${block.mimeType ?? ""}:${block.text ?? ""}`;
  }
}

/** Drive one prompt to completion, reporting the stop reason. */
export async function runPrompt(
  agent: Agent,
  sessionId: string,
  text: string,
): Promise<string> {
  const response = await agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  });
  return response.stopReason;
}

/**
 * Translate an elicitation's JSON schema into questions.
 *
 * Enum fields become choices; everything else becomes a free-text field, which
 * the widget already offers through its "Other…" option.
 */
function elicitationQuestions(schema: unknown): Question[] {
  const root = schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const properties = root?.properties;
  if (!properties) return [];

  return Object.entries(properties).map(([name, raw]) => {
    const field = raw as { description?: string; title?: string; enum?: unknown[] };
    const choices = Array.isArray(field.enum) ? field.enum.map(String) : [];
    return {
      header: name,
      question: field.title ?? field.description ?? name,
      options: choices.map((value) => ({ label: value })),
      multiSelect: false,
    };
  });
}
