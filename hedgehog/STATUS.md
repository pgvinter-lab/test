# Hedgehog Program Status

## Current phase

Program bootstrap and architecture validation before hardware arrival.

## Verified facts

- The governing 60-day engineering doctrine has been authored.
- The target architecture is virtualized, diskless for compute nodes, and uses one persistent storage/control node.
- The target inference fabric is 100GbE with RoCEv2 or EDR InfiniBand.
- Whole P100 passthrough and NUMA-aware placement are required.
- SK Companies is intended to run production workloads on Hedgehog, with commercial frontier models retained for high-value review, legality sanity checks, and escalation.

## Current blockers

- Physical GPU hosts, P100s, and fast-network hardware have not arrived or been selected.
- No private GitHub repository is currently connected; the available repository is public.
- The scheduled Antigravity trigger still requires creation in the user's Google environment.

## Next task

Convert the doctrine into a dependency-ordered GitHub issue graph and write ADR-0001.
