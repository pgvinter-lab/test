# Bridge 0.2.0 Provider Mailbox — Independent Claude Code Review

Status: REVIEW COMPLETE — DRAFT NOT APPROVED FOR RELEASE OR FREEZE
Reviewer: Claude Code (independent red-team, per `CLAUDE.md` / `AGENTS.md`)
Request: `docs/reviews/MAILBOX_0.2.0_CLAUDE_REVIEW_REQUEST.md`
Branch reviewed: `codex/drive-mailboxes` (uncommitted working tree)
Date: 2026-07-14

This review is advisory. It makes **no implementation handoff**, removes **no
`-draft` suffix**, and asserts **no owner approval**. Earlier reviews and
dispositions are historical and are not modified here.

---

## 1. Scope and method

Read-only static red-team of the working-tree mailbox candidate:

- `src/v2/mailbox/**` (`store.ts`, `service.ts`, `exchange.ts`, `broker.ts`,
  `config.ts`, `provider-mcp.ts`, `install.ts`, `cli.ts`, `types.ts`)
- `src/v2/core/{canonical,errors,ids}.ts` (mailbox dependencies)
- mailbox additions in `src/server.ts` and `src/v2/index.ts`, plus `package.json`
- `contracts/mailbox-v1-draft/**` (schemas + examples + README)
- `integrations/chrome-mailbox/**` (MV3 extension) and the generated Gemini CLI
  extension in `src/v2/mailbox/install.ts`
- `test/mailbox/mailbox.test.mjs`, `test/contract/mailbox-schemas.mjs`
- D-025 (`docs/DECISION_REGISTER.md`), ADR 0008, `contracts/mailbox-v1-draft/README.md`,
  AGENTS boundary language

No custody workspace, case data, browser profile, credential, broker token, live
prompt/response content, or Google Drive content was accessed. Synthetic reasoning
and the repository's own synthetic fixtures only.

## 2. Verification status (READ THIS BEFORE RELYING ON A "TESTS PASS" CLAIM)

The request required running `npm run test:mailbox` and `npm run contract-test`.
**These were NOT executed in this session.** Every command-execution attempt
(`npm`, `node --test`, `node test/contract/...`) and every Bridge MCP call
(`bridge_sync`, `bridge_claim`) returned an unresolved approval gate in this
environment and did not run. I have therefore **not** independently confirmed a
green test run and make no such claim.

What I *can* report from reading the suites (static, not executed):

- `test/mailbox/mailbox.test.mjs` covers: queued→claimed→dispatching→sent→
  completed happy path; idempotency-key reuse rejection; provider binding
  (a `chatgpt` message is not claimable as `gemini`, and a second consumer gets
  `undefined`); completion replay idempotency and `mailbox_response_retry_conflict`
  on changed response; event-chain verification; WAL assertion; audit mirror
  count == event count; and **explicit assertions that the audit file contains the
  `approvalRef` but NOT the raw prompt, NOT the raw response, and NOT the delivery
  token**; pre-dispatch retry vs post-dispatch `uncertain`; and loopback bearer-token
  enforcement (401 without token, 201 with).
- `test/contract/mailbox-schemas.mjs` validates every schema, validates the five
  examples, and adds semantic negative vectors: `useCount:2` rejected, cross-provider
  dispatch authorization rejected, prompt-hash mismatch rejected, short delivery
  token rejected, cross-provider conversation URL rejected.

The coverage is appropriate for the risk areas. **The owner should still require an
actual green run of both suites on this branch before any promotion**, because my
static findings below include at least one functional defect (`::1` host) that the
current tests do not exercise.

**Bridge coordination status:** `bridge_sync` and `bridge_claim` could not be
performed (approval gate), and the CLI fallback (`node dist/cli.js sync`) was
likewise gated. The connector state (`.connector/state.json`) shows control held by
`codex`, no active leases, and a session marked `closed` by the reaper. I did not
edit `.connector/` and did not touch any file other than this review. `bridge_log`
and `bridge_handoff` should be issued once approvals clear (see §11).

## 3. Release position

**Do not approve, freeze, or promote beyond DRAFT.** This is consistent with the
artifact's own labels (`contracts/.../README.md` "DRAFT", ADR 0008 "INDEPENDENT
REVIEW PENDING", package `0.2.0`) and with the D-021 authorization gate in
`AGENTS.md`.

