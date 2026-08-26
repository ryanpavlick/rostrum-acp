/**
 * Arrange edited files as a folder hierarchy.
 *
 * Kept free of `vscode` so the shaping is testable: a flat list is fine for a
 * handful of files and unreadable for a hundred, and the folding rules are
 * where that view either works or does not.
 */
import type { FileHistory } from "./history.js";

export type ChangeTreeNode =
  | { type: "folder"; label: string; path: string; children: ChangeTreeNode[]; fileCount: number }
  | { type: "file"; label: string; file: FileHistory };

/** Split a path on either separator, so a Windows path folds the same way. */
function segments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

/**
 * Make a path relative to whichever workspace root contains it.
 *
 * Files outside every root keep their absolute path: hiding that a change
 * landed outside the workspace would be worse than an ugly label.
 */
export function relativeTo(roots: string[], filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const candidates = [...roots]
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))
    .sort((a, b) => b.length - a.length);

  for (const root of candidates) {
    if (normalized === root) return normalized.split("/").pop() ?? normalized;
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return normalized;
}

interface Building {
  folders: Map<string, Building>;
  files: FileHistory[];
}

function emptyNode(): Building {
  return { folders: new Map(), files: [] };
}

/**
 * Build a folder tree over the edited files.
 *
 * Chains of single-child folders are compacted into one row (`src/extension`
 * rather than `src` containing `extension`), which is what keeps a deep
 * project readable — the same thing VS Code's explorer does.
 */
export function buildFileTree(files: FileHistory[], roots: string[]): ChangeTreeNode[] {
  const root = emptyNode();

  for (const file of files) {
    const parts = segments(relativeTo(roots, file.path));
    const name = parts.pop();
    if (!name) continue;

    let cursor = root;
    for (const part of parts) {
      let next = cursor.folders.get(part);
      if (!next) {
        next = emptyNode();
        cursor.folders.set(part, next);
      }
      cursor = next;
    }
    cursor.files.push(file);
  }

  return toNodes(root, "");
}

function toNodes(node: Building, prefix: string): ChangeTreeNode[] {
  const folders: ChangeTreeNode[] = [];

  for (const [name, child] of node.folders) {
    let label = name;
    let current = child;
    let path = prefix ? `${prefix}/${name}` : name;

    // Compact a chain of folders that each hold exactly one folder and nothing else.
    while (current.files.length === 0 && current.folders.size === 1) {
      const [nextName, nextChild] = [...current.folders][0];
      label = `${label}/${nextName}`;
      path = `${path}/${nextName}`;
      current = nextChild;
    }

    const children = toNodes(current, path);
    folders.push({
      type: "folder",
      label,
      path,
      children,
      fileCount: countFiles(children),
    });
  }

  // Folders first, then files, each alphabetical — a stable shape that does
  // not reshuffle itself as new edits arrive.
  folders.sort((a, b) => a.label.localeCompare(b.label));
  const files: ChangeTreeNode[] = node.files
    .map((file) => ({
      type: "file" as const,
      label: segments(file.path).pop() ?? file.path,
      file,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...folders, ...files];
}

function countFiles(nodes: ChangeTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.type === "file" ? 1 : node.fileCount),
    0,
  );
}
