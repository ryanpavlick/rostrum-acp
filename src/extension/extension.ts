import * as path from "node:path";
import * as vscode from "vscode";
import { managerLogs, managerStateFile, managerStatus, managerStop } from "./agentProcess.js";
import { ChatViewProvider } from "./chatView.js";
import { AgentDiffProvider } from "./diffs.js";
import {
  KNOWN_AGENTS,
  detectAgents,
  mergeProfiles,
  nodeProbe,
  registryProfiles,
  type DetectedAgent,
} from "./discovery.js";
import {
  TIME_WINDOWS,
  agentsIn,
  describeFilter,
  isFiltered,
  type TimelineFilter,
  type TimeWindow,
} from "./timeline.js";
import { formatForPath, serializeTranscript } from "./export.js";
import { ChangeHistory } from "./history.js";
import { STATE_TEXT } from "./ledger.js";
import { migrateLegacySettings } from "./migrate.js";
import { availability, fetchRegistry, settingsKey, toDefinition } from "./registry.js";
import { SessionStore } from "./store.js";
import { ChangedFilesTree, OutlineTree, SessionsTree, TimelineTree, UsageStatsTree } from "./trees.js";
import { UsageTracker } from "./usage.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Rostrum");

  void migrateLegacySettings(context).then((moved) => {
    if (moved.length === 0) return;
    output.appendLine(`Migrated settings from openacp.*: ${moved.join(", ")}`);
    void vscode.window.showInformationMessage(
      `Rostrum carried over your previous settings (${moved.join(", ")}).`,
    );
  });
  const storage = context.globalStorageUri.fsPath;

  const store = new SessionStore(path.join(storage, "sessions"));
  const history = new ChangeHistory(path.join(storage, "changes.jsonl"));
  const usage = new UsageTracker(path.join(storage, "usage.json"));
  const diffs = new AgentDiffProvider();

  const sessions = new SessionsTree(store);
  const changes = new ChangedFilesTree(history);
  const timeline = new TimelineTree(history);
  const outline = new OutlineTree();
  const usageView = new UsageStatsTree(usage);

  const chat = new ChatViewProvider(
    context,
    store,
    output,
    (edit, sessionId, agentKey) => {
      void history
        .record({ ...edit, path: normaliseEditPath(edit.path), sessionId, agentKey, at: Date.now() })
        .then(() => {
          changes.refresh();
          timeline.refresh();
        });
    },
    usage,
    (turns) => outline.update(turns),
    () => sessions.refresh(),
  );

  sessions.setLiveSource(() => chat.liveSessions());
  changes.setRoots(() => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []);

  /** Drives the `when` clauses that swap the Changes view's mode button. */
  const applyChangesMode = (grouped: boolean) => {
    changes.setGrouped(grouped);
    void vscode.commands.executeCommand("setContext", "rostrum.changesGrouped", grouped);
  };
  applyChangesMode(false);

  void history.load().then(() => {
    changes.refresh();
    timeline.refresh();
  });

  // `npm run demo` opens a window to be photographed. Gated on an environment

  // variable that only that script sets, so a real install can never reach it.

  if (process.env.ROSTRUM_DEMO === "1") {

    void (async () => {

      await vscode.commands.executeCommand("rostrum.chatView.focus");

      await new Promise((resolve) => setTimeout(resolve, 1200));

      try {

        await chat.demoBootstrap(

          process.env.ROSTRUM_DEMO_AGENT ?? "Demo Agent",

          process.env.ROSTRUM_DEMO_PROMPT ?? "Bound the transcript so long sessions stay fast.",

        );

      } catch (error) {

        output.appendLine(`Demo bootstrap failed: ${String(error)}`);

      }

    })();

  }


  context.subscriptions.push(
    output,
    chat,
    diffs,
    vscode.window.registerWebviewViewProvider("rostrum.chatView", chat),
    vscode.window.registerTreeDataProvider("rostrum.sessionsView", sessions),
    vscode.window.registerTreeDataProvider("rostrum.changedFilesView", changes),
    vscode.window.registerTreeDataProvider("rostrum.usageStatsView", usageView),
    vscode.window.registerTreeDataProvider("rostrum.outlineView", outline),
    vscode.window.registerTreeDataProvider("rostrum.timelineView", timeline),

    vscode.commands.registerCommand("rostrum.revealTurn", (turnId: string) => {
      chat.revealTurn(turnId);
    }),

    vscode.commands.registerCommand("rostrum.cancel", () => chat.cancel()),

    vscode.commands.registerCommand("rostrum.pickSession", () => chat.pickSession()),

    vscode.commands.registerCommand("rostrum.searchSessions", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search saved session transcripts",
        placeHolder: "Text, reasoning, tool output, or a changed-file path",
      });
      if (!query?.trim()) return;
      const results = await store.search(query);
      const picked = await vscode.window.showQuickPick(
        results.map((result) => ({
          label: result.title,
          description: result.agentKey,
          detail: result.excerpt,
          sessionId: result.sessionId,
        })),
        { placeHolder: results.length ? `${results.length} matching session${results.length === 1 ? "" : "s"}` : "No matching saved sessions" },
      );
      if (picked) await chat.loadSessionById(picked.sessionId);
    }),

    vscode.commands.registerCommand("rostrum.retryRecovery", async () => {
      const waiting = chat.recoverySessions();
      if (waiting.length === 0) {
        void vscode.window.showInformationMessage("No Rostrum sessions are waiting for recovery.");
        return;
      }
      const restored = await chat.retryRecovery();
      void vscode.window.showInformationMessage(
        `Recovered ${restored} of ${waiting.length} session${waiting.length === 1 ? "" : "s"}.`,
      );
    }),

    vscode.commands.registerCommand("rostrum.agentDiagnostics", async () => {
      const rows = chat.diagnostics();
      if (rows.length === 0) {
        void vscode.window.showInformationMessage("Start an agent to see Rostrum diagnostics.");
        return;
      }
      output.appendLine("\nRostrum agent diagnostics:");
      for (const row of rows) {
        const caps = Object.entries(row.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none";
        const prompt = Object.entries(row.promptCapabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "text";
        const mcp = Object.entries(row.mcpCapabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none";
        const methods = Object.entries(row.methods).filter(([, present]) => present).map(([name]) => name).join(", ") || "none";
        output.appendLine(
          `  ${row.agentKey}: ${row.alive ? "alive" : "disconnected"}, ${row.persistent ? "supervised" : "direct"}, ` +
          `${row.sessions} session(s), catalog ${row.lastCatalogSync ? new Date(row.lastCatalogSync).toLocaleString() : "not synced"}`,
        );
        output.appendLine(`    protocol: ${row.protocolVersion ?? "unknown"}`);
        output.appendLine(`    session capabilities: ${caps}`);
        output.appendLine(`    prompt content: ${prompt}`);
        output.appendLine(`    MCP transports: ${mcp}`);
        output.appendLine(`    methods present: ${methods}`);

        // What it claimed, set against what it has actually managed. A
        // declaration is not evidence, and this is the line worth pasting
        // into a compatibility report.
        output.appendLine("    observed:");
        for (const entry of row.observed) {
          const counts =
            entry.attempts === 0
              ? ""
              : ` (${entry.attempts - entry.failures}/${entry.attempts} succeeded)`;
          const why = entry.lastError ? ` — last error: ${entry.lastError}` : "";
          output.appendLine(`      ${entry.method}: ${STATE_TEXT[entry.state]}${counts}${why}`);
        }
      }
      output.show(true);
    }),

    vscode.commands.registerCommand("rostrum.openHistoryDiff", (edit) => diffs.open(edit)),

    // Sweep on a coarse timer: idle windows are measured in minutes, so a
    // minute of granularity is ample and costs nothing when nothing is stale.
    new vscode.Disposable((() => {
      const timer = setInterval(() => void chat.sweepIdleSessions(), 60_000);
      return () => clearInterval(timer);
    })()),

    vscode.commands.registerCommand("rostrum.openLastEditForFile", async (resource?: vscode.Uri) => {
      const target = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage("Open a file to see the last agent edit for it.");
        return;
      }
      const edit = history.lastTouchedBy(target.fsPath);
      if (!edit) {
        void vscode.window.showInformationMessage(
          `No agent has edited ${path.basename(target.fsPath)} in a recorded session.`,
        );
        return;
      }
      await diffs.open(edit);
    }),

    vscode.commands.registerCommand("rostrum.newSessionInDirectory", () =>
      chat.newSessionInDirectory(),
    ),

    vscode.commands.registerCommand("rostrum.copySessionId", async () => {
      // The agent's own id, not the controller id: this is for pasting into a
      // bug report or the agent's CLI, where only the protocol id means anything.
      const live = chat.liveSessions();
      const active = live.find((session) => session.active) ?? live[0];
      if (!active?.sessionId) {
        void vscode.window.showWarningMessage("No live Rostrum session to copy an id from.");
        return;
      }
      await vscode.env.clipboard.writeText(active.sessionId);
      void vscode.window.showInformationMessage(`Copied session id for ${active.title}.`);
    }),

    vscode.commands.registerCommand("rostrum.compareWithCurrent", (edit) =>
      diffs.compareWithCurrent(edit),
    ),

    vscode.commands.registerCommand("rostrum.openFileDiff", async (file) => {
      if (file?.edits) {
        await diffs.openFile(file);
        return;
      }
      // Invoked from the palette with nothing selected: pick a file first.
      await history.load();
      const picked = await vscode.window.showQuickPick(
        history.files().map((entry) => ({
          label: path.basename(entry.path),
          description: entry.path,
          detail: `${entry.edits.length} edit${entry.edits.length === 1 ? "" : "s"}`,
          entry,
        })),
        { placeHolder: "Show all agent changes to which file?" },
      );
      if (picked) await diffs.openFile(picked.entry);
    }),

    vscode.commands.registerCommand("rostrum.nextEdit", () => diffs.step("newer")),
    vscode.commands.registerCommand("rostrum.previousEdit", () => diffs.step("older")),

    vscode.commands.registerCommand("rostrum.openDiff", async (filePath?: string) => {
      if (typeof filePath === "string") {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
        return;
      }
      await history.load();
      const picked = await vscode.window.showQuickPick(
        history.files().map((file) => ({
          label: path.basename(file.path),
          description: file.path,
          edit: file.edits[0],
        })),
        { placeHolder: "Open a saved agent edit" },
      );
      if (picked?.edit) await vscode.commands.executeCommand("rostrum.openHistoryDiff", picked.edit);
    }),

    vscode.commands.registerCommand("rostrum.newSession", async () => {
      await chat.newSession();
      sessions.refresh();
    }),

    vscode.commands.registerCommand("rostrum.loadSession", async (sessionId: string) => {
      await chat.loadSessionById(sessionId);
    }),

    vscode.commands.registerCommand("rostrum.revealSession", async (controllerId: string) => {
      await chat.revealSession(controllerId);
    }),

    vscode.commands.registerCommand("rostrum.deleteSession", async (sessionId: string) => {
      const answer = await vscode.window.showWarningMessage(
        "Delete this Rostrum session? Its local transcript and agent-side session (when supported) will be removed.",
        { modal: true },
        "Delete",
      );
      if (answer === "Delete") await chat.deleteSessionById(sessionId);
    }),

    vscode.commands.registerCommand("rostrum.refreshSessions", async () => {
      await chat.refreshSessionCatalog();
      sessions.refresh();
    }),

    vscode.commands.registerCommand("rostrum.exportSession", async (sessionId: string) => {
      const session = await store.load(sessionId);
      if (!session) {
        void vscode.window.showWarningMessage("Only sessions with a saved local transcript can be exported.");
        return;
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(storage, `${safeFileName(session.title)}.md`)),
        // The chosen extension picks the format: Markdown to read, JSON to keep.
        filters: { Markdown: ["md"], JSON: ["json"] },
        saveLabel: "Export Transcript",
      });
      if (!target) return;
      const format = formatForPath(target.fsPath);
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(serializeTranscript(session, format), "utf8"),
      );
      void vscode.window.showInformationMessage(
        `Exported Rostrum transcript as ${format === "json" ? "JSON" : "Markdown"} to ${path.basename(target.fsPath)}.`,
      );
    }),

    vscode.commands.registerCommand("rostrum.detectAgents", () => detectAndAddAgents(chat)),

    vscode.commands.registerCommand("rostrum.attachActiveFile", () => {
      chat.stageActiveEditorFile();
    }),

    vscode.commands.registerCommand("rostrum.attachSelection", () => {
      chat.stageActiveEditorSelection();
    }),

    vscode.commands.registerCommand("rostrum.attachDiagnostics", () => {
      chat.stageDiagnostics();
    }),

    vscode.commands.registerCommand("rostrum.attachOpenEditors", () => {
      chat.stageOpenEditors();
    }),

    vscode.commands.registerCommand("rostrum.attachWorkspaceLayout", () => {
      chat.stageWorkspaceLayout();
    }),

    vscode.commands.registerCommand("rostrum.pickAgent", async () => {
      const configured = Object.keys(
        vscode.workspace.getConfiguration("rostrum").get<Record<string, unknown>>("agents") ?? {},
      );
      if (configured.length === 0) {
        const choice = await vscode.window.showWarningMessage(
          "No agents configured yet.",
          "Detect Installed",
          "Install from Registry",
        );
        if (choice === "Detect Installed") await detectAndAddAgents(chat);
        else if (choice === "Install from Registry") {
          await vscode.commands.executeCommand("rostrum.installAgent");
        }
        return;
      }
      const picked = await vscode.window.showQuickPick(configured, {
        placeHolder: "Select an ACP agent",
      });
      if (picked) await chat.startAgent(picked);
    }),

    vscode.commands.registerCommand("rostrum.installAgent", () =>
      installAgent(storage, output, chat),
    ),

    vscode.commands.registerCommand("rostrum.restartAgent", async () => {
      await chat.restartCurrentAgent();
    }),

    vscode.commands.registerCommand("rostrum.clearUsage", async () => {
      await usage.clear();
      usageView.refresh();
    }),

    vscode.commands.registerCommand("rostrum.clearHistory", async () => {
      await history.clear();
      changes.refresh();
      timeline.refresh();
    }),

    vscode.commands.registerCommand("rostrum.setPermissionMode", async () => {
      const agents = chat.knownAgents();
      if (agents.length === 0) {
        void vscode.window.showWarningMessage("Configure an agent first.");
        return;
      }
      const current = chat.currentAgent();
      const agentKey =
        agents.length === 1
          ? agents[0]
          : await vscode.window.showQuickPick(agents, {
              placeHolder: "Set the permission mode for which agent?",
            });
      if (!agentKey) return;

      const picked = await vscode.window.showQuickPick(
        [
          { label: "Ask every time", mode: "ask" as const },
          { label: "Accept file edits", detail: "Still asks for anything else", mode: "acceptEdits" as const },
          { label: "Accept everything", detail: "No prompts at all — use with care", mode: "yolo" as const },
          { label: "Follow the global setting", detail: "rostrum.permissionMode", mode: undefined },
        ],
        { placeHolder: `Permission mode for ${agentKey}${agentKey === current ? " (current agent)" : ""}` },
      );
      if (!picked) return;
      await chat.setAgentPermissionMode(agentKey, picked.mode);
      void vscode.window.showInformationMessage(
        picked.mode
          ? `${agentKey} will ${picked.mode === "ask" ? "ask every time" : picked.mode === "acceptEdits" ? "accept file edits automatically" : "accept everything automatically"}.`
          : `${agentKey} now follows the global permission mode.`,
      );
    }),

    vscode.commands.registerCommand("rostrum.filterSessions", async () => {
      const filter = await pickTimelineFilter(sessions.currentFilter, await sessions.agents());
      if (!filter) return;
      sessions.setFilter(filter);
      void vscode.commands.executeCommand("setContext", "rostrum.sessionsFiltered", isFiltered(filter));
    }),

    vscode.commands.registerCommand("rostrum.clearSessionFilter", () => {
      sessions.setFilter({ window: "all" });
      void vscode.commands.executeCommand("setContext", "rostrum.sessionsFiltered", false);
    }),

    vscode.commands.registerCommand("rostrum.changesAsTree", () => applyChangesMode(true)),
    vscode.commands.registerCommand("rostrum.changesAsList", () => applyChangesMode(false)),

    vscode.commands.registerCommand("rostrum.filterTimeline", async () => {
      await history.load();
      const edits = history.files().flatMap((file) => file.edits);
      const filter = await pickTimelineFilter(timeline.currentFilter, agentsIn(edits));
      if (!filter) return;
      timeline.setFilter(filter);
      void vscode.commands.executeCommand("setContext", "rostrum.timelineFiltered", isFiltered(filter));
    }),

    vscode.commands.registerCommand("rostrum.clearTimelineFilter", () => {
      timeline.setFilter({ window: "all" });
      void vscode.commands.executeCommand("setContext", "rostrum.timelineFiltered", false);
    }),

    vscode.commands.registerCommand("rostrum.supervisorStatus", () =>
      showSupervisorStatus(managerStateFile(storage), output),
    ),

    vscode.commands.registerCommand("rostrum.showAgentLog", () =>
      showAgentLog(managerStateFile(storage), output),
    ),

    vscode.commands.registerCommand("rostrum.stopSupervisor", async () => {
      const status = await managerStatus(managerStateFile(storage));
      if (!status) {
        void vscode.window.showInformationMessage("No Rostrum background agents are running.");
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Stop ${status.agents.length} background agent${status.agents.length === 1 ? "" : "s"} and shut down the Rostrum supervisor? Any turn still running will be cancelled.`,
        { modal: true },
        "Stop",
      );
      if (answer !== "Stop") return;
      await managerStop(managerStateFile(storage));
      void vscode.window.showInformationMessage("Rostrum background agents stopped.");
    }),

    vscode.commands.registerCommand("rostrum.clearLocalData", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Clear Rostrum local data for this machine? This stops background agents and deletes saved transcripts, synced session catalog entries, change history, usage stats, remembered per-agent choices, and reload recovery state. VS Code settings and installed agents are not changed.",
        { modal: true },
        "Clear Local Data",
      );
      if (answer !== "Clear Local Data") return;

      await managerStop(managerStateFile(storage)).catch(() => undefined);
      await Promise.all([
        store.clear(),
        history.clear(),
        usage.clear(),
        context.workspaceState.update("rostrum.liveSessions", undefined),
        context.workspaceState.update("rostrum.activeSession", undefined),
        context.globalState.update("rostrum.agentPreferences", undefined),
        context.globalState.update("migratedFromOpenACP", undefined),
      ]);

      sessions.refresh();
      changes.refresh();
      timeline.refresh();
      usageView.refresh();
      outline.update([]);
      void vscode.window.showInformationMessage("Rostrum local data cleared. Reload the window before starting a new session.");
    }),

    vscode.commands.registerCommand("rostrum.editSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "rostrum"),
    ),
  );
}

/**
 * Browse the ACP registry and add the chosen agent to settings.
 *
 * `npx`/`uvx` agents need no install step; a binary agent is downloaded,
 * checksum-verified, and unpacked into extension storage.
 */
async function installAgent(
  storage: string,
  output: vscode.OutputChannel,
  chat: ChatViewProvider,
): Promise<void> {
  let agents;
  try {
    agents = await fetchRegistry();
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not reach the ACP registry: ${String(error)}`);
    return;
  }

  const installable = agents.filter((agent) => availability(agent));
  const picked = await vscode.window.showQuickPick(
    installable.map((agent) => ({
      label: agent.name,
      description: agent.version,
      detail: agent.description,
      agent,
    })),
    { placeHolder: `${installable.length} agents available for this platform`, matchOnDetail: true },
  );
  if (!picked) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing ${picked.agent.name}` },
    async (progress) => {
      try {
        const definition = await toDefinition(picked.agent, storage, (message) => {
          progress.report({ message });
          output.appendLine(message);
        });

        const key = settingsKey(picked.agent);
        const config = vscode.workspace.getConfiguration("rostrum");
        const existing = config.get<Record<string, unknown>>("agents") ?? {};

        await config.update(
          "agents",
          { ...existing, [key]: definition },
          vscode.ConfigurationTarget.Global,
        );

        const start = await vscode.window.showInformationMessage(
          `${picked.agent.name} added.`,
          "Start it",
        );
        if (start) await chat.startAgent(key);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Installing ${picked.agent.name} failed: ${String(error)}`,
        );
      }
    },
  );
}

