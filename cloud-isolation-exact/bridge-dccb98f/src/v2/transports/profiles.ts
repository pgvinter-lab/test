import type { ProjectRole } from "../core/constants.js";
import { invariant } from "../core/errors.js";

export type McpProfile = "bridge.read" | "bridge.collaborate" | "bridge.review" | "bridge.operate" | "bridge.admin";

export interface ProfileOptions {
  adminEnabled?: boolean;
}

export function deriveProfiles(roles: ProjectRole[], options: ProfileOptions = {}): McpProfile[] {
  const profiles = new Set<McpProfile>();
  if (roles.length > 0) profiles.add("bridge.read");
  if (roles.includes("collaborator") || roles.includes("worker")) profiles.add("bridge.collaborate");
  if (roles.includes("reviewer")) profiles.add("bridge.review");
  if (roles.includes("owner")) profiles.add("bridge.operate");
  if ((roles.includes("owner") || roles.includes("administrator")) && options.adminEnabled === true) profiles.add("bridge.admin");
  return [...profiles].sort();
}

const TOOL_PROFILES: Record<string, McpProfile[]> = {
  bridge_v2_status: ["bridge.read"],
  bridge_v2_whoami: ["bridge.read"],
  bridge_v2_get_job: ["bridge.read"],
  bridge_v2_list_jobs: ["bridge.read"],
  bridge_v2_get_artifact: ["bridge.read"],
  bridge_v2_list_artifacts: ["bridge.read"],
  bridge_v2_list_events: ["bridge.read"],
  bridge_v2_list_operation_reports: ["bridge.read"],
  bridge_v2_get_approval_grant: ["bridge.read"],
  bridge_v2_list_approval_grants: ["bridge.read"],
  bridge_v2_get_adapter: ["bridge.read"],
  bridge_v2_list_adapters: ["bridge.read"],
  bridge_v2_register_artifact: ["bridge.collaborate", "bridge.review", "bridge.operate"],
  bridge_v2_create_job: ["bridge.collaborate", "bridge.operate"],
  bridge_v2_make_claimable: ["bridge.collaborate", "bridge.operate"],
  bridge_v2_claim_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_release_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_start_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_await_input: ["bridge.collaborate", "bridge.review"],
  bridge_v2_resume_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_complete_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_fail_job: ["bridge.collaborate", "bridge.review"],
  bridge_v2_cancel_job: ["bridge.collaborate", "bridge.operate"],
  bridge_v2_invoke_adapter: ["bridge.collaborate", "bridge.review"],
  bridge_v2_authorize_browser_action: ["bridge.collaborate", "bridge.review"],
  bridge_v2_authorize_adapter_action: ["bridge.collaborate", "bridge.review"],
  bridge_v2_backup: ["bridge.operate"],
  bridge_v2_amend_instructions: ["bridge.operate"],
  bridge_v2_expire_claim: ["bridge.operate"],
  bridge_v2_create_approval_grant: ["bridge.operate"],
  bridge_v2_revoke_approval_grant: ["bridge.operate"],
  bridge_v2_register_adapter: ["bridge.operate", "bridge.admin"],
  bridge_v2_restore_plan: ["bridge.operate"],
  bridge_v2_migration_plan: ["bridge.operate"],
  bridge_v2_migrate: ["bridge.operate"],
  bridge_v2_doctor: ["bridge.operate"],
  bridge_v2_takeover: ["bridge.operate"],
  bridge_v2_reconcile_takeover: ["bridge.operate"],
  bridge_v2_register_principal: ["bridge.admin"],
  bridge_v2_assign_role: ["bridge.admin"],
  bridge_v2_revoke_role: ["bridge.admin"],
  bridge_v2_disable_principal: ["bridge.admin"],
  bridge_v2_set_host_status: ["bridge.admin"],
  bridge_v2_register_host: ["bridge.admin"],
  bridge_v2_create_session: ["bridge.admin"],
  bridge_v2_revoke_session: ["bridge.admin"],
};

export function toolProfiles(toolName: string): McpProfile[] {
  return [...(TOOL_PROFILES[toolName] ?? [])];
}

export function visibleToolNames(profiles: McpProfile[]): string[] {
  return Object.entries(TOOL_PROFILES)
    .filter(([, required]) => required.some((profile) => profiles.includes(profile)))
    .map(([name]) => name)
    .sort();
}

export function assertToolAuthorized(toolName: string, profiles: McpProfile[]): void {
  const required = TOOL_PROFILES[toolName];
  invariant(required && required.some((profile) => profiles.includes(profile)), "mcp_tool_not_authorized", { toolName });
}
