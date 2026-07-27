import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MailboxService } from "./service.js";
import type { MailboxConfig, MailboxProvider } from "./types.js";

export async function runMailboxProviderStdio(config: MailboxConfig, provider: MailboxProvider): Promise<void> {
  const mailbox = new MailboxService(config);
  const server = new McpServer({ name: `bridge-mailbox-${provider}`, version: "0.2.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

  server.registerTool(
    "bridge_mailbox_take",
    {
      title: "Take the next addressed Bridge message",
      description: `Claims one pending ${provider} message and atomically crosses the no-retry dispatch boundary before exposing its prompt.`,
    },
    async () => {
      const claim = mailbox.take(provider, `provider.${provider}.cli`);
      if (!claim) return result({ empty: true });
      mailbox.markDispatching(claim.deliveryId, claim.deliveryToken);
      mailbox.markSent(claim.deliveryId, claim.deliveryToken);
      return result(claim);
    },
  );
  server.registerTool(
    "bridge_mailbox_heartbeat",
    {
      title: "Extend an active mailbox response lease",
      inputSchema: { deliveryId: z.string(), deliveryToken: z.string() },
    },
    async (input) => result(mailbox.heartbeat(input.deliveryId, input.deliveryToken)),
  );
  server.registerTool(
    "bridge_mailbox_complete",
    {
      title: "Return the response for a claimed Bridge message",
      inputSchema: {
        deliveryId: z.string(),
        deliveryToken: z.string(),
        response: z.string(),
        conversationUrl: z.string().optional(),
      },
    },
    async (input) => result(mailbox.complete(input)),
  );
  server.registerTool(
    "bridge_mailbox_fail",
    {
      title: "Fail a claimed Bridge message",
      inputSchema: {
        deliveryId: z.string(),
        deliveryToken: z.string(),
        errorCode: z.string(),
        retryable: z.boolean().optional(),
      },
    },
    async (input) => result(mailbox.fail(input.deliveryId, input.deliveryToken, input.errorCode, input.retryable)),
  );

  process.once("exit", () => mailbox.close());
  await server.connect(new StdioServerTransport());
}