On the merits, the **local authority core is strong**: SQLite/WAL with
`BEGIN IMMEDIATE`, a partial unique index enforcing one active delivery per message,
`STRICT` tables, immutability triggers, a hash-chained event log with a
tamper-evident JSONL mirror, hashed delivery tokens, `timingSafeEqual` bearer auth,
loopback binding, and create-only hash-bound Drive envelopes. The audit
raw-content/token exclusion requirement is met in code and asserted by tests.

I found **no CRITICAL defect** under the stated local-trust threat model. I found
several **MEDIUM** issues that should be resolved before any promotion, and two
**policy considerations** that are owner-approved but deserve to be recorded as
material. Details follow; each is tagged **[Defect]** or **[Policy]**.

## 4. Findings by severity

### CRITICAL
None identified under the local single-user trust model (loopback + bearer token +
immutable audit). The severity of §4 MEDIUM items would rise if the trust boundary
were ever relaxed (multi-user host, shared machine, or a non-loopback broker).

### HIGH
None that block within the draft trust model. The closest candidate is
**M-1 (delivery-token exposure to third-party page context)**, which a stricter
reviewer could rate HIGH; I rate it MEDIUM and preserve the disagreement in §7.

### MEDIUM

**M-1 [Defect] Delivery token is handed into a content script running on the
third-party provider page.**
`integrations/chrome-mailbox/background.js` stores the full `/v1/take` claim
(which includes `deliveryToken`) and passes `pending.claim` into the page via
`chrome.tabs.sendMessage(tabId, { type: "bridge-mailbox-prepare", claim })` and
again for `collect`. `content.js` only consumes `claim.message.{recipient,prompt,
expiresAt}` — it never needs the token. The delivery token is a bearer capability
that lets the holder mark `dispatching`/`sent`, `complete`, or `fail` the delivery.
Injecting it into an isolated-world content script on `chatgpt.com` /
`gemini.google.com` is an unnecessary least-privilege violation: the secret now
lives in the same renderer process as untrusted provider page code, protected only
by the isolated-world boundary. **Fix:** strip `deliveryToken` (and other delivery
internals) from the object sent to the content script; keep the token in the service
worker and pass only `{ recipient, prompt, expiresAt, messageId }`.

**M-2 [Defect] `::1` (IPv6 loopback) is an advertised broker host but is broken.**
`config.ts` and `config.schema.json` accept `host ∈ {127.0.0.1, ::1}`, but the
broker builds URLs by string concatenation without bracketing:
`http://${host}:${port}` in `broker.ts` `start()`, in `new URL(request.url, base)`
inside `handle()`, and in `service.ts` `doctor()`. For `::1` this yields
`http://::1:7319`, which is a malformed authority; `new URL()` will throw on every
request, so an `::1`-configured broker rejects all traffic. Independently, the
Chrome extension's `loadConfig` only accepts
`^http://(127\.0\.0\.1|localhost):\d+$`, so it cannot reach an `::1` broker at all.
**Fix:** bracket IPv6 hosts (`http://[${host}]:${port}`) everywhere and extend the
extension loopback regex, or drop `::1` from the allowed set until supported.

**M-3 [Defect] Exchange object writes are not atomic; a torn write cannot be
reconciled and forces `uncertain`/failure.**
`exchange.ts` `writeImmutable()` does `openSync(path, "wx")` then `writeFileSync`
then `fsync`. A crash between create and full write leaves a partial/zero-byte file.
On any retry, `writeImmutable` reads the existing bytes and requires
`existing.equals(bytes)`, which now fails with `mailbox_immutable_object_collision`;
the object can never reach its recorded hash. For a response this blocks `complete()`
(the write throws before `completeDelivery`), stranding the delivery until lease
expiry → `uncertain`; for a message it wedges the send/idempotency retry into
`failPreparation`. Note `config.ts` already uses the correct pattern
(`writeJsonAtomic` = temp file + `rename`); the exchange should match it.
**Fix:** write to `*.tmp` then atomic `rename` for exchange objects and ready
markers (rename-into-place preserves create-only semantics and eliminates torn
immutable files). Low probability (local-disk write window), real consequence.

**M-4 [Defect/Policy] `sensitivity` is decorative — it gates nothing.**
`sensitivity ∈ {public, internal, confidential, restricted}` is accepted, stored,
and echoed, but no code path branches on it. A `restricted` prompt and its response
are still written verbatim to the Google Drive `Bridge Exchange` and still delivered
to the third-party provider, identically to `public`. The field implies differential
handling that does not exist, which is a false-assurance risk in a case-adjacent
project. **Fix:** either enforce (e.g. suppress Drive replication and/or refuse
delivery above a configured sensitivity) or explicitly document the field as
advisory-only metadata in the contract and tool descriptions.

