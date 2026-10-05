## Restart contract from flow review (2026-09-24)

Use the following decisions in the **initial Draft and Spec** when starting this issue again. They supersede conflicting historical audit counts and wording below. They consolidate Draft gate repairs, Spec reviews/revisions 002–008, and remaining gate findings from `specs/338319c6-flow-help-contract/001/`. Revision 008 still has unresolved blocking findings and must not be copied as an approved specification. Recovery of the stopped flow is a separate task.

### 1. Exact scope and option authority

- At source commit `b8b3f59550a12677d6a017bd478881c085d54399`, `FLOW_COMMANDS` has **66 leaves**, of which **65 use the shared routed path**: resume 1, prepare 1, get 11, set 17, run 34, report/show 1. The remaining leaf is query. Re-enumerate from the registry at the next start; do not hard-code 67 or 36 run leaves in acceptance tests. The old omission frequencies below are historical audit claims, not a freshly verified denominator.
- Preserve `flow query` as an explicit custom-parser exception owned by `bootstrapFlowQueryCli`, `src/flow/query.js`, and `src/flow/query-contract.js`. Exclude it consistently from shared option/admission/help projection and exhaustive routed-parser matrices, including any R9/T5 equivalent. Preserve its stdin, `--request-file`, help and error behavior with separate regression checks.
- Extend existing `CommandDefinition` and `FLOW_COMMANDS`; use dedicated option and subcommand-row classes with constructor invariants. An option owns name/aliases, flag/required-value/optional-value kind, placeholder and description; a row owns name, summary and optional display order. Do not add a parallel command registry or reconstruct option authority by reverse-parsing help.
- Store authoritative option metadata explicitly at the registry boundary and share guard/runtime/help definitions. Preserve command-specific prose, examples and localization; translated prose must not replace the structured Usage/Options authority. Define each canonical option once in the Options section (with `-h, --help` on one row); appearances in Usage/examples are not duplicate option declarations. Required and optional values must be visibly distinguishable.
- Group projection uses **all direct child leaves of that group**, not selected examples, nested descendants or unrelated entries. Match full option contracts, including aliases and value kind, rather than names alone. The current groups contain get 11, set 17, run 34 and report/show 1. Derive this inventory and its intersection from the registry. `--agent-work-dir` appears in run group options and not get/set/report.

### 2. Observable rendering contract

- Cover all three public paths: `sennel flow <group> --help`, `sennel help flow <group>`, and `sennel flow <group>` without a leaf (the `src/flow.js` path). The first two alone do not exercise both existing renderers.
- Use one shared row renderer: each row has `<name><padding of at least two ASCII spaces><summary>`, with no truncation or concatenation. For the same group, subcommand rows and option rows have identical order and spacing across entry points; unrelated headings/prose need not be byte-identical.
- Default subcommand order is locale-independent ascending name order. If display-order metadata is used, name its field and propagation in the initial Spec, define ordering for absent/equal values, and retain name order as the tie-breaker. Define deterministic option order once in the shared model (canonical name order is sufficient), including implicit help.
- Test short names, the old 13/14/15-character padding boundary, the longest registered leaf (`recover-missing-producer-artifact` at this baseline), and synthetic 64/65-character segments. The synthetic names belong in renderer/registry integration tests; they are not callable production CLI commands and must not imply a new command-name length limit.

### 3. Preserve real validation owners and input contracts

The initial Spec must include a per-leaf input inventory derived from `positionals`, `rest`, `flags`, `options`, `optionalOptions`, and implicit help. For each value, identify required/optional status, cardinality, type/format/allowed domain, empty-value behavior, existing size limits (or their absence), conditional combinations, and the concrete existing validator/registry that owns it. Keep internal context such as `_rawArgs`, resolved target and injected runtime state out of public options. Reuse existing authority; this inventory does **not** authorize a new blanket admission validator or arbitrary tighter limits.

| Boundary | Existing authority / decision |
| --- | --- |
| Selector and argv syntax | CLI parsing / `parseEntryInput`; preserve exact selector matching, option value syntax and existing missing/unknown/extra-input behavior per leaf. |
| Target guards and target identity | `FlowTargetExpectation` in `src/lib/flow-target-guard.js` and `buildFlowCommandHookContext` in `src/flow/lib/flow-context.js`, before command execution. |
| Runtime directory initialization | `src/sennel.js` pre-scan, existing work-directory resolver and `src/lib/container.js`. |
| Domain values / state-dependent combinations | Existing domain classes, constants, registries and command validators, named per field; do not copy their decisions into callers. |
| Query | Its independent query contract, excluded from the shared migration. |

