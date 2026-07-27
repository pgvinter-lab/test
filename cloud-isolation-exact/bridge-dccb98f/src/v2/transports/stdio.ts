import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BridgeRuntime } from "../runtime.js";
import { createRuntimeMcpServer, type McpConnectionContext } from "./mcp-server.js";

export async function runStdioServer(runtime: BridgeRuntime, context: McpConnectionContext): Promise<void> {
  if (context.transport.transport !== "stdio") throw new Error("stdio_transport_binding_required");
  const server = createRuntimeMcpServer(runtime, context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
