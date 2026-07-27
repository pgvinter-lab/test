# Secret and Sensitive-Marker Scan - Patch 0.1.2

Status: PASS

Date: 2026-07-14

Scope: repository files excluding `.git/`, `.connector/`, `node_modules/`, and
generated `dist/`.

Checks run:

- Local account/path and specified Drive-account marker scan
- Custody-workspace, case-fact, evidence, and legal-evidence marker scan
- AWS, Google, OpenAI-style, and GitHub token-shape scan
- Private-key header, bearer-token, and assigned-secret scan
- Prohibited filename scan for runtime databases, archives, bundles, keys,
  environment files, cookies, browser state, and one-off run files
- Package dry-run inventory inspection
- `gitleaks` availability check

Result:

- No local account/path, provider token, private key, bearer token, assigned
  secret, credential file, browser state, runtime database, archive, bundle, or
  prohibited filename was detected.
- One case-marker hit is the generic prohibition in `docs/IMPLEMENTATION_BOARD.md`;
  it contains no case fact or evidence and is retained as a safety boundary.
- A hardcoded local Drive account identifier introduced during patch development
  was removed. Recovery-root selection now uses explicit configuration or generic
  unique-folder discovery.
- `npm pack --dry-run --json --ignore-scripts` reported package `0.1.2`, 160
  entries, and zero prohibited payload filenames at the scan point.
- `gitleaks` is not installed. The repository-local pattern scan, changed-file
  review, package inspection, and synthetic contract rejection tests are the
  recorded substitute.
