import * as path from "node:path";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView.js";
import { ChangeHistory } from "./history.js";
import { migrateLegacySettings } from "./migrate.js";
import { availability, fetchRegistry, settingsKey, toDefinition } from "./registry.js";
import { SessionStore } from "./store.js";
import { ChangedFilesTree, OutlineTree, SessionsTree, TimelineTree, UsageStatsTree } from "./trees.js";
import { UsageTracker } from "./usage.js";
import type { Block, Turn } from "../shared/protocol.js";

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
        filters: { Markdown: ["md"] },
        saveLabel: "Export Transcript",
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(transcriptMarkdown(session.title, session.turns), "utf8"));
      void vscode.window.showInformationMessage(`Exported Rostrum transcript to ${path.basename(target.fsPath)}.`);
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

export function deactivate(): void {
  // Subscriptions dispose the agent subprocess.
}

function normaliseEditPath(file: string): string {
  if (path.isAbsolute(file)) return path.normalize(file);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.resolve(root, file);
}

function transcriptMarkdown(title: string, turns: Turn[]): string {
  const parts = [`# ${title}`, ""];
  for (const turn of turns) {
    parts.push(`## ${turn.role === "user" ? "You" : "Agent"}`, "");
    for (const block of turn.blocks) parts.push(...blockMarkdown(block));
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

function blockMarkdown(block: Block): string[] {
  switch (block.kind) {
    case "text": return [block.text, ""];
    case "reasoning": return ["<details><summary>Thinking</summary>", "", block.text, "", "</details>", ""];
    case "tool": return [`> **${block.call.kind}** — ${block.call.title} (${block.call.status})`, block.call.output ? `> ${block.call.output.replace(/\n/g, "\n> ")}` : "", ""];
    case "diff": return [`### Diff: \`${block.path}\``, "", "```diff", `- ${block.oldText.replace(/\n/g, "\n- ")}`, `+ ${block.newText.replace(/\n/g, "\n+ ")}`, "```", ""];
    case "image": return [`_[Image attachment: ${block.mimeType}]_`, ""];
    case "audio": return [`_[Audio attachment: ${block.mimeType}]_`, ""];
    case "resource": return [block.uri ? `[${block.label}](${block.uri})` : `_${block.label}_`, block.text ?? "", ""];
  }
}

function safeFileName(title: string): string {
  const value = title.replace(/[\\/:*?"<>|]/g, "-").trim();
  return value || "rostrum-session";
}
