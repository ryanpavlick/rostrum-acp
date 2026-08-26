import * as vscode from "vscode";

/** Settings that moved with the rename from the previous extension id. */
const MIGRATED_KEYS = ["agents", "defaultAgent", "permissionMode", "mcpServers", "promptForAuth"];

const LEGACY_SECTION = "openacp";
const SECTION = "rostrum";

/**
 * Carry settings over from the pre-rename extension id.
 *
 * Runs once: a marker in global state stops it re-copying values the user has
 * since changed or deliberately cleared. Only keys the user actually set are
 * copied, so defaults are never frozen into their settings file.
 */
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<string[]> {
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
  const current = vscode.workspace.getConfiguration(SECTION);
  const moved: string[] = [];
  const migratedGlobals = context.globalState.get<boolean>("migratedFromOpenACP") === true;

  for (const key of MIGRATED_KEYS) {
    const from = legacy.inspect(key);
    const to = current.inspect(key);

    // Global values migrate once for the extension as a whole. Workspace
    // values are deliberately checked every activation: a global marker must
    // not strand a legacy setting in another workspace folder.
    if (!migratedGlobals && from?.globalValue !== undefined && to?.globalValue === undefined) {
      await current.update(key, from.globalValue, vscode.ConfigurationTarget.Global);
      moved.push(key);
    }
    if (from?.workspaceValue !== undefined && to?.workspaceValue === undefined) {
      await current.update(key, from.workspaceValue, vscode.ConfigurationTarget.Workspace);
      moved.push(`${key} (workspace)`);
    }
  }

  if (!migratedGlobals) await context.globalState.update("migratedFromOpenACP", true);
  return moved;
}
