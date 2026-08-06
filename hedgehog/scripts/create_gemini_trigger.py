#!/usr/bin/env python3
"""Create the persistent hourly Hedgehog Antigravity trigger.

Required environment variables:
  GEMINI_API_KEY
  HEDGEHOG_ENVIRONMENT_ID

Run from the repository root after the AI Studio environment has been created,
GitHub access has been configured, and the working branch is checked out.
"""

from __future__ import annotations

import os
from pathlib import Path

from google import genai


PROMPT_PATH = Path("hedgehog/AGY_TRIGGER_PROMPT.md")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def main() -> None:
    require_env("GEMINI_API_KEY")
    environment_id = require_env("HEDGEHOG_ENVIRONMENT_ID")

    if not PROMPT_PATH.is_file():
        raise SystemExit(f"Prompt file not found: {PROMPT_PATH}")

    prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
    if not prompt:
        raise SystemExit("Trigger prompt is empty")

    client = genai.Client()
    trigger = client.triggers.create(
        schedule="0 * * * *",
        time_zone="America/New_York",
        display_name="Hedgehog Continuous Engineer",
        max_consecutive_failures=3,
        execution_timeout_seconds=3600,
        interaction={
            "agent": "antigravity-preview-05-2026",
            "input": prompt,
            "environment": environment_id,
            "agent_config": {
                "type": "antigravity",
                "model": "gemini-3.6-flash",
                "max_total_tokens": "50000",
            },
        },
    )

    print(f"Trigger created: {trigger.id}")
    print(f"Status: {trigger.status}")
    print(f"Next run: {trigger.next_run_time}")
    print(f"Environment: {environment_id}")


if __name__ == "__main__":
    main()
