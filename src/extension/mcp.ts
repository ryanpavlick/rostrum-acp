import type { McpServer } from "@agentclientprotocol/sdk";

/** User-facing MCP setting. Stdio is the default for backward compatibility. */
export type McpServerDefinition =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface McpTransportCapabilities {
  http: boolean;
  sse: boolean;
}

/** Convert merged settings to ACP servers, dropping malformed or unsupported entries safely. */
export function mcpServersFromConfig(
  configured: Record<string, McpServerDefinition>,
  capabilities: McpTransportCapabilities,
): McpServer[] {
  return Object.entries(configured).flatMap(([name, definition]): McpServer[] => {
    if (definition.type === "http" || definition.type === "sse") {
      if (!capabilities[definition.type] || !isHttpUrl(definition.url)) return [];
      return [{
        type: definition.type,
        name,
        url: definition.url,
        headers: Object.entries(definition.headers ?? {}).map(([header, value]) => ({ name: header, value })),
      }];
    }
    if (definition.type !== undefined && definition.type !== "stdio") return [];
    if (!definition.command?.trim()) return [];
    return [{
      name,
      command: definition.command,
      args: definition.args ?? [],
      env: Object.entries(definition.env ?? {}).map(([key, value]) => ({ name: key, value })),
    }];
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
