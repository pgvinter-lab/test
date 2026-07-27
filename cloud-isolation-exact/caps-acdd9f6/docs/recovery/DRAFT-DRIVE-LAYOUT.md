# Google Drive Recovery Layout

Status: DRAFT SCAFFOLDING

Approved local Drive root: the owner-provided Google Drive mount, with the recovery
folder named `Bridge 2.0 Recovery`. The account-specific absolute path stays in
local Bridge registration/operations and is not committed.

Draft layout implemented by the recovery CLI:

```text
Bridge 2.0 Recovery/
  README_DRAFT.md
  backups/
    <backup-id>/
      manifest.json
      source.bundle
      state.snapshot.enc
      audit.events.jsonl.enc
  restore-reports/
  recovery-drills/
  recovery-keys/
    <key-name>.private.pem
    <key-name>.public.pem
  key-capsules/
    <backup-id>.capsule.json
```

`backupId` values are globally namespaced and each manifest is bound to exactly one
`projectId`. Doctor accepts this canonical top-level layout and the earlier direct
`<recovery-root>/<backup-id>/manifest.json` layout for compatibility, but fails
closed if the same backup ID exists in both locations.

Wrapped recovery-key capsules and one owner-approved private/public recovery-key
copy set live under the configured Drive recovery root. Sanitized manifests retain
the alias `drive-account://recovery-key-account`; the local private procedure binds
that alias to the actual account and path. The CLI writes the standalone capsule
shown above; each encrypted backup manifest embeds its hash-bound capsule reference
and metadata, not private-key or raw data-key bytes. A byte-identical second key
copy lives in local Bridge runtime state. Neither private-key copy belongs in
GitHub, source, logs, prompts, manifests, or audit records.

Only recovery packages, reports, capsules, and the exact approved recovery-key
copy set belong here. Do not place a live Git
working tree, `.git/`, SQLite database/WAL, lease file, browser profile, credential,
or unencrypted confidential/restricted snapshot in this directory.

AES-256-GCM, opaque key references, RSA-OAEP-SHA-256 capsules, and local/Drive
private-key copies are owner-approved. Rotation, retention, legal holds, RPO/RTO,
and automatic replication remain deferred.
