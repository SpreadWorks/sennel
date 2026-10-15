# Board 77d0 verification

The implementation starts at `5d2fd96be98d6f8dda79636f10813dc34011f074`
on `codex/77d0`. No production Flow, owner token, capability, or canonical
artifact was used as a test fixture. Provider and external-process responses
are deterministic; canonical producers, Definition, Store, persistence,
readback, and command authorization remain real.

## Outcomes and necessary conditions

| Required outcome | Producer, stored authority and consumer | Evidence |
| --- | --- | --- |
| Every public Flow route reaches a known output owner | Live `FLOW_COMMANDS` and `coreCommandRegistry` leaves, including aliases; separate query and builtin bootstrap boundaries | `routes.json` records 69 routes. `stop-guidance-inventory.test.js` checks registry coverage, lexical code evidence, explicit dynamic families and production adapter connections. Lexical coverage is bounded as described in README. |
| Failed returns, throws and user/host stops explain the original cause | Typed `AgentFailure`, `ProcessExecutionControlFailure`, acquired facts and the already selected directive feed `Envelope.attachStopGuidance()` | `flow-stop-guidance.test.js`, `flow-envelope.test.js`, `stop-guidance-production.test.js` cover locale differences, unknown codes, absent catalogs, missing facts, stop proof and recovery authority. |
| A stopped Step retains its durable result across reload | `recordStepAttempt` produces the Attempt and outcome artifact; filesystem readback reconstructs the typed outcome before the envelope consumes its selected action | `stop-guidance-production.test.js` checks matched Attempt/artifact identity, persisted attempt counts, selected user decisions and newer authorized recovery. Ordinary Decision/Defer outcomes remain unchanged. |
| Exactly one final response includes command and later finalizer failures | Registry hooks, command, runtime-log close, metadata persistence and physical runtime closure finish before dispatcher publication | `dispatcher-stop-guidance.test.js` checks initial plus later errors, typed physical refusal, warning/nonzero exit, pre-initialization refusal, incidental stdout and failed stdout delivery. Existing dispatcher/runtime-log tests retain raw diagnostics and log boundaries. |
| Automatic work keeps its existing authorization | Existing guarded commands, opaque bindings, approval prompts and nonblocking continuation owner select authority; guidance references that same directive | Existing dispatcher recovery, next-action, nonblocking, command-binding and dispatch CLI tests; common tests reject conflicting directive identity and altered stored presentation. Cross-locale readback keeps the saved presentation verbatim. |
| Query and bootstrap preserve their separate wire boundaries | Query revision 3 validates its independent serializer; pre-semantic bootstrap uses only Node builtins and fixed runtime proof | Query contract/design, public CLI, native-parser privacy, revision-2 cursor rejection and fixed bootstrap probes. Success responses remain read-only and single JSON. |
| Draft artifacts survive production, reload and downstream use | Registered Draft Review/Gate commands persist canonical artifacts and settlement receipts; new managers and actual Spec/Acceptance readers consume them | `draft-artifact-scenario.test.js` checks question answers, Attempt ordinals, repair, refusal atomicity and exact findings consumed downstream. |
| Spec artifacts survive production, recovery and downstream use | Registered Spec commands and Store persist Spec, Review, repair, Gate and bounded continuation evidence; Approval/Test/Acceptance consume reloaded artifacts | `spec-artifact-scenario.test.js` checks stopped-worker recovery, repair, strict stop, large artifacts and Draft regeneration without inventing evidence. |
| Guidance documentation matches the public API | `src/AGENTS.md` is authoritative; root/Flow rules link to it; source skill includes the shared partial | `validate:skills`, `sennel upgrade`, inventory and skill regressions. |

## Board acceptance conditions

| Condition | Acceptance evidence |
| --- | --- |
| AC1: all routes, codes and publication owners inventoried | Source-derived 69-route inventory; independent query and builtin bootstrap adapters are checked by the current inventory test. |
| AC2: every stop class explains cause, state and action in either mode | Shared envelope/production tests and dispatcher boundary tests, including raw returns, later hook/log/metadata/physical-close failures and pre-initialization refusals. |
| AC3: typed cause, proof, authorization and locale remain distinct | 33 shared unit/integration cases, typed recovery tests, Japanese/English catalogs, unknown-code/catalog fallback and unconfirmed-fact cases. |
| AC4: preserve selected actions and existing approval/policy/binding | Directive tests, approval-staleness CLI test, typed nonblocking before/after test, retained nested approval regression, and existing nonblocking scenarios. |
| AC5: wire, privacy, nested failure and ordinary success contracts | Query revision-3 schema/design and public entrypoints; native-parser privacy; exact raw success bytes; single final JSON with initial and later errors. |
| AC6: rules and skill agree with the API | Canonical `src/AGENTS.md` rule, short root/Flow links, shared skill partial, seven valid manifests and successful upgrade. |

