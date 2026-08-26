import * as path from "node:path";
import * as vscode from "vscode";
import { managerLogs, managerStateFile, managerStatus, managerStop } from "./agentProcess.js";
import { ChatViewProvider } from "./chatView.js";
import { formatForPath, serializeTranscript } from "./export.js";
import { ChangeHistory } from "./history.js";
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

  void history.load().then(() => {
    changes.refresh();
    timeline.refresh();
  });

  context.subscriptions.push(
    output,
    chat,
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

    vscode.commands.registerCommand("rostrum.openHistoryDiff", async (edit) => {
      if (typeof edit?.newText !== "string") {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(edit.path));
        return;
      }
      const language = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.path))
        .then((document) => document.languageId, () => "plaintext");
      const [before, after] = await Promise.all([
        vscode.workspace.openTextDocument({ content: edit.oldText ?? "", language }),
        vscode.workspace.openTextDocument({ content: edit.newText, language }),
      ]);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before.uri,
        after.uri,
        `Agent edit: ${path.basename(edit.path)}`,
      );
    }),

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

    vscode.commands.registerCommand("rostrum.pickAgent", async () => {
      const configured = Object.keys(
        vscode.workspace.getConfiguration("rostrum").get<Record<string, unknown>>("agents") ?? {},
      );
      if (configured.length === 0) {
        const choice = await vscode.window.showWarningMessage(
          "No agents configured yet.",
          "Install from Registry",
        );
        if (choice) await vscode.commands.executeCommand("rostrum.installAgent");
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
