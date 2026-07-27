# Secret and Sensitive-Marker Scan - Draft.3 Delta

Status: DRAFT VALIDATION RECORD

Date: 2026-07-13

Scope: repository files excluding `.git/`, `.connector/`, `node_modules/`, and
generated `dist/`.

Checks run:

- `npm run test:all`
- Local identity/case marker scan for local user paths, case-workspace terms,
  browser profile/state markers, and known imported-data markers
- AWS, OpenAI/OpenRouter, Google, and GitHub token shape scan
- Private-key header scan
- Bearer-token and password/client-secret assignment scan
- New binary/archive/runtime-state file inspection
- `gitleaks` availability check

Result:

- `npm run test:all` passed.
- No local user path, case-project marker, case fact, key, token, private key,
  bearer, password, client-secret, binary/archive, database, key file, browser
  profile, or runtime-state file was detected.
- One token-scan hit was the synthetic `data.secret` rejection fixture in
  `test/contract/schemas.mjs:86`, filtered as a known negative test.
- Browser-profile/state matches are prohibition text and existing connector
  documentation.
- `gitleaks` is not installed, so this record uses the repository-local pattern
  scan plus manual disposition rather than a gitleaks ruleset.
- Final local scan markers:
  `NO_LOCAL_IDENTITY_OR_CASE_PATTERN_HITS`;
  `NO_SECRET_TOKEN_OR_PRIVATE_KEY_PATTERN_HITS_AFTER_SYNTHETIC_FIXTURE_FILTER`.
