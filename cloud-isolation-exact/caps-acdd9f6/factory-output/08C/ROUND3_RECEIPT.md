# 08C Remediation Round 3

Fixing review job.a2a-9fea30b9965ed6a7481377e7456067f12f7ac3fb / artifact.a2a-result-4762c4299fc743a51aa447843956aaa7db22a497.

Issue: `process.pid + 999` is dead on the same host, so the lock is stolen instead of honored.
Fix: Changed `process.pid + 999` to `process.pid` (the live parent test process) in `test/caps/mcp-tools.test.mjs`.

Proof of live PID:
Using `process.pid` provides the exact PID of the running test runner. Since `os.hostname()` is used, the child MCP server sees the lock as held by an active process on the current machine and correctly denies the lock (returning `already_running`) without mutating the database.
