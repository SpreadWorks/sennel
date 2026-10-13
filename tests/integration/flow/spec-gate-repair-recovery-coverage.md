# Spec Gate repair recovery causal coverage

`spec-gate-repair-recovery.test.js` starts from an actual normal dispatcher
publication and terminal Error. Its isolated immutable code seed restores only
the retired `stableBytes(input.edits) > 32 * 1024` constructor predicate from
`2ba144ef64c3e3cf02367895e3da91e5a41791d6`. External worker output is fake;
the factory, selection, Definition, Step, publication and Store remain real.
Each case has a unique temporary Flow root. No existing Flow is modified.

| Guaranteed outcome | Required condition and legal producer | Authority and consumer | Covering case |
| --- | --- | --- | --- |
| Preview is read-only and identifies a corrected legal candidate | Normal worker publishes a 34,522-byte edit; the historical predicate produces Error; corrected factory accepts the same saved proposal | Canonical publication and Error receipts, generation, claim, progress and budget; newly reconstructed Manager preview | Preview/recovery/dispatch/Review scenario |
| Recovery appends once without claiming Spec or Gate success | Exact Error and preceding publication belong to the same Attempt, generation and claim; inputs remain unchanged | Recovery Activity and receipt retain publication authority; original journal prefix, Spec, progress, provider count and budget survive | Preview/recovery/dispatch/Review scenario and public CLI scenario |
| Normal resumed Step publishes the accepted artifact once | Recovery proof authorizes only its saved proposal and corrected selection | Reloaded dispatcher uses normal factory/Service/Store; Spec snapshot, audit and terminal receipt are atomic | Preview/recovery/dispatch/Review scenario |
| Next Review actually consumes the repaired artifact | Normal publication selects Review and creates revision-bound Review input | Actual dispatcher invokes Review worker; worker reads canonical Review identity and immutable Spec snapshot; Review publication survives reload | Preview/recovery/dispatch/Review scenario |
| Input change cannot reuse approval | Current rules differ from the saved input, before explicit apply or after Step selection | Public recovery acquisition and Store admission reread canonical evidence | Pre-apply rule drift and pre-publication rule drift cases |
| Unchanged input does not imply permission for a no-change candidate | Oversized unchanged replacement is legally published and rejected by historical producer; corrected proposal changes no Spec value | Same factory distinguishes unchanged input from no accepted candidate change | Unchanged candidate refusal |
| Invalid candidates stay rejected | Historical producer publishes an oversized replacement with an out-of-bounds byte range | Corrected factory rejects its invalid group; preview/apply leave Error, catalog, progress and costs unchanged | Invalid candidate refusal |
| Target authority and preview approval cannot be reused | Wrong run, Spec, issue or foreign authority binding; different digest or target than approved preview | Actual registered command parsing and shared target guard; Manager digest check | Target/digest refusal case |
| Exact replay cannot drift | Completed recovered normal receipt is durable; binding, Result/selected target, Settlement or publication differs | Normal Store exact receipt reuse; every refusal protects canonical snapshot | Recovered terminal replay connection assertions |
| Interruption cannot duplicate recovery | Failure inside the Version transaction before append, after journal append or after state write; caller loses acknowledgement after successful commit | Store fault seam rolls back pre-commit effects; fresh Manager rereads a committed single receipt before explicit replay | Three rollback cases and separate committed lost-acknowledgement case |

The existing `spec-gate-repair-canonical-value.test.js` owns ordinary large
canonical values and Task acceptance; `spec-gate-repair-replay.test.js` and
`spec-gate-repair-restart-boundaries.test.js` own ordinary publication/replay
contracts. `current-flow-state-foundation.test.js` owns general journal and
Attempt invariants. The full `flow-cli/spec-artifact-scenario.test.js` remains
the Spec phase scenario and exercises downstream Acceptance. These are reused,
not replaced by the scoped recovery scenario.

The scoped tests prove reconstruction after injected in-process failures. They
do not claim OS-crash, power-loss, unknown historical-defect, or cross-process
recovery-race completeness. One representative real CLI route is included to
detect command unavailability in an isolated before-fix comparison with the
same test inputs and assertions; syntax/import failures do not count as
regression evidence.

The complete selected-unit restart seed contains 105,600 UTF-16 characters
and 118,800 UTF-8 bytes in `R1.desc` (2,200 repetitions of the original Unicode
text). The former 3,000-repetition seed contained 144,000 characters and could
not pass the normal Gate's scalar input admission. A 2,500-repetition seed
would equal the global 120,000-character hard maximum, which is also refused.
The corrected seed remains above 100,000 characters and retains the same
full-value equality, Unicode, digest, saved-request, sealed-restart, atomic
publication and one-call budget assertions. Neither the Gate's hard maximum
nor the selected input's content is truncated. The Gate fixture uses a short,
independent guardrail condition rather than copying the entire selected Spec
field into a second prompt element.

The locator-only archive scenarios retain the archived observation bytes and
requirement identities as untrusted publication-boundary input. Their carrier
state is now generated by the current normal Gate producer and execution claim:
the original archive's Activity schema lacks `approvalTasks`, so restoring it
directly fails before reaching the locator refusal. Missing Activity fields or
runtime proof are not added to the old archive. The original stale-target
refusal and unchanged canonical-state assertions remain in place.