Explicitly cover these previously missed distinctions:

- `set step status`, `set auto value`, and `set broad action` use positional values, not new `--status`, `--auto`, or `--action` options. `get status runId` is optional; `set files` needs at least one rest path. Record per-leaf arity rather than assuming all declared positionals are required.
- `resume --spec` is a `FlowSpecId`; `run gate --spec` is a filesystem path. `prepare --base` and `run lint --base` are Git branch names. `get runtime-log --run-id` additionally supports an identifier/sequence form. Do not infer a type from the option spelling globally.
- Do not impose the repair's generic 100-character ID rule: `FlowSpecId` has no such limit; preparing run IDs use `PreparingFlowId`/`PreparingFlowStore` (200-character maximum, no colon at this baseline), while `FlowTargetExpectation` allows target tokens up to 300 characters. Specify `--run-id`, `--expect-run-id`, task/finding/attempt IDs and commit references against their own owners.
- Include `get check target`, `get prompt kind`, artifact `logicalKey`, step `id/status`, note `text`, draft `questionId`, requirement `reqId`, `--format`, `--mode`, `--phase`, `--sequence`, `--category`, `--record-category`, `--step`, `--task-id`, `--normalized-finding-id`, `--repair-ref-commit`, `--expect-attempt-id`, `--approve`, and state-dependent `--choice` domains and combinations. Identify the existing authority rather than inventing common enums.
- For actual paths, record file versus directory, existence requirements, absolute/relative support and resolution root per leaf. Cover `--agent-work-dir`, gate `--spec`, `--file`, context paths and rest paths. Do not require every output directory to already exist.
- Record existing policies for text/JSON/path sizes, `set files` count/aggregate size, `--exclusions` entries/serialized size, retry/attempt limits, query request-file size/elements/depth, context directory traversal depth/count/read size, and review-evidence file limits. If no explicit bound exists, state that fact and its owner. Adding resource limits or changing retry policy is separate scope, not a repair prerequisite for help consistency.

The five shared target guards are `--expect-binding`, `--expect-issue`, `--expect-no-issue`, `--expect-spec`, and `--expect-run-id`. Derive their applicable leaf set from the shared registry collection. For each guard verify a matching expectation succeeds through its existing path, mismatches/invalid combinations fail before command-owned mutation, and missing flags retain existing behavior. Preserve the existing mutual-exclusion and identity rules.

### 4. Runtime paths, rejection order and exit codes

- Preserve both parser-supported `--agent-work-dir /path` and `--agent-work-dir=/path` forms. Resolve the current pre-scan mismatch by normalizing both through the existing option parsing/resolution authority before container initialization; do not duplicate a second option parser or add unrelated path restrictions.
- Preserve precedence: normal `agentWorkDir` is invocation override > configured agent workDir > default; explicit `config.logs.dir` controls `logDir`, otherwise logs are under `agentWorkDir/logs`. Finalize-cleanup keeps its durable work-directory policy and resolves configured log paths against its durable root. Never assert that `agentWorkDir` and `logDir` are the same directory. Test both syntax forms with and without configured logs and the durable cleanup case.
- Preserve existing rejection lifecycle and diagnostic behavior. Currently parse errors may build context/open a runtime log before emitting `ARGS_ERROR`, and top-level container initialization may resolve ambient Flow attribution. Do not combine “preserve behavior” with a new “no context resolution/no log writes” promise. Document help, parse failure, target rejection, valid execution, and command failure paths, including existing pre/post/onError/finally behavior. Valid help must not execute the command handler or its execution hooks. A new admission boundary or side-effect ordering change requires separate explicit scope.
- Record observable exit contracts: valid explicit help and successful commands return 0; missing/unknown selectors and actual parser/target/command failures return 1. No-leaf group help prints help but retains exit 1. Missing required values and extra positionals must be tested against each leaf's actual parser/validator contract, without introducing new universal rejection rules.

### 5. Verification and implementation mapping