**M-5 [Defect] Tab selection uses `tabs[0]`; response attribution and accidental
submission into a user's live conversation are possible.**
`background.js` `providerTab()` returns `chrome.tabs.query({url})[0]` — an arbitrary
existing provider tab — and only opens a dedicated tab when none exists. `content.js`
`prepare()` guards against a *non-empty, differing* composer, but if the user's
active tab has an empty composer, the extension types and submits the approved prompt
into that conversation and then scrapes `nodes[nodes.length-1]` as "the response."
This can pollute a user's real chat and mis-attribute the answer. **Fix:** prefer a
dedicated, extension-created tab (or a per-provider pinned tab identified by a
marker) rather than reusing `tabs[0]`; consider a stronger idle/ownership check.

**M-6 [Defect, inherent] No cryptographic binding between the dispatched prompt and
the collected response.** The prompt is hash-bound end to end (envelope
`promptSha256`, ready marker, claim validation). The *response*, by contrast, is
whatever the DOM scraper returns; its `responseSha256` is computed over the scraped
text, so it authenticates "what we scraped," not "the model's answer to this prompt."
This is intrinsic to browser scraping and is acknowledged in ADR 0008 consequences,
but it means a wrong-node, injected, or truncated capture is recorded as the
authoritative, immutable response. **Mitigation to record:** `collect()` stability
heuristic (3 stable polls, generation-stopped) and the 1 MiB cap reduce, but do not
eliminate, mis-capture. Keep `uncertain` reconciliation prominent in operator docs.

### LOW

**L-1 [Defect] CORS `allowedOrigins` includes the provider web origins.**
`config.ts` seeds `allowedOrigins = [https://chatgpt.com, https://gemini.google.com]`
and `broker.applyCors` echoes an allowed `Origin` back. The real consumer (the
extension service worker) does not need these entries. Their presence means a script
on a provider page could make readable cross-origin calls to the loopback broker —
still gated by the bearer token it does not possess, so low risk, but an unnecessary
surface widening that compounds M-1. **Fix:** default `allowedOrigins` to empty (or
the extension origin only).

**L-2 [Defect] Broad `tabs` permission.** `manifest.json` requests `tabs`, exposing
URL/title of *all* tabs. Given host permissions for the two providers, querying can
likely be scoped without the global `tabs` grant. Minimize per least privilege.

**L-3 [Perf] Audit verification is O(n) per event → O(n²) overall.**
`flushAuditMirror()` calls `assertAuditMirrorPrefix()` (which runs full
`verifyAuditMirror()` reading and hashing the entire JSONL) on **every** appended
event, and `doctor()`/`health()` re-verify the whole file and whole chain. Correct,
but it will not scale; bound the per-flush check to the tail, or verify full chains
only on demand.

**L-4 [Defect] Non-atomic exchange write also blocks the `README.md` seed.**
`ensureReadme()` uses the same `writeImmutable`; if an operator ever edits the
exchange `README.md`, every subsequent `DriveMailboxExchange` construction throws
`mailbox_immutable_object_collision`. Treat the README as best-effort (write-if-absent
without the equality assertion), or exclude it from immutability.

**L-5 [Gap] No migration framework for the mailbox DB.** `bootstrap()` is
`CREATE IF NOT EXISTS` only; there is no `migrations/` analogue for
`bridge-mailbox-v1`. Acceptable for a draft, but a versioned migration path must
exist before any schema change ships, or existing databases will silently diverge.

**L-6 [Defect] `process.execPath` is baked into the generated
`gemini-extension.json`.** `install.ts` hardcodes the current Node binary path at
install time; a Node upgrade/relocation breaks the Gemini CLI extension until
reinstall. Consider resolving Node at launch instead.

### INFO / NITS

- **I-1** Identifier length is off-by-one between layers: contract `identifier`
  allows `maxLength 180`; runtime `validateId` allows `{2,180}` after a leading
  char (effective max 181); `exchange.safeId` allows effective max 161. Harmless
  today, but tighten to one canonical bound.
