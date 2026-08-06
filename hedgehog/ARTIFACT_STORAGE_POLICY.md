# Hedgehog Artifact Storage Policy

## Default rule

Hedgehog's architecture, topology, system design, implementation details, engineering doctrine, ADRs, threat models, synthetic fixtures, benchmark methods and results, reproducibility evidence, and operational documentation are not sensitive by default.

These artifacts may be stored in:

- GitHub repository `pgvinter-lab/test`, branch `hedgehog/agy-continuous`, under canonical `hedgehog/` paths; and
- Google Drive under `SK-O/Hedgehog/System` for canonical system archives or `SK-O/Hedgehog/AGY Daily Drops` for dated handoffs.

The public visibility of the GitHub repository is not a Hedgehog design blocker.

## Excluded material

Do not publish or routine-sync:

- Secrets, API keys, passwords, tokens, or credentials
- Customer data or tenant payloads
- Private legal records
- Model weights
- Live production payloads containing private data

An otherwise safe design artifact remains safe unless it directly embeds excluded material.

## Handoff behavior

- Preserve filenames and relative organization.
- Never delete source files after copying or uploading.
- Hash artifacts before handoff when possible and verify destination metadata after upload.
- Store canonical design documents directly in GitHub; use `hedgehog/outbox/` only as a temporary bulk transport channel.
- Archive canonical system documents under `SK-O/Hedgehog/System` when a Drive copy is useful.