- Initial Draft/Spec must map each retained public surface to its current/new owner and test: parser acceptance, leaf help, every group help path, execution, guards/binding, runtime paths and query. Inventory affected APIs, lifecycle hooks, configuration, generated artifacts and side effects, explicitly marking unchanged categories.
- Enumerate all routed leaves (including resume and prepare) in contract tests. Run at least one behavior-level assertion per retained surface through the real dispatcher/CLI path; metadata snapshots alone are insufficient. Exercise valid input/help and meaningful rejection cases with isolated fixtures/stub handlers, without executing destructive production operations.
- Keep the exhaustive parser matrix in integration tests. Use focused public CLI E2E for entry-point wiring, abort, guarded get/set/run, group intersections, longest names, order/spacing, exit codes and runtime directory behavior. Do not duplicate the complete invalid-input matrix in both layers. Keep synthetic name boundaries in integration tests.
- Reuse existing test helpers and verify common `CommandDefinition` consumers, including representative docs/core/plugin group help if they use the shared renderer. Preserve semantics outside Flow.
- Extend the original file list with `src/flow.js`, the pre-initialization boundary in `src/sennel.js`, and regression touchpoints in `src/lib/container.js`, `src/lib/flow-target-guard.js`, `src/flow/lib/flow-context.js`, and query modules. These touchpoints do not require rewriting the existing owners.

### Review provenance

- Draft: `001/issue-log.json` draft-gate entries and `001/artifacts/plan-gate-repairs/*/outcome.json` (measurable layout, exact child set, class responsibilities and migration inventory). Draft coverage/questions evidence itself reported PASS; gate observations caused the repairs.
- Spec: `001/revisions/002–003/review.json` (counts/query/synthetic tests); `004–005` (no-leaf route/runtime pre-scan/validation owners); `006–007` (positionals/types/lifecycle/equals syntax/domains); `008` (query exclusion, log precedence, ID boundaries, missing domains and rejection-side-effect contradictions).
- Remaining spec-gate observations in `001/issue-log.json` (including repeated observations on 2026-09-24) cover guard enumeration, retry bounds, file/context limits and positional validation. The decisions above retain existing contracts and require explicit inventories; they do not treat speculative limits introduced by repair as accepted product requirements.

## Overview

Because the parser definitions (`args.flags` / `args.options` / `args.optionalOptions`) and help definitions for `sennel flow` are managed separately, the options actually accepted do not match the displayed content. In addition, incorrect group help, broken subcommand table layouts, and display order dependent on registration order also occur.

An audit of the current source covering all 67 leaves in `FLOW_COMMANDS` and `flow get/set/run/report --help` confirmed the following:

- For 41 of the 67 leaves, at least one declared flag/option is missing from help.
- The frequently omitted shared options are `--expect-binding` (35 commands), `--expect-no-issue` / `--expect-issue` / `--expect-spec` / `--expect-run-id` (31 commands each), and `--agent-work-dir` (23 commands).
- The implicit `-h, --help` is not displayed in the leaf help for any of the 67 leaves.
- The group help for `flow get` / `set` / `report` displays `--agent-work-dir <path>`, which is not accepted by the leaves under those groups.
- For subcommand names 14 characters or longer, there is no separator between the name and summary, causing the strings to run together. This affects 25 commands (`get` 1, `set` 3, `run` 21).
- The display order of subcommands depends on their declaration order in `FLOW_COMMANDS` and is not defined as a help ordering contract.

## Reproduction

`flow run abort` accepts the following options according to the parser, but help displays only `--force`.

```text
--force
--agent-work-dir <path>
--expect-binding <token>
--expect-issue <number>
--expect-no-issue
--expect-spec <spec>
--expect-run-id <runId>
```

```console
$ sennel flow run abort --help
Usage: sennel flow run abort [--force]

Remove only the selected flow worktree, feature branch, shared spec directory, and active entry.
--force permits removal of a dirty isolated worktree; unrelated base-checkout changes are never removed.
```

Also, due to the incorrect group help, the following input fails:

```console
$ sennel flow get qa-count --agent-work-dir /tmp/sennel-help-audit
Unknown option: --agent-work-dir
```

## Cause

- In `src/flow/registry.js`, the parser-authoritative `args` and display-oriented `help` are written separately by hand.
- When a leaf is invoked with `--help`, `src/lib/dispatcher.js` outputs `entry.help` as-is and does not validate or supplement it against `args`.
- `flowOptions()` in `src/lib/command-registry.js` reverse-parses hand-written help, while group options are managed in a separate fixed array.
- `CommandDefinition.renderHelp()` in `src/lib/command-registry.js` and `renderCommand()` in `src/help.js` duplicate the implementation of the subcommand table.
- Neither renderer guarantees a separator for command names exceeding the fixed width, and both display commands in registration order.
- Existing tests verify parser acceptance for some options, but do not verify complete agreement between the parser and help contracts, the common intersection of group options, long names, or display order.

## Fix direction

Extend the existing `CommandDefinition` so that the parser and help reference the same option authority. Do not add a separate command abstraction.