- **I-2** `provider-mcp.ts` calls `mailbox.take(provider, \`provider.${provider}.gemini-cli\`)`;
  when run for `chatgpt` this yields the mislabeled consumer id
  `provider.chatgpt.gemini-cli`. Cosmetic (the CLI extension is installed for
  Gemini), but rename for correctness.
- **I-3** `broker.handle()` evaluates all five `if (action === …)` branches without
  early `return`. Only one matches, so there is no double-dispatch, but an explicit
  switch/return would be clearer and safer against future edits.

## 5. Positive confirmations (things that are correct and worth preserving)

- **Atomic claims / concurrency:** `claimNext` runs under `BEGIN IMMEDIATE` with
  `busy_timeout=10000`; the partial unique index `mailbox_one_active_delivery`
  guarantees at most one active delivery per message across processes; `attempt`
  is bounded by `max_attempts`. A second concurrent consumer correctly gets no claim.
- **Crash windows:** send is `reserve(preparing) → Drive write → activate(queued)`;
  a crash before `activate` leaves `preparing` (swept to `expired`), and the
  idempotency-keyed retry re-writes the *same* immutable envelope (bytes-equal
  accepted) then activates — clean recovery. Response reservation
  (`prepareResponse` reserves `response_id` before the Drive write) makes
  `complete()` idempotent and replay-safe (verified by the retry-conflict assertions).
- **Duplicate-prompt prevention past dispatch:** once `dispatching`/`sent`, both
  `failDelivery` and the lease sweeper move the message to `uncertain`, never back to
  `queued`; the server-side phase invariant in `markDeliveryPhase` also rejects a
  re-`dispatching`, which is what actually protects the browser's un-recovered
  `submitted` phase from a double submission. Good defense-in-depth.
- **Provider/origin/use binding:** envelope carries a one-provider, one-origin,
  `useCount:1` authorization; `take()` re-validates envelope↔record binding and
  origin; the schema layer rejects `useCount:2`, cross-provider auth, and
  cross-provider conversation URLs.
- **Audit integrity & exclusions:** hash-chained `mailbox_events` with
  no-update/no-delete triggers; the JSONL mirror append + `file_appended` flag are
  committed together and self-heal on partial-append via last-line dedup; **no
  `appendEvent` payload contains raw prompt, raw response, or a delivery token** —
  I traced every call site, and the test asserts the exclusion.
- **Drive separation & traversal defense:** `resolveRelative` and
  `ensureOwnedDirectory` reject `..` escapes and per-segment symlinks (reparse);
  writes are create-only (`wx`); `config.ts` forbids state/exchange overlap and
  keeps the audit mirror under the state dir; the exchange README states the
  non-authoritative boundary. `doctor()` refuses symlinked state/exchange roots.
- **Transport security:** loopback-only bind, random 32-byte bearer token stored
  `0o600` outside VCS, `timingSafeEqual` comparison, `no-store`, 2 MiB body cap.
- **Autostart reversibility:** `schtasks … /RL LIMITED /SC ONLOGON` (unprivileged)
  with a Startup-folder `.vbs` fallback; `removeMailboxAutostart` ends+deletes the
  task and removes the launcher. Reversible and non-elevated.

## 6. Defects vs policy disagreements

- **Defects** (fix regardless of policy): M-1, M-2, M-3, M-5, L-1, L-2, L-4, L-6,
  I-1, I-2, I-3, and the L-5 migration gap. M-6 is an inherent-design defect
  (mitigate + document, cannot be fully "fixed" within the scraping approach).
- **Policy considerations** (owner-approved; recorded as material, not blocking):
  - **P-1 (= M-4 policy half):** raw prompt/response replication to Google Drive is
    explicitly approved in D-025 and ADR 0008. Not a defect. The *defect* is that
    `sensitivity` implies gating that does not exist.
  - **P-2:** `bridge_mailbox_send` (MCP) and the CLI auto-mint an `approvalRef`
    (`approval.direct-mcp.<uuid>` / `approval.direct-cli.<uuid>`) when none is
    supplied, so **the tool call itself is the sole approval** for sending an
    arbitrary prompt to a third-party LLM and replicating it to Drive. D-025's
    "Approved addition" sanctions this (the enqueue is the audited one-message
    approval). I record, without calling it a defect, that this places no
    second-factor human gate between an agent with MCP access and outbound
    delivery + Drive replication; if that is not the owner's intent, require a named
    pre-existing `approvalRef`.

## 7. Preserved material disagreements

