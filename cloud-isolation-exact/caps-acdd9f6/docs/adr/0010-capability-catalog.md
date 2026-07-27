---
producer_surface: antigravity
model: Gemini 3.1 Pro (High)
thinking_tier: High
generation_method: reasoned
created_at_utc: 2026-07-24T06:38:40Z
source_revision: HEAD
---

# ADR 0010: Capability Catalog as a Discovery Directory

## 1. Status
Accepted (Owner approved 2026-07-24)

## 2. Context
As Bridge 2.0 expands its capabilities to interact with multiple models, APIs, and tools, it requires a definitive registry to resolve intent to execution. Bridge needs a systematic control plane that acts as a central authority for capability discovery and routing recipes.

## 3. Problem Statement
Without a central capability catalog:
- Routing is ad-hoc, leading to unpredictability in execution paths.
- We cannot guarantee the separation of free and paid capabilities.
- "Unknown" capabilities might inadvertently incur costs or expose boundaries.
- Packages and MCP tools might declare capabilities they do not possess, or that conflict with existing definitions.

## 4. Capability Catalog as a Discovery Directory
The Capability Catalog is explicitly designed to provide discovery and per-caller routing recipes. Catalog answers are hints, NOT an invocation gate. 
Callers keep native access to their own tools. Capabilities do not need to be cataloged in order to be invoked, as the catalog does not block execution ("cannot be invoked unless cataloged" is rejected).

## 5. Authority Tables
The Catalog maintains three strict tables that define the universe of capabilities within Bridge 2.0:
1. **installed_working**: Capabilities that are physically present, fully configured, authenticated, and have passed health checks.
2. **installed_broken**: Capabilities that are physically present but failing health checks, missing credentials, or otherwise misconfigured.
3. **available_for_install**: Capabilities that the system is aware of (e.g., via a remote registry or manifest) but have not been provisioned or instantiated locally.

## 6. Capability Ordering (Paid Rule)
To strictly enforce cost controls and execution safety, the catalog mandates a reflex for capability ranking:
1. **free**: Local models, non-metered APIs, or fully open resources.
2. **unknown**: Capabilities where the cost structure or boundary implications cannot be deterministically proven.
3. **paid**: Metered APIs, cloud runtimes, or any capability that incurs a financial cost. 

The paid rule is: paid capabilities are always down-voted in ranking and never auto-invoked while a free capability can satisfy the intent. This rule is owner-overridable per request.

## 7. Package Decomposition (08-13)
The capability catalog relies on a suite of discrete capability packages. Currently, packages 01 through 07 exist as draft designs. Packages 08 through 13 are explicitly reserved as Codex-owned decomposition work.

## 8. Capability Granularity and Validation
Capabilities must be defined with extreme granularity. This granularity ensures that health checks, authentication state, and routing decisions are applied to the smallest logical unit of work.

## 9. Deployment and Operational Status
The Capability Catalog enforces a strict separation between source/test success and local runtime deployment. The control plane tracks both states independently.

## 10. Bridge 2.0 Architectural Implications
By implementing the Capability Catalog, Bridge 2.0 achieves:
- Deterministic routing discovery based on the three authority tables.
- Hard cost controls via the ranking rule.
- A foundation for future package expansion (packages 08-13).
- Strict separation between execution logic and authorization logic.
