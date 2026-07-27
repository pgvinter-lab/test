// Pure projection of a Bridge job's lifecycle onto the A2A TaskState vocabulary.
//
// D-026 maps each inbound A2A task to a Bridge job; this is the single
// authoritative mapping the concrete A2ATaskBackend and its tests share. Pure
// and total (no clock/IO). The exhaustive switch makes any new JobStatus a
// compile error here rather than a silent "unknown" at runtime.

import type { JobStatus } from "../core/constants.js";
import type { A2ATaskState } from "./types.js";

export function jobStatusToTaskState(status: JobStatus): A2ATaskState {
  switch (status) {
    case "queued":
    case "claimable":
      // Accepted/awaiting a worker: the task exists but has not started.
      return "submitted";
    case "claimed":
    case "running":
      return "working";
    case "awaiting_input":
      return "input-required";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      // NOTE: Bridge spells it "cancelled" (two Ls); A2A uses "canceled" (one L).
      return "canceled";
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`unmapped_job_status:${String(value)}`);
}
