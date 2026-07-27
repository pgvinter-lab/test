import { spawnSync } from "node:child_process";

const rounds = process.env.BRIDGE_WAL_RACE_ROUNDS ?? "20";
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-name-pattern=^concurrent runtime processes serialize JSONL outbox append and acknowledgement$",
    "test/runtime/runtime-contract-closure.test.mjs",
  ],
  {
    env: { ...process.env, BRIDGE_WAL_RACE_ROUNDS: rounds },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
