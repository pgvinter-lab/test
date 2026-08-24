from __future__ import annotations

import unittest
from pathlib import Path

HEDGEHOG = Path(__file__).resolve().parents[1]
RUNNER = (HEDGEHOG / "scripts" / "run_agy_loop.ps1").read_text(encoding="utf-8")
INSTALLER = (HEDGEHOG / "scripts" / "install_agy_task.ps1").read_text(encoding="utf-8")
AGENTS = (HEDGEHOG / "AGENTS.md").read_text(encoding="utf-8")
PROMPT = (HEDGEHOG / "AGY_TRIGGER_PROMPT.md").read_text(encoding="utf-8")
RUNBOOK = (HEDGEHOG / "AGY_CONTINUOUS_RUNBOOK.md").read_text(encoding="utf-8")


class AgyRunnerContractTests(unittest.TestCase):
    def test_runner_invokes_antigravity_not_codex(self):
        lower = RUNNER.lower()
        self.assertIn("get-command agy.exe", lower)
        self.assertIn('agent: antigravity', lower)
        self.assertNotIn("codex.cmd", lower)
        self.assertNotIn("codex exec", lower)
        self.assertNotIn("@openai\\codex", lower)

    def test_runner_uses_verified_headless_contract(self):
        for required in (
            '"--output-format", "json"',
            '"--conversation", $conversationid',
            '"--dangerously-skip-permissions"',
            '"-p", $agyprompt',
            'if ($envelope.status -ne "success")',
            "zero token usage",
            "empty response",
        ):
            self.assertIn(required, RUNNER.lower())

    def test_runner_has_circuit_breaker_and_smoke_test(self):
        lower = RUNNER.lower()
        self.assertIn("[switch]$smoketest", lower)
        self.assertIn("$failures -ge 3", lower)
        self.assertIn("smoke success agent=antigravity", lower)
        self.assertIn("write-failurecount 0", lower)

    def test_installer_is_disabled_unless_smoke_test_is_requested(self):
        lower = INSTALLER.lower()
        self.assertIn("[switch]$enableaftersmoketest", lower)
        self.assertIn('invoke-runnerpreflight -mode "-validateonly"', lower)
        self.assertIn('invoke-runnerpreflight -mode "-smoketest"', lower)
        self.assertIn("disable-scheduledtask", lower)
        self.assertIn("enable-scheduledtask", lower)

    def test_role_split_is_consistent_across_instructions(self):
        self.assertIn("Codex is an out-of-band repair/debugging tool", AGENTS)
        self.assertIn("Do not invoke Codex", PROMPT)
        self.assertIn("Antigravity is the scheduled heavy-work engine", RUNBOOK)
        self.assertIn("There is no automatic fallback to Codex", RUNBOOK)


if __name__ == "__main__":
    unittest.main()