/**
 * Report what the detached supervisor is running.
 *
 * The supervisor outlives the window, so "what is running" is a question the
 * extension cannot answer from its own state alone: it has to ask.
 */
async function showSupervisorStatus(
  stateFile: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const status = await managerStatus(stateFile);
  if (!status) {
    void vscode.window.showInformationMessage(
      "No Rostrum supervisor is running. Agents start one the first time they launch.",
    );
    return;
  }

  output.appendLine("");
  output.appendLine(`Rostrum supervisor pid ${status.pid}, up ${duration(Date.now() - status.startedAt)}.`);
  if (status.agents.length === 0) output.appendLine("  No agents are currently supervised.");
  for (const agent of status.agents) {
    output.appendLine(
      `  ${agent.agentKey} — pid ${agent.pid ?? "?"}, ${agent.alive ? "alive" : "exited"}, ` +
        `${agent.attached ? "attached" : "detached"}, up ${duration(Date.now() - agent.startedAt)}, ` +
        `${agent.attachments} attachment(s), ${agent.pendingBytes} B buffered` +
        (agent.droppedBytes > 0 ? `, ${agent.droppedBytes} B dropped` : ""),
    );
  }
  output.show(true);
}

/** Show the supervisor's captured stderr for one agent. */
async function showAgentLog(stateFile: string, output: vscode.OutputChannel): Promise<void> {
  const status = await managerStatus(stateFile);
  if (!status || status.agents.length === 0) {
    void vscode.window.showInformationMessage("No supervised agents have logs yet.");
    return;
  }

  const picked =
    status.agents.length === 1
      ? status.agents[0]
      : (
          await vscode.window.showQuickPick(
            status.agents.map((agent) => ({
              label: agent.agentKey,
              description: `pid ${agent.pid ?? "?"} · ${agent.stderrLines} line(s)`,
              agent,
            })),
            { placeHolder: "Show the supervisor log for which agent?" },
          )
        )?.agent;
  if (!picked) return;

  const lines = await managerLogs(stateFile, picked.key);
  output.appendLine("");
  output.appendLine(`--- ${picked.agentKey} (supervisor stderr, most recent ${lines.length} lines) ---`);
  if (lines.length === 0) output.appendLine("  (nothing captured)");
  for (const line of lines) output.appendLine(`  ${line}`);
  output.show(true);
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Find ACP agents already installed on this machine and offer to configure
 * them.
 *
 * Cheaper for the user than the registry path: nothing is downloaded, and an
 * agent they already use is one command away instead of a hand-written
 * settings block.
 */
async function detectAndAddAgents(chat: ChatViewProvider): Promise<void> {
  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Looking for installed ACP agents…" },
    async () => {
      // Widen detection with whatever the registry has added since this
      // version shipped. A registry that is unreachable is not a failure:
      // detection falls back to the curated list.
      const derived = await fetchRegistry()
        .then(registryProfiles)
        .catch(() => [] as ReturnType<typeof registryProfiles>);
      return detectAgents(nodeProbe(), mergeProfiles(KNOWN_AGENTS, derived));
    },
  );

  if (found.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "No known ACP agents were found on your PATH.",
      "Install from Registry",
    );
    if (choice) await vscode.commands.executeCommand("rostrum.installAgent");
    return;
  }

  const config = vscode.workspace.getConfiguration("rostrum");
  const existing = config.get<Record<string, unknown>>("agents") ?? {};

  const picked = await vscode.window.showQuickPick(
    found.map((entry) => ({
      label: entry.profile.name,
      description: entry.resolved,
      detail: entry.profile.notes,
      picked: !(entry.profile.name in existing),
      entry,
    })),
    {
      canPickMany: true,
      placeHolder: `Found ${found.length} installed agent${found.length === 1 ? "" : "s"} — choose which to add`,
    },
  );
  if (!picked?.length) return;

  const additions: Record<string, unknown> = { ...existing };
  for (const { entry } of picked as { entry: DetectedAgent }[]) {
    additions[entry.profile.name] = entry.definition;
  }
  await config.update("agents", additions, vscode.ConfigurationTarget.Global);

  const names = (picked as { entry: DetectedAgent }[]).map(({ entry }) => entry.profile.name);
  const start = await vscode.window.showInformationMessage(
    `Added ${names.join(", ")}.`,
    "Start it",
  );
  if (start) await chat.startAgent(names[0]);
}

