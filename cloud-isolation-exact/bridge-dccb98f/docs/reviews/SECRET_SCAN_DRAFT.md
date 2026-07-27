# Secret and Sensitive-Marker Scan

Status: DRAFT VALIDATION RECORD

Date: 2026-07-12

Scope: all repository files excluding `.git/`, `.connector/`, `node_modules/`,
and generated `dist/`.

Checks:

- AWS, OpenAI/OpenRouter, Google, and GitHub token shapes
- private-key headers
- bearer-token and password/client-secret assignments
- email/account and local-user-path markers
- case-workspace terms and browser-profile/state markers

Result:

- No key, token, private-key, bearer, password, client-secret, local account path,
  case-project marker, or case fact was detected.
- One email-shaped match is the synthetic SSH remote example
  `git@github.com:you/my-project.git`.
- Browser-profile/state matches are explicit prohibition text in `.gitignore` and
  architecture/recovery documents.
- `gitleaks` is not installed, so this record uses the repository-local pattern
  scan plus manual disposition rather than a gitleaks ruleset.
- Post-review rerun after incorporating Claude's findings returned
  `NO_SECRET_LOCAL_IDENTITY_OR_CASE_PATTERN_HITS`.

Run the same scan and inspect all new binaries/archives before any push. No binary,
archive, runtime state, or one-off request is currently included.
