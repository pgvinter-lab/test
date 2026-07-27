# Secret and Sensitive-Marker Scan - Patch 0.1.4

Status: PASS

Date: 2026-07-14

Scope: repository files excluding `.git/`, `.connector/`, `node_modules/`, and
generated `dist/`.

Checks run:

- Private-key headers and AWS, Google, OpenAI-style, and GitHub token shapes
- Bearer tokens and assigned password/secret/API-key/access-token shapes
- Local user path and designated Drive-account identifiers
- Case-project, case-fact, legal-evidence, browser-state, cookie, and one-off RUN
  markers
- Prohibited filenames for keys, environment files, runtime databases, archives,
  bundles, browser state, and one-off run requests
- Git and package dry-run inventory inspection
- `gitleaks` availability check

Result:

- No private key, real token, assigned secret, local account/path, designated Drive
  account identifier, prohibited filename, or packaged prohibited payload was
  detected.
- One bearer-shaped value is an explicit synthetic rejection fixture named
  `raw-secret-token`; it is not a credential and is required to prove inline
  credential rejection.
- Case/browser-marker matches were generic security-boundary, dependency-name,
  schema, and prior-review statements only. They contain no case fact, evidence,
  browser state, or legal material.
- The sanitized working-tree inventory contained 237 files and zero prohibited
  payload filenames.
- `npm pack --dry-run --json --ignore-scripts` reported package `0.1.4`, 166
  entries, and zero prohibited payload filenames.
- `gitleaks` is not installed. Repository-local pattern scans, package inventory,
  contract rejection tests, and manual diff review are the recorded substitute.