## Measured results

Final logs are retained under `.tmp/77d0/` in this worktree. Intermediate
failed integration runs are retained separately and are not reported as
successful verification.

| Log | Measured result |
| --- | --- |
| `dispatcher-boundary-final-2.log` | 86/86 passed, including the final stream and native-parser changes. |
| `guidance-acceptance-final.log` | 32/32 passed: 22 unit cases and 10 integration cases including the full route inventory. |
| `guidance-metadata-final.log` | 33/33 passed after the nested-metadata correction. |
| `dispatcher-raw-publication-final.log` | 93 passed, 0 failed; 7 report cases cancelled by their existing invalid producer setup. This includes all dispatcher/runtime-log cases and the new raw publication cases. |
| `report-show-legal-producer.log` | All 7 original report-show cases passed after correcting only their canonical producer setup; no cancellations. |
| `directive-contract-final.log` | 21/21 passed: 7 unit cases and 14 Step outcome/skill liveness cases. |
| `query-digest-final.log` | 52/52 passed: query schema/design, CLI and runtime entrypoint regression cases. |
| `query-native-syntax-private.log` | 2/2 passed for direct/wrapped parser failures and linked-main configuration privacy. |
| `query-revision3-cursor.log` | Revision-2 cursor refusal passed. |
| `query-finalized-dispatcher-final.log` | 3/3 finalized-query lifecycle, read-only roundtrip and safe history-refusal cases passed with legal producers. |
| `changed-action-final.log` | Original CLI approval-staleness case passed after retaining nested action metadata. |
| `runtime-recovery-isolated-final.log` | Concurrent SIGKILL recovery passed on final source without changing its assertions. See the wider-run limitation below. |
| `dispatcher-policy-final.log` | 52/52 dispatcher, configuration, recovery and stop-publication cases passed. |
| `dispatcher-selection-final.log` | 17/17 final-source publication, retained nested selection and current inventory cases passed. |
| `process-nonblocking-continuation-after.log` | The identical typed process-refusal regression passed after restoring the existing guarded nonblocking refresh. |
| `process-nonblocking-selected-nested.log` | Existing approval directive, choices, command and binding survive a later typed physical refusal without a competing automatic continuation. |
| `spec-final-source.log` | 4/4 affected Spec scenarios passed on the final immutable source: Draft regeneration, advisory repair and large inline/file Gate findings through real persistence and consumption. |
| `current-nonblocking17-isolated.log` | Original Task Review recovery-connector case passed in isolation; the identical baseline case also passed. The matrix interaction is explained below. |
| `nonblocking-final-source.log` | 30/35 passed, 5 failed, no cancellations. All activation/repair/continue transaction, Gate selection, bounded Flow Review tooling, provider/local-invalid Task Gate, publication-refusal and dispatcher-decision cases passed. The five fixture/interaction failures are documented below; the recovery-connector case passes separately in isolation. |
| `validate-skills-final.log` | All 7 skill manifests valid; invoked with the normal runtime preload. |
| `upgrade-final.log` | Project skills upgraded successfully from the final source skill/partial. |

The wider immutable run is tracked by `verification-manifest.json` and
`acceptance-frozen.log`: 178/223 integration cases passed, with 45 failures.
Its source snapshot predates the final native-parser, stream, raw-publication,
nested-metadata and policy-preservation corrections. Dedicated results above
replace the affected groups rather than treating this old run as final-source
evidence. All nine Draft scenarios passed. Five Spec scenarios passed in the
wider run; the four affected by nested-metadata rejection subsequently passed
on final source. Together these cover all nine original Spec scenarios, without
claiming they were one final-source full-suite run.
The final source manifest and delta record identify the exact files covered
by each run.

## Before/after evidence