- Define a dedicated model representing the option name, value placeholder, description, and type: flag / required-value option / optional-value option.
- Compose target guards, run runtime options, and implicit help as shared option collections.
- Project `args.flags`, `args.options`, `args.optionalOptions`, leaf help, and group help from the model.
- Keep command-specific descriptions and examples in the existing help, but make the model authoritative for the Usage and Options listings.
- Derive group help options from the intersection of the option contracts of child leaves and eliminate the fixed array.
- Consolidate subcommand sorting and alignment in a shared renderer, and reuse it for `sennel flow <group> --help` and `sennel help flow <group>`.
- Sort subcommands by name in ascending order by default, overriding this only with explicit display-order metadata when semantic ordering is required.
- Use a table layout of `maxName + separator` or a multiline format, guaranteeing at least two ASCII spaces of separation between the name and summary.

## Acceptance criteria

- For every shared routed leaf in `FLOW_COMMANDS` (65 at the restart baseline; query is an explicit exception), every parser option and implicit `-h, --help` has exactly one canonical Options row; Usage/examples may repeat names.
- The option model distinguishes valueless flags, required-value options, and optional-value options, and provides a placeholder and description for options that take values.
- `sennel flow run abort --help` displays `--force`, `--agent-work-dir`, all 5 target guards, and `-h, --help`.
- `flow get --help`, `flow set --help`, and `flow report --help` do not display `--agent-work-dir`; only `flow run --help` displays it.
- The boundary between the command name and summary is always visible on every subcommand row in `flow get/set/run/report --help`.
- Subcommands in every group are displayed in ascending name order and do not depend on their declaration positions in `FLOW_COMMANDS`.
- `sennel flow <group> --help` and `sennel help flow <group>` use the same ordering and layout contract.
- Add registry/help contract tests covering all leaves and groups, including `flow resume` and `prepare`.
- Add focused E2E tests covering `abort`, `get` / `set` / `run` with target guards, long subcommand names, and name ordering.
- Do not change command execution semantics, target guard evaluation, or runtime directory behavior.

## Target files

- `src/flow/registry.js`
- `src/lib/dispatcher.js`
- `src/lib/command-registry.js`
- `src/help.js`
- `tests/integration/lib/command-registry.test.js`
- `tests/e2e/help.test.js`

## Audit basis

The parser definitions and help were compared by recursively traversing `FLOW_COMMANDS`, and representative leaf/group help and `sennel help flow <group>` were executed. The audit also confirmed that options displayed in group help but unsupported by the actual CLI result in `Unknown option`, and that existing related integration/E2E tests do not detect this issue even when they pass.

<details>
<summary>ja</summary>

## 次回開始時に最初から取り込む契約（2026-09-24）

上記英語セクション「Restart contract from flow review」を初回 Draft／Spec の要件として適用する。以下は同じ決定の日本語版であり、旧監査の件数・曖昧な記述より優先する。停止 flow `338319c6-flow-help-contract` の revision 008 は未解決の blocking 指摘が残っており、承認済み仕様として丸ごと転記しない。

1. **対象集合**：確認した commit `b8b3f59550a12677d6a017bd478881c085d54399` では全66 leaf、query を除く共通経路65 leaf（resume 1、prepare 1、get 11、set 17、run 34、report/show 1）。次回開始時の registry から再列挙する。query は独立 parser/help の例外として、入力 inventory・共通 admission・help projection・網羅テストのすべてで一貫して除外し、stdin／request-file／help／error は別途回帰確認する。
2. **単一の定義元**：既存 CommandDefinition／FLOW_COMMANDS を拡張し、option と表示行は invariant を持つ専用 class とする。名前・alias・値種別・placeholder・説明を構造化して明示定義し、手書き help の逆解析を authority にしない。説明・例・翻訳は保持する。「一度ずつ」は Options の canonical row 単位とし、Usage／例への再掲と混同しない。group は全 direct child leaf の完全な option 契約の共通部分を導出する。
3. **表示経路と境界**：`flow <group> --help`、`help flow <group>`、leaf なしの `flow <group>` の3経路を共通 renderer へ接続する。行は name＋2個以上のASCII空白＋summary、同じgroupの行・optionの順序と空白を揃える。名前順はlocale非依存、表示順metadataを使うならfield・伝播・未指定・同値の規則をSpecで確定する。option順も共通modelで確定する。13/14/15文字境界、最長既存leaf、64/65文字の合成名を検証し、合成名はintegrationで扱う。新たな名前長制限は導入しない。
4. **入力と責務の一覧**：各leafのpositional/rest/flag
... (truncated)
