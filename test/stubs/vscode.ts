/**
 * A minimal stand-in for the `vscode` module, so the chat provider can be
 * driven headlessly.
 *
 * Only the surface `chatView.ts` actually touches is implemented. Tests set
 * `stub.config` and read `stub.notifications` / `stub.quickPickResult` to
 * script the editor's side of an interaction.
 */
interface Stub {
  config: Record<string, unknown>;
  workspaceFolders: string[];
  notifications: string[];
  nextNotificationChoice: string | undefined;
  quickPickResult: unknown;
  openDialogResult: unknown[] | undefined;
  activeTextEditor: unknown;
  visibleTextEditors: unknown[];
  activeColorTheme: { kind: number };
  diagnostics: unknown[];
  workspaceFiles: Uri[];
  files: Map<string, string>;
  reset(): void;
}

/**
 * esbuild inlines this module into every bundle that imports `vscode`, so the
 * state lives on `globalThis` and every copy shares one object. Tests read it
 * as `globalThis.__rostrumVscodeStub`.
 */
const scope = globalThis as unknown as { __rostrumVscodeStub?: Stub };

export const stub: Stub = (scope.__rostrumVscodeStub ??= {
  config: {} as Record<string, unknown>,
  workspaceFolders: ["/workspace"],
  notifications: [] as string[],
  /** Answer the next `showInformationMessage` with this action, then clear it. */
  nextNotificationChoice: undefined as string | undefined,
  quickPickResult: undefined as unknown,
  openDialogResult: undefined as unknown[] | undefined,
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  activeColorTheme: { kind: 2 },
  diagnostics: [] as unknown[],
  workspaceFiles: [] as Uri[],
  files: new Map<string, string>(),
  reset() {
    this.config = {};
    this.notifications = [];
    this.nextNotificationChoice = undefined;
    this.quickPickResult = undefined;
    this.openDialogResult = undefined;
    this.activeTextEditor = undefined;
    this.visibleTextEditors = [];
    this.activeColorTheme = { kind: 2 };
    this.diagnostics = [];
    this.workspaceFiles = [];
    this.files.clear();
  },
});

export class Uri {
  private constructor(readonly fsPath: string) {}
  get path(): string { return this.fsPath; }
  static file(value: string): Uri { return new Uri(value); }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.fsPath, ...parts].join("/"));
  }
  toString(): string { return `file://${this.fsPath}`; }
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

export const workspace = {
  get workspaceFolders() {
    return stub.workspaceFolders.map((fsPath) => ({ uri: Uri.file(fsPath) }));
  },
  getConfiguration(_section: string) {
    return { get: (key: string) => stub.config[key] };
  },
  asRelativePath(uri: Uri | string) {
    const value = typeof uri === "string" ? uri : uri.fsPath;
    const root = stub.workspaceFolders.find((folder) => value.startsWith(`${folder}/`));
    return root ? value.slice(root.length + 1) : value;
  },
  async findFiles(pattern: string, _exclude: string, maxResults?: number) {
    const needle = pattern.replace(/^\*\*\//, "").replace(/\*/g, "").toLowerCase();
    return stub.workspaceFiles
      .filter((uri) => uri.fsPath.toLowerCase().includes(needle))
      .slice(0, maxResults);
  },
  fs: {
    async stat(uri: Uri) {
      return { size: Buffer.byteLength(stub.files.get(uri.fsPath) ?? "") };
    },
    async readFile(uri: Uri) {
      return Buffer.from(stub.files.get(uri.fsPath) ?? "", "utf8");
    },
  },
};

export const window = {
  get activeTextEditor() {
    return stub.activeTextEditor;
  },
  get visibleTextEditors() {
    return stub.visibleTextEditors;
  },
  get activeColorTheme() {
    return stub.activeColorTheme;
  },
  async showQuickPick(items: unknown) {
    const chosen = stub.quickPickResult;
    stub.quickPickResult = undefined;
    if (typeof chosen === "number") return (items as unknown[])[chosen];
    return chosen;
  },
  async showOpenDialog() {
    const chosen = stub.openDialogResult;
    stub.openDialogResult = undefined;
    return chosen;
  },
  async showInformationMessage(message: string, ..._actions: string[]) {
    stub.notifications.push(message);
    const choice = stub.nextNotificationChoice;
    stub.nextNotificationChoice = undefined;
    return choice;
  },
  // Warnings and errors land in the same list as information messages: a test
  // asserting the user was told something should not care which severity the
  // code chose to say it with.
  async showWarningMessage(message: string, ..._actions: string[]) {
    stub.notifications.push(message);
    const choice = stub.nextNotificationChoice;
    stub.nextNotificationChoice = undefined;
    return choice;
  },
  async showErrorMessage(message: string, ..._actions: string[]) {
    stub.notifications.push(message);
    return undefined;
  },
  async showTextDocument() {
    return undefined;
  },
};

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

export const languages = {
  getDiagnostics(uri?: Uri) {
    if (uri) {
      return stub.diagnostics
        .filter((entry: any) => entry.uri.fsPath === uri.fsPath)
        .map((entry: any) => entry.diagnostic);
    }
    return stub.diagnostics.map((entry: any) => [entry.uri, [entry.diagnostic]]);
  },
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ProgressLocation = { Notification: 15 };

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value?: T): void {
    for (const listener of this.listeners) listener(value as T);
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class MarkdownString {
  constructor(readonly value = "") {}
}

export class TreeItem {
  description?: string | boolean;
  iconPath?: unknown;
  contextValue?: string;
  id?: string;
  tooltip?: unknown;
  resourceUri?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: unknown,
    readonly collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}
