# Spec Gate repair historical progress seeds

These three `.json.br` files contain only the canonical `specs/` tree produced by Sennel at Git revision `7e49c90d2`. Each archive is a Brotli-compressed JSON array of `[relativePath, base64FileContents]` pairs. Tests expand each archive into a unique temporary root and read it with the current `FlowManager`.

The seeds were generated through the old `createSpecGateRepairScenario` fixture and its normal `reserveWorkerCall` → sealed response → `prepare` → `SpecGateRepairStep` path. No progress artifact was edited after publication.

| Seed | Gate locations | Old completed locate generations | New ordinal-aware location batches |
| --- | --- | ---: | ---: |
| `ordinal` | 13 ordinal locations | 3 of 26 | 0 |
| `mixed` | 2 ordinal and 11 free-text locations | 3 of 26 | 22 |
| `equal-count` | 12 ordinal and 1 free-text location | 2 of 26 | 2 |

The equal-count seed ensures old batch numbers cannot be reused merely because the new plan has the same number of batches. All archives retain the old claimed, publication, completed, Step receipt, and budget artifacts.

An unfinished old locate handoff cannot be moved to a different root: its request identity and payload paths are bound to the directory where the old writer created it. For the migration check, generate the `ordinal` seed's next locate request with the `7e49c90d2` coordinator **in the same root**, call `SpecGateRepairService.reserveWorkerCall`, write an empty locate response, and seal it without preparing or completing it. Register that root as an active direct Flow, then invoke the current `RunDispatchCommand` there with its captured binding. The isolated check returned `FLOW_SPEC_GATE_REPAIR_PLAN_CHANGED` with the guarded binding and saved batch index 3; provider calls stayed at 0, the spent call count stayed at 4, and the canonical state, activities, catalog, and Spec bytes were unchanged. The old request's absolute root prevents retaining this particular handoff as a portable archive.