`dispatcher-baseline.log` runs the same seven regression cases against the
isolated base revision: all seven fail their intended publication/guidance
contracts. Those seven cases pass in `dispatcher-boundary-final-2.log`.
The frozen seven-case test file is retained as local evidence. This comparison
did not alter the active checkout or any real Flow.

`bootstrap-baseline-probe-final.log` fails all three representative public
boundary probes (unknown command, invalid query JSON, semantic module-load
failure); `bootstrap-fixed-probe-final.log` passes all three with the same
probe inputs and assertions.

`native-command-before.log` reproduces disclosure of an unlabeled input
snippet through the actual Task Review command's failed-return path.
The same test and input pass in `guidance-acceptance-final.log` after the
input boundary stops embedding the native parser excerpt. The admission
code and unchanged-state behavior remain intact.

`raw-publication-before.log` fails all three new raw-output regression cases
against the immutable pre-fix source; the same inputs and assertions pass in
`dispatcher-raw-publication-final.log`. They cover returned refusals, a later
hook failure after candidate text, and unchanged successful text bytes after
finalizers.

The baseline approval-staleness CLI case passes. The pre-fix implementation
fails it because ordinary worker instruction prose at
`nextAction.instructions.content` is treated as executable authority. The
response-contract fallback then drops the original action metadata.
`changed-action-diagnosis.json` and `nested-metadata-before.log` record this
fault; `changed-action-final.log` and `guidance-metadata-final.log` verify the
correction. Only continuation `nextAction` strings are executable authority;
dispatch metadata objects use normal public redaction.

`process-nonblocking-continuation-before.log` fails the exact typed process
refusal case because the failed envelope loses its existing guarded read-only
refresh. The identical case passes in
`process-nonblocking-continuation-after.log`. The common continuation owner
selects the command and binding; the dispatcher preserves an already selected
top-level or nested directive and selects a missing continuation only after
merging failures. No worker retry or recovery capability is introduced.

## Dispatcher publication follow-up

Review of the lifecycle boundary exposed a broader candidate-retention contract.
The dispatcher now keeps the command's candidate response while `onError`,
`post`, nonblocking evidence recording, and lifecycle recording run. A
replacement response produced by `post` becomes the candidate while prior
causes remain attached. Failure aggregation reuses the existing acceptance and
deduplication rules, including distinct messages that share an error code. A
physical recorder refusal is also fed through the existing canonical metadata
guard, so later canonical Step runtime metadata writes cannot follow an
unconfirmed physical stop.

This maps to **AC2** because the final guidance retains the original cause,
current stop and persistence facts, and the selected action through later
lifecycle failures. It maps to **AC5** because one final publication carries
the replacement or retained command data and all distinct causes, while
preserving the existing single-response and successful raw-output contracts.
The existing tests for route inventory and recovery selection continue to cover
their own contracts; no query, bootstrap, locale, or skill code changed in this
follow-up, so their recorded evidence above is reused without rerunning those
suites.

The pre-fix evidence is retained in `followup-before.log` (five candidate
retention cases: one passed and four failed their contract assertions) and
`followup-extra-before.log` (both physical lifecycle persistence and duplicate-
code/different-message cases failed). These copies use the same tests and
assertions against the pre-follow-up dispatcher. The original two-case probe,
retained as `.tmp/77d0/review-returned-failure.test.mjs`, passes after the fix
in `followup-original-repro-after.log` (2/2, exit 0); its original
`review-returned-failure.log` records 1 pass and 1 contract failure. The
broader selected dispatcher run is `followup-dispatcher-final.log`: 56/56
passed, with 0 failures, skips, or cancellations. It ran through `node
tests/run.js` with the dispatcher, stop-guidance, recovery-directive, and
inventory integration files selected. The tested source and expanded test
hashes are respectively
`52ee4a54b6ea6ac254d8cc11a2c6328ecc6b2bd19addda608797f65bda29beba` and
`cf81efe4777a647f78a45d2ab4389217337e85fc994a200b68cc645db0623113`;
`followup-source-delta.json` records the comparison across 1,877 files and
shows only `src/lib/dispatcher.js` and
`tests/integration/lib/dispatcher-stop-guidance.test.js` changed in that
snapshot. The exact original two-case probe is reported separately because
the lifecycle case in the expanded test was strengthened and renamed; the
five-case pre-fix result is not presented as an exact post-fix rerun.