/**
 * Build a timeline filter from two quick picks: when, then who.
 *
 * Two steps rather than one combined list because the two axes are
 * independent — "today" and "which agent" are different questions, and
 * flattening them into one list makes the common case (just a time window)
 * harder, not easier.
 */
async function pickTimelineFilter(
  current: TimelineFilter,
  agents: string[],
): Promise<TimelineFilter | undefined> {
  const window = await vscode.window.showQuickPick(
    TIME_WINDOWS.map((entry) => ({
      label: entry.label,
      description: entry.id === current.window ? "current" : undefined,
      id: entry.id,
    })),
    { placeHolder: "Show items from when?" },
  );
  if (!window) return undefined;

  // With at most one agent in the log there is nothing to choose between.
  if (agents.length < 2) return { window: window.id as TimeWindow };

  const agent = await vscode.window.showQuickPick(
    [
      { label: "All agents", key: undefined as string | undefined },
      ...agents.map((agentKey) => ({ label: agentKey, key: agentKey })),
    ],
    { placeHolder: "Show items from which agent?" },
  );
  if (!agent) return undefined;

  return { window: window.id as TimeWindow, agentKey: agent.key };
}

export function deactivate(): void {
  // Subscriptions dispose the agent subprocess.
}

function normaliseEditPath(file: string): string {
  if (path.isAbsolute(file)) return path.normalize(file);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.resolve(root, file);
}

function safeFileName(title: string): string {
  const value = title.replace(/[\\/:*?"<>|]/g, "-").trim();
  return value || "rostrum-session";
}
