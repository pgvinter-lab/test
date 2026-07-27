// AdapterManifest for the outbound A2A client (Phase B, D-026).
//
// Declares the outbound delegation surface. security.credentialMode is "none":
// the no-API-key invariant. The compatibility tools execute this surface through
// the loopback A2A server and subscription CLI runner; autonomous AdapterHost
// registration remains a separate approval-gated path.

import { CONTRACT_VERSION } from "../core/constants.js";
import type { AdapterManifest } from "../core/types.js";

const SCHEMAS = "https://bridge2.local/contracts/v0.1.0-draft.4/schemas";

export function buildA2AClientAdapterManifest(): AdapterManifest {
  return {
    schemaVersion: CONTRACT_VERSION,
    adapterId: "adapter.a2a.client",
    adapterVersion: "0.3.0",
    interfaceVersion: CONTRACT_VERSION,
    displayName: "A2A Outbound Client",
    kind: "cli",
    operations: {
      send: {
        inputSchema: `${SCHEMAS}/a2a-send.schema.json`,
        outputSchema: `${SCHEMAS}/a2a-task-receipt.schema.json`,
        idempotent: true,
        sideEffectClass: "external_reversible",
        timeoutMs: 600_000,
      },
      getTask: {
        inputSchema: `${SCHEMAS}/a2a-task-query.schema.json`,
        outputSchema: `${SCHEMAS}/a2a-task-receipt.schema.json`,
        idempotent: true,
        sideEffectClass: "read_only",
        timeoutMs: 30_000,
      },
    },
    capabilities: ["a2a_delegate", "a2a_task_status"],
    transports: ["remote_http"],
    security: {
      credentialMode: "none", // INVARIANT: subscriptions only, no API keys
      networkAccess: ["http://127.0.0.1", "http://localhost"],
      sensitiveData: "local_only",
      humanApprovalFor: ["external_irreversible", "sensitive_external"],
      approvalPolicy: {
        defaultDecision: "ask",
        preapproval: "bounded_grants",
        scopeExpansionDecision: "ask",
        grantSchema: `${SCHEMAS}/approval-grant.schema.json`,
      },
    },
    health: { checkOperation: "doctor", states: ["ready", "degraded", "blocked", "offline"] },
  };
}
