import crypto from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { asErrorCode } from "../core/errors.js";
import { mailboxBrokerUrl, readBrokerToken } from "./config.js";
import { MailboxService } from "./service.js";
import type { MailboxConfig, MailboxMessageStatus, MailboxProvider, MailboxSendInput } from "./types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class MailboxBroker {
  readonly config: MailboxConfig;
  readonly service: MailboxService;
  private readonly token: string;
  private server?: Server;

  constructor(config: MailboxConfig, service = new MailboxService(config)) {
    this.config = config;
    this.service = service;
    this.token = readBrokerToken(config);
  }

  async start(): Promise<{ url: string }> {
    if (this.server) throw new Error("mailbox_broker_already_started");
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.broker.port, this.config.broker.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    return { url: mailboxBrokerUrl(this.config) };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.service.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      if (!this.authenticated(request)) {
        json(response, 401, { ok: false, error: "mailbox_broker_unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", mailboxBrokerUrl(this.config));
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, this.service.doctor());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        json(response, 201, this.service.send(await body<MailboxSendInput>(request)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        const provider = optionalProvider(url.searchParams.get("provider"));
        const status = optionalStatus(url.searchParams.get("status"));
        const limit = Number(url.searchParams.get("limit") ?? "100");
        json(response, 200, this.service.list({
          ...(provider ? { provider } : {}),
          ...(status ? { status } : {}),
          limit,
        }));
        return;
      }
      const messageMatch = /^\/v1\/messages\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && messageMatch) {
        const record = this.service.get(decodeURIComponent(messageMatch[1]));
        json(response, record ? 200 : 404, record ?? { ok: false, error: "mailbox_message_not_found" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/take") {
        const input = await body<{ provider: MailboxProvider; consumerId?: string }>(request);
        const claim = this.service.take(input.provider, input.consumerId);
        json(response, claim ? 200 : 204, claim);
        return;
      }
      const deliveryMatch = /^\/v1\/deliveries\/([^/]+)\/(dispatching|sent|heartbeat|complete|fail)$/u.exec(url.pathname);
      if (request.method === "POST" && deliveryMatch) {
        const deliveryId = decodeURIComponent(deliveryMatch[1]);
        const action = deliveryMatch[2];
        const input = await body<Record<string, unknown>>(request);
        const deliveryToken = requiredString(input.deliveryToken, "mailbox_delivery_token_required");
        let value: unknown;
        switch (action) {
          case "dispatching": value = this.service.markDispatching(deliveryId, deliveryToken); break;
          case "sent": value = this.service.markSent(deliveryId, deliveryToken); break;
          case "heartbeat": value = this.service.heartbeat(deliveryId, deliveryToken); break;
          case "complete": value = this.service.complete({
            deliveryId,
            deliveryToken,
            response: requiredString(input.response, "mailbox_response_required"),
            ...(typeof input.conversationUrl === "string" ? { conversationUrl: input.conversationUrl } : {}),
          }); break;
          case "fail": value = this.service.fail(
            deliveryId,
            deliveryToken,
            requiredString(input.errorCode, "mailbox_error_code_required"),
            input.retryable === true,
          ); break;
          default: throw new Error("mailbox_delivery_action_invalid");
        }
        json(response, 200, value);
        return;
      }
      json(response, 404, { ok: false, error: "mailbox_route_not_found" });
    } catch (error) {
      const code = asErrorCode(error);
      const status = code.includes("not_found") ? 404 : code.includes("unauthorized") ? 401 : 400;
      json(response, status, { ok: false, error: code });
    }
  }

  private authenticated(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice(7), "utf8");
    const expected = Buffer.from(this.token, "utf8");
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && this.config.broker.allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
  }
}

async function body<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error("mailbox_request_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  if (status === 204) {
    response.writeHead(status).end();
    return;
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status).end(`${JSON.stringify(value)}\n`);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function optionalProvider(value: string | null): MailboxProvider | undefined {
  if (value === null) return undefined;
  if (value !== "chatgpt" && value !== "antigravity" && value !== "web") throw new Error("mailbox_provider_invalid");
  return value;
}

function optionalStatus(value: string | null): MailboxMessageStatus | undefined {
  if (value === null) return undefined;
  const allowed: MailboxMessageStatus[] = ["preparing", "queued", "claimed", "dispatching", "sent", "completed", "failed", "uncertain", "expired"];
  if (!allowed.includes(value as MailboxMessageStatus)) throw new Error("mailbox_status_invalid");
  return value as MailboxMessageStatus;
}