The fresh-seed Draft phase scenario passes in
`followup-draft-scenario.log` (1/1, exit 0, no skips or cancellations). Its
test body hash matches the prior 1,877-file source manifest; it produced Draft
artifacts through registered Review/Gate commands, reloaded them, and exercised
the actual Spec and Acceptance consumers. The fresh-seed Spec phase scenario
passes in `followup-spec-scenario.log` (1/1, exit 0, no failures, skips, or
cancellations). It ran the original strict-stop scenario against a fresh
producer seed, without the archived seed or a test adapter. The unchanged
scenario exercised the current Spec Gate post replacement, canonical stop
readback, nonblocking continuation, and Acceptance consumption. Across the
selected dispatcher run, exact repro, Draft scenario, and Spec scenario, these
follow-up checks report 60 passing cases; no repository-wide suite or full
final-source wider run is claimed.

The pre-fix source/test copies are retained in
`followup-before-inputs.tar.gz`; their manifests and logs remain separate.
`followup-final-manifest.json` records the final file identities, selected
commands, results, and acceptance audit. The follow-up freshness check returned
`fresh`. No skill or preset artifact changed in this follow-up.

## Main integration verification

Implementation commit `c8955c085` is integrated with main `874b47dfe`.
There were no textual conflicts. The combined source preserves main's GitHub
provider configuration and Issue/report paths, and its `mergeStrategy`-selected
squash-only failure metadata commit. The shared dispatcher and stop guidance
remain the verified implementation above. The existing inventory producer
refreshed the 69-route artifact to include `GITHUB_INVALID_REQUEST` from main.

`merge-boundary-regression.log` records 81 passing selected cases: 15 unit and
66 integration checks across guidance, dispatcher, inventory, provider
configuration, consumers, and finalization lifecycle selection.
`merge-finalization-regression.log` confirms the provider preflight refusal.
Its combined invocation did not emit the other selected case's result, so
that missing observation is not counted as success. The unchanged PR response
loss case passed separately in `merge-pr-response-loss-isolated.log` (1/1).
`merge-report-regression.log` confirms report response-loss recovery (1/1).
Together these provide 84 observed passing cases, without a full-suite claim.
The scenarios use temporary local Git repositories and fake GitHub providers;
they do not create a real GitHub pull request or comment.

`merge-tested-inputs.json` records the source and test identities used for this
integration. Local verification inputs and logs are preserved before worktree
removal in main's `.tmp/merge-evidence/77d0-c8955c085.tar.gz`.

## Existing query fixture corrections

The frozen wider query regression run in `query-isolated-regression.log`
passes 83/86 cases. Its three finalized-history cases fail during fixture
setup, before querying. The same setup contract fails at the base revision
with `file-map trust input is required for integration gate`;
`query-lifecycle-baseline-evidence.json` records matching test, fixture,
setup-helper and Gate hashes for that comparison.

The finalized fixture must generate a real source mutation so the normal
handoff/Store creates `file.map`, use the existing managed-fixture ignore
policy before capturing Git context, and execute finalization through the
normal dispatcher so registry-owned operation tokens reach the command.
No Gate, lock, query assertion, or read-only snapshot requirement is weakened.

The report-show fixture had the same missing-file-map precondition and is
corrected through its own existing `sourceMutations` option. Its assertions
are unchanged; the normal implementation handoff and Store generate the map.

## Wider regression observations

`baseline-review-selected.log` measures five existing dispatch-CLI setup or
handoff failures at the base revision: missing handoff rather than the
expected exhausted-retry code, an unproven direct Node helper, an obsolete
Spec repair stage, and two invalid Acceptance fixture/admission paths.
The selected test-body and direct-fixture hashes are recorded in
`baseline-review-manifest.json`. These failures are not changed to obtain a
green suite.

The final-source nonblocking implementation test's nominal-quality case now
passes the earlier metadata boundary but stops at its bare worker subprocess:
`RUNTIME_UNPROVEN` occurs before the intended provider-error marker.
`worker-load-{baseline,current}.log` and `worker-load-manifest.json` reproduce
that same worker-load refusal on both revisions. The full test, worker,
`runtime-package.js` and `presets.js` are byte-identical, and neither probe
writes to its empty working root. This is a bounded worker-invocation probe,
not a claimed full-case baseline run. That case's later provider propagation,
unchanged-state assertions and quality-selection admission are not reached;
the test is not weakened or counted as successful.