- **D/A-1 (severity of M-1):** A stricter reviewer may classify the delivery-token
  exposure to a third-party page context as **HIGH** (a bearer capability crossing
  into an untrusted renderer). I rate it **MEDIUM** because exploitation additionally
  requires defeating Chrome's isolated-world boundary and the token is
  delivery-scoped and lease-bound. The disagreement is preserved; either way the fix
  (don't send the token to the page) is cheap and should land before promotion.
- **D/A-2 (browser scraping as a transport):** ADR 0008 accepts DOM automation as
  the primary consumer. A defensible alternative position is that no scraped-DOM
  answer should ever be recorded as an *immutable authoritative response* (M-6);
  one could require every browser-sourced completion to land as `uncertain` pending
  explicit human confirmation. This is a design-philosophy disagreement, not a code
  defect; recorded for the owner.
- **D/A-3 (`::1` support):** whether to fix bracketing (M-2) or simply drop `::1`
  from the allowed set is an owner call; both close the defect.

## 8. Accepted alternatives and operational costs

- SQLite/WAL local authority + create-only Drive replica (chosen) vs. Drive-as-queue
  (rejected: cannot arbitrate mutable claims) vs. provider APIs (rejected: paid keys)
  vs. remote/public MCP app (deferred). The chosen path's operating costs are real
  and correctly enumerated in ADR 0008: Chrome must run authenticated, provider DOM
  drift breaks selectors (`content.js selectors()` is the maintenance hotspot), and
  `uncertain` deliveries require human reconciliation with no adjudication UI yet
  (deferred in D-025). These are acceptable costs for a draft; they should be
  operator-documented before any promotion.

## 9. Coverage of the 8 required analysis areas

1. **Atomic claims / WAL / multi-process / lease expiry** — Reviewed. Sound
   (§5). Note L-3 perf.
2. **Crash windows / dup-prompt / response reservation / completion replay** —
   Reviewed. Sound (§5); server phase invariant is the real double-submit guard.
3. **Provider/origin binding, approval refs, token handling, CORS/loopback,
   extension privilege** — Reviewed. Binding sound; see M-1, L-1, L-2, P-2.
4. **Drive create-only integrity / traversal / reparse / separation** — Reviewed.
   Traversal & reparse defenses good; see M-3 (atomicity), L-4.
5. **JSONL audit concurrency / immutability / completeness / replay /
   raw-content & token exclusion / tamper detection** — Reviewed. Strong; exclusions
   confirmed by code trace and test. Perf note L-3.
6. **Chrome SW restart / DOM selectors / accidental submission / attribution / tab
   selection / login assumptions** — Reviewed. See M-5, M-6; `submitted` phase is
   not an explicit recovery branch but is caught by the server phase invariant.
7. **Gemini CLI extension install/runtime boundaries + documented fallback** —
   Reviewed. Lifecycle mirrors the browser; `GEMINI.md` scopes usage; the documented
   account/client-failure fallback (Chrome Gemini path) is consistent with D-025/ADR.
   See L-6, I-2.
8. **Autostart reversibility / unprivileged / packaging / schemas / tests /
   migration & versioning** — Reviewed. Autostart reversible & unprivileged (§5);
   packaging `files`/`bin` correct; schemas well-formed; **tests not executed this
   session (§2)**; migration gap L-5.

## 10. Recommendation

Keep the mailbox as an **experimental DRAFT** behind the D-021 gates. Before any
promotion beyond draft, at minimum: (a) run and confirm both required suites green
on this branch; (b) fix M-1, M-2, M-3; (c) resolve M-4 (enforce or explicitly
demote `sensitivity` to advisory) and M-5 (dedicated tab); (d) confirm the owner's
intent on P-2 (auto-approval). None of this constitutes approval — that decision is
the owner's alone, and this review makes no such claim and no implementation handoff.

## 11. Bridge coordination follow-up (could not complete in-session)

Because `bridge_sync`/`bridge_claim` and the CLI fallback were blocked by the
session's approval gate, once approvals clear the reviewer should:
`bridge_sync` → (lease already intended for this file) → `bridge_log` summary
"Independent Claude review of 0.2.0 provider mailbox; DRAFT not approved; MEDIUM
findings M-1..M-5 recorded" with files `["docs/reviews/MAILBOX_0.2.0_CLAUDE_REVIEW.md"]`
→ `bridge_release` the review lease → `bridge_handoff to: codex` with a pointer to
this file. No runtime source, contract, test, config, browser state, Drive content,
or custody workspace was modified by this review.
