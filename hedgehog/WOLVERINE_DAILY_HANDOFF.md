# Wolverine Daily Handoff Contract

## Temporary purpose

Until AGY has direct Google Drive access, Wolverine acts as the local file shepherd and GitHub is the transport bridge to the daily Drive archive.

## Local staging folder

Use this Windows path unless the local workspace already defines a canonical SK-O root:

`C:\SK-O\Hedgehog\WOLVERINE_OUTBOX\`

Subfolders:

- `reports\`
- `evidence\`
- `architecture\`
- `benchmarks\`
- `outreach-drafts\`
- `logs\`
- `manifests\`

## Wolverine responsibilities

At the end of every completed AGY/Wolverine work cycle:

1. Copy only new or changed deliverables into the outbox while preserving relative paths.
2. Generate `manifests\handoff.json` containing relative path, byte size, SHA-256, source agent, source task, created time, modified time, and sensitivity classification.
3. Never place actual secrets, API keys, credentials, customer data, private legal records, model weights, or live production payloads containing private data in the public repository.
4. Treat Hedgehog architecture, topology, system design, implementation details, ADRs, threat models, synthetic fixtures, benchmark methods and results, and reproducibility evidence as safe for GitHub and Google Drive unless a specific artifact embeds excluded data from item 3.
5. Commit safe artifacts to `pgvinter-lab/test` on branch `hedgehog/agy-continuous` under their canonical `hedgehog/` paths or, for transport-only bulk files, under `hedgehog/outbox/`.
6. Put genuinely private or oversized artifacts only in the local outbox and record a metadata-only placeholder in GitHub.
7. Do not delete local source files after staging.
8. Mark an artifact `READY_FOR_DRIVE=true` only after hashing and successful local verification.
9. Record failures in `manifests\handoff-errors.log`.

## Daily cloud-side sync

The ChatGPT daily monitor runs at 4:20 a.m. America/New_York and:

1. Reviews GitHub `hedgehog/outbox/`, `hedgehog/reports/`, commits, issues, CI, and status.
2. Uploads new safe artifacts to Google Drive folder `SK-O/Hedgehog/AGY Daily Drops`.
3. Preserves filenames and creates a dated subfolder when needed.
4. May additionally archive canonical design and system artifacts under `SK-O/Hedgehog/System`.
5. Verifies Drive metadata after upload.
6. Never deletes the source copy.
7. Reports failed hashes, missing evidence, stale work, unsupported completion claims, and blockers.

## Direct local-disk limitation

The cloud monitor cannot directly read an arbitrary Windows disk path unless the local bridge explicitly exposes it. Therefore GitHub is the temporary reliable transport for safe files. Once Scotty/Wolverine exposes a verified local-file connector, the monitor may ingest the local outbox directly and GitHub can remain the source-control channel rather than the bulk-file transport.
