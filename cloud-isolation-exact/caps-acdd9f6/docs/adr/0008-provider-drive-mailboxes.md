# ADR 0008: Provider-Addressed Drive Mailboxes

Status: SUPERSEDED FOR NEW WORK BY MAILBOX V2 (2026-07-17)

This ADR preserves the mailbox-v1 decision and threat model. Mailbox v2 retires
new Gemini work, keeps historical Gemini rows and Drive objects immutable and
read-only, limits Chrome automation to ChatGPT, and delivers Antigravity work
through a local subscription-authenticated MCP plugin. The explicit migration
and current operational contract are documented in
`contracts/mailbox-v1-draft/README.md`.

## Context

The owner wants Bridge to place messages where ChatGPT and Gemini can receive and
answer them with minimal manual copying. Google Drive synchronization cannot
safely arbitrate mutable claims, and neither chatbot web product is an autonomous
Drive mailbox poller. ChatGPT custom apps require a remote MCP endpoint. The local
Gemini CLI currently fails before model execution because its installed client is
rejected for this account.

## Decision

Use a host-local SQLite/WAL database as the only mailbox authority. Replicate
complete message and response envelopes to a dedicated `Bridge Exchange` Drive
folder as create-only JSON with adjacent hash-bound ready markers. Expose the
queue to local consumers through a bearer-authenticated loopback broker.

Use an isolated Manifest V3 Chrome extension as the primary consumer for
`https://chatgpt.com` and `https://gemini.google.com`. The extension may prepare a
prompt only after a provider-bound claim. It commits `dispatching` before clicking
Send. Any failure or lease expiry from that point becomes `uncertain`; no
automatic resend is permitted. A separately packaged Gemini CLI MCP extension is
optional and follows the same lifecycle.

Each message is an audited, one-provider, one-origin, one-use authorization.
Creating a different prompt, provider, origin, or second use requires a new
message and approval. The browser adapter never reads or exports credentials,
cookies, profiles, or unrelated page content.

Mailbox v1 supports only `public` and `internal` sensitivity. Confidential or
restricted delivery is rejected until encrypted exchange handling is approved
and implemented. The Chrome adapter creates a new dedicated background tab for
every claim; it never chooses an existing user conversation. A browser-captured
response is immutable evidence of the bytes captured from that dedicated tab,
not cryptographic proof that the provider generated those bytes from the approved
prompt.

## Alternatives

- Poll mutable queue files directly from Drive.
- Require the owner to copy every prompt and response manually.
- Use paid provider APIs and credentials.
- Publish a remote MCP app or third-party tunnel now.
- Omit browser automation and wait for provider-native background plugins.

## Consequences

Chrome must be running and authenticated, provider DOM changes can break
selectors, and uncertain deliveries require owner reconciliation. The design adds
one local process and a local token. In return, claims are atomic, retries are
bounded before dispatch, duplicate prompt submission fails closed, and Drive
remains useful for human-visible exchange without becoming operational state.

The independent Claude review and disposition are preserved at
`docs/reviews/MAILBOX_0.2.0_CLAUDE_REVIEW.md` and
`docs/reviews/MAILBOX_0.2.0_CLAUDE_DISPOSITION.md`.

No public endpoint, paid cloud resource, provider API key, or new Drive recovery
responsibility is introduced. Remote ChatGPT app connectivity remains deferred.
