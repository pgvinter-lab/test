# Mailbox V3 Claude Review Disposition

This document records the disposition of findings from the independent review `MAILBOX_V3_CLAUDE_REVIEW.md`.

## Defect and Design Findings (D-1 to D-4)

*   **D-2 (Migration Coverage Gap):** **RESOLVED.** The missing v2->v3 fail-closed migration tests have been added to `test/mailbox/migration.test.mjs`. This includes test cases for nonterminal/active-delivery abort (queued, claimed, dispatching, sent states), backup-restore roundtrip with manifest digest verification, audit/event-corruption fail-closed scenarios, and verification that the v3 `stale_mailbox_writer` fence trigger successfully rejects v2-schema inserts.
*   **D-3 (Decision Register Hygiene):** **RESOLVED.** The Capability Catalog block in `docs/DECISION_REGISTER.md` has been assigned the formal decision ID `D-028`. The extraneous byte-floor padding and elaboration sections were removed. Corrupted text strings (double "a" in available_for_install, double "f" in free=0, and mojibake encodings) were corrected. Section 7 was updated to properly reflect the owner's adjudication that paid capabilities are always down-voted and never auto-invoked while a free capability can satisfy the intent (owner-overridable per request).
*   **D-4 (Installer Hardcode):** **RESOLVED.** The installer in `src/v2/mailbox/install.ts` was updated. It now dynamically derives the `--node` arguments for `webBrowserStartCommand` directly from the user's enabled `config.webNodes` profiles instead of hardcoding `--node perplexity`.
*   *(Other D-findings were informational or previously addressed, e.g. the single runtime flake proven environmental).*

## Process Findings (P-1 to P-2)

*   **P-1 (ADR 0010 Misalignment):** **RESOLVED.** `docs/adr/0010-capability-catalog.md` was wholly amended to match the architectural intent established in `docs/caps/DESIGN.md`. The catalog is now explicitly defined as a directory for discovery and per-caller routing hints, *not* an invocation gate. Callers retain native access to their tools. The paid rule was also accurately reflected: paid capabilities are always down-voted and never auto-invoked while a free capability can satisfy the intent (owner-overridable per request).
*   **P-2 (Byte Floor Padding):** **RESOLVED.** The practice of adding arbitrary "padding for byte floor compliance" to durable artifacts has been stopped. All such padding was stripped from `docs/adr/0010-capability-catalog.md` and `docs/DECISION_REGISTER.md`.

## Observational Findings (O-1 to O-7)

*   **O-1 to O-7:** **ACKNOWLEDGED.** All independent tests executed green without data-corrupting defects. Nonterminal queued messages (`mailbox.message.9dfc22db-*` and `mailbox.message.93497162-*`) were safely dispositioned via sanctioned broker sweeps and validated as empty. The uncertain `0b2155de` message remains untouched for byte-preserved migration.

## Conclusion

All critical findings from the Claude independent review are dispositioned. The test suites have been re-executed and assert 100% pass rates across integration, session, fixes, and mailbox execution targets. The candidate is ready for Phase 6 commit and Phase 7 cutover.