Its bounded Flow Review tooling case stops at the existing parent/child config
digest check. The scenario supplies no `options.config`, so the parent claim
captures `{}`; the test separately writes a nonempty disk configuration that
the worker loads. `nonblocking-case3-config-manifest.json` records identical
case, worker, helpers and Review/config-owner hashes at base/current. This
static attribution supports an inherited fixture inconsistency; it is not a
measured full baseline scenario. The intended tooling classification and later
child-frontier acceptance are not reached in that case.

The existing nonblocking matrix's retro and acceptance setup also reaches an
unchanged canonical guard: `prepareScenario()` directly calls generic
`publishCurrentAttemptResult` for an implementation result that requires its
atomic selected Result and settlement receipt. The guard rejects that setup
with `CURRENT_FLOW_STATE_INVARIANT_INVALID` before the eligibility assertion.
`nonblocking-generic-publication-manifest.json` records byte-identical test,
Store and command-owner files at base/current. This is static comparison,
not a full-case baseline measurement; those cases are not counted as passing.

The matrix's Task Review recovery-connector case fails in setup when its
explicit throwing process callback is bypassed. The identical selected case
passes independently on baseline and current (`baseline-nonblocking17.log`,
`current-nonblocking17-isolated.log`, with matching inputs recorded in the
manifests). A bounded probe using the actual byte-identical
`installCommandProcessFake` helper reproduces a restoration defect on both
revisions: install A, install B, restore A, restore B leaves A installed, and
the explicit callback is never called. Earlier multi-scenario cases register
that FIFO cleanup order. `mock-restore-probe.mjs`, paired logs and
`mock-restore-manifest.json` retain this evidence. This proves the helper defect,
not a measured full-matrix baseline result; the original isolated test verifies
the intended recovery-connector behavior on current source without test edits.

The proper-HEAD runtime suite in `process-runtime-admission-final.log`
passes 12/13 cases, including typed lifecycle refusals, nested restoration,
physical admission through metadata commit, and sealed crash recovery.
Its concurrent unsealed SIGKILL case once returns the safe typed
`PROCESS_EXECUTION_OUTCOME_UNSEALED` refusal where the test expects a busy
refusal. The identical isolated case passes on both the base revision and
final source (`baseline-runtime-recovery.log` and
`runtime-recovery-isolated-final.log`). That scheduling-sensitive wider-run
observation is retained, rather than claimed as a reproduced baseline failure
or hidden by weakening the assertion. Physical runtime admission/recovery
algorithms are unchanged by this board.

The first immutable wider copy had no Git HEAD, so its process-runtime suite
could not start its verification hook. Those cancelled/setup failures do not
count as runtime behavior evidence; the proper-HEAD run above replaces them.

The final Spec rerun uses a byte-recorded immutable strict-stop seed that the
normal registered producers created during the wider run. Only the isolated
test copy replaces seed creation with the existing `CanonicalScenarioSeed`
constructor; the production source, scenario helper and all assertions remain
unchanged. Normal clone/readback validation and `assertUnchanged()` still run.
`strict-seed-manifest.json` and `final-phase-manifest.json` record these inputs.
The four affected cases exercise their real repair/regeneration producers and
downstream consumers rather than constructing replacement canonical artifacts.
All 175 retained seed-file hashes still match after the run. Seed inputs are
compressed in `spec-seed-input-evidence.tar.gz`; the isolated test adapter is
retained as `spec-final-seed-adapter.test.js`. The completed verification copies
are removed, while their exact input manifests and final logs remain available.

## Contract changes and limits

Query responses now use schema revision 3. Revision-2 cursors and retired
revision-2 design artifacts are removed rather than supported by a backward
compatibility decoder. Guided stop responses expose the sole authority at
`data.directive`; nested dispatch metadata remains at `data.nextAction`.
`guidance.nextAction` is presentation and never an execution capability.

A presentation digest detects drift during wire readback. It is not an
authentication mechanism; existing canonical bindings, approvals and runtime
checks still decide execution authorization. Unobserved completion,
persistence, timing and stop facts remain `unconfirmed`.

Generated project documentation was stale at task start. Source and the
explicit design artifacts above are authoritative for this change; a full
`docs build` has not been substituted for the requested implementation.
No real AI-provider test is needed because provider execution is unchanged.
These targeted checks do not claim a repository-wide exhaustive test pass.
