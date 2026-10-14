<!-- {{data("base.docs.langSwitcher", {labels: "relative"})}} -->
[日本語](ja/cli_commands.md) | **English**
<!-- {{/data}} -->

# CLI Command Reference

## Description

<!-- {{text({prompt: "Write a 1-2 sentence overview of this chapter. Include the total number of commands and subcommand structure."})}} -->

The CLI is organized as command groups that dispatch subcommands from registries, with `docs`, `flow`, `metrics`, `spec`, and `check` acting as primary routers. The built-in help layout lists 21 user-facing commands across Project, Docs, Flow, Metrics, and Info, while `flow` and `spec` further branch into nested subcommands.
<!-- {{/text}} -->

## Content

### Command List

<!-- {{text({prompt: "List all commands in table format. Include command name, description, and key options. Extract comprehensively from command definitions and routing in the source code.", mode: "deep"})}} -->

| Command | Description | Key options |
| --- | --- | --- |
| `sennel help` | Prints localized command catalog with version and grouped sections. | None (entry command). |
| `sennel check <command>` | Dispatches check subcommands from `checkCommands`. | `-h`, `--help`. |
| `sennel docs <command>` | Dispatches documentation subcommands from `docsCommands`. | `-h`, `--help`. |
| `sennel docs build` | Runs docs pipeline (`scan` → `enrich` → `init` → `data` → `text` → `readme` → `agents` → optional `translate`). | `--verbose`, `--dry-run`, `--force`, `--regenerate`, `-h`, `--help`. |
| `sennel docs changelog [outFile]` | Generates changelog from `specs/*` metadata and writes `docs/change_log.md` by default. | `--dry-run`, `-h`, `--help`. |
| `sennel docs forge` | Orchestrates AI-assisted docs updates with iterative review loops. | `--prompt`, `--prompt-file`, `--spec`, `--max-runs`, `--review-cmd`, `--mode`, `--dry-run`, `--verbose`, `-h`, `--help`. |
| `sennel docs text` | Fills `{{text}}` directives from analysis + agent responses, with batch/retry/filtering support. | Supports command-specific options via parsed args and help output. |
| `sennel flow <group>` | Routes flow operations (`prepare`, `resume`, `get`, `set`, `run`). | `-h`, `--help`. |
| `sennel flow prepare` | Alias route to `flow run prepare-spec`. | Options handled by `run prepare-spec` (for example `--title`, `--base`, `--worktree`, `--no-branch`, `--dry-run`). |
| `sennel flow resume` | Alias route to `flow run resume`. | Group help and run-specific options. |
| `sennel flow get check <target>` | Returns prerequisite/tool checks (`dirty`, `gh`, step prereqs). | Target required; valid targets constrained by constants. |
| `sennel flow get guardrail <phase>` | Returns merged guardrails filtered by phase. | `--format json` supported by command context; phase required. |
| `sennel flow get issue <number>` | Fetches GitHub issue fields via `gh issue view`. | Positive integer issue number required. |
| `sennel flow get next-action` | Resolves next actionable flow instruction from state + schema rules. | No extra flags required; requires resolvable flow state. |
| `sennel flow get prompt <kind>` | Returns localized prompt template by kind. | Valid kind required. |
| `sennel flow get qa-count` | Returns QA question count from metrics summary. | None beyond flow context. |
| `sennel flow set auto <on\|off>` | Toggles auto-approve with optional auto-check evaluation. | `--run-id` in preparing mode. |
| `sennel flow set gate-retry reset <phase> --yes` | Resets tracked gate retry counters for `task-impl` or `integration`. | `--yes` confirmation required. |
| `sennel flow set init` | Creates preparing run and stores initial issue/request metadata. | `--issue`, `--request`. |
| `sennel flow set issue <number>` | Persists flow issue number. | Positive integer required. |
| `sennel flow set metric <phase> <counter>` | Increments a metric counter for a phase. | `--task-id` optional. |
| `sennel flow set note "<text>"` | Appends operator note to flow state. | `--task-id` optional. |
| `sennel flow set request "<text>"` | Stores high-level request text in flow state. | Text required. |
| `sennel flow set step <id> <status>` | Updates step status and triggers approval-time task sync. | Valid status required. |
| `sennel flow run gate` | Executes gate validations (draft/spec/task/integration), guardrails, diff checks, and retry controls. | `--phase`, `--spec`, `--skip-guardrail`, `--agent-work-dir`, `--log-file`. |
| `sennel flow run lint` | Runs guardrail-based lint against changed files. | `--base` optional (falls back to active flow base branch). |
| `sennel flow run merge` | Finalize merge route (`pr` via `gh` or local `squash`), including pre-sync rebase checks. | Strategy inferred from config + environment. |
| `sennel flow run prepare-spec` | Initializes spec directory, templates, branch/worktree, and flow state. | `--title`, `--base`, `--run-id`, `--no-branch`, `--worktree`, `--dry-run`, plus issue/request context. |
| `sennel flow run reopen-draft` | Rewinds draft/gate-draft for adding tasks mid-implementation. | `--reason` (validated, optional). |
| `sennel flow run report` | Generates and saves `report.json` for active spec. | `--dry-run`. |
| `sennel flow report show` | Prints text from most recent finalized `report.json`. | No options required by command implementation. |
| `sennel flow run review` | Runs review subprocess for generic/spec/test phases with retry. | `--phase`, `--dry-run`, `--skip-confirm`, `--agent-work-dir`, `--log-file`. |
| `sennel flow run test-execute` | Runs spec-local tests and required project regression, then writes `test-execute-result.json` version `"2"` plus raw output. | Uses `.sennel/config.json` `test.command`, `test.projectPaths`, and `test.timeout` when configured. |
| `sennel flow run test-result-review` | Deterministically validates `test-execute-result.json` v2, raw output, and project regression evidence before writing `test-result-review.json`. | No options. |
| `sennel flow run sync` | Executes docs build/review and optionally commits docs sync changes. | `--dry-run`. |
| `sennel flow run tests` | Runs resolved test command, stores logs, parses counts, and updates test summary. | `--baseline` supported in command context. |
| `sennel metrics <command>` | Dispatches metrics subcommands from `metricsCommands`. | `-h`, `--help`. |
| `sennel spec <command>` | Dispatches spec subcommands from `specCommands`. | `-h`, `--help`. |
| `sennel spec render` | Validates `spec.json` against schema and renders deterministic `spec.md`. | `--spec`, `--out`, `-h`, `--help`. |
<!-- {{/text}} -->

### Global Options

<!-- {{text({prompt: "Describe global options shared by all commands in table format. Extract from argument parsing logic in the source code.", mode: "deep"})}} -->

| Global option | Scope | Behavior |
| --- | --- | --- |
| `-h`, `--help` | Implemented across top-level routers (`check`, `docs`, `flow`, `metrics`, `spec`) and many subcommands using `parseArgs` | Prints usage/help text and exits successfully when explicitly requested. |
| Subcommand key (positional) | Top-level command routers | Required for command groups; missing or unknown keys print usage/error and exit non-zero. |
| `--` | Commands using shared `parseArgs` | Recognized as a token and skipped by parser loop (does not create an option value by itself). |
<!-- {{/text}} -->

### Command Details

<!-- {{text({prompt: "Describe each command's usage, options, and examples in detail. Create a #### subsection for each command. Extract from argument definitions and help messages in the source code.", mode: "deep"})}} -->

#### `sennel check`
Usage: `sennel check <command>`.
Options: `-h`, `--help`.
Behavior: lists available `checkCommands` on help; unknown subcommand exits with error.
Example: `sennel check --help`.

#### `sennel docs`
Usage: `sennel docs <command>`.
Core subcommands in analyzed code: `build`, `changelog`, `forge`, `text` (plus registry-driven siblings such as `scan`, `enrich`, `init`, `data`, `readme`, `agents`, `translate`, `review`, `snapshot`).
Example: `sennel docs build --verbose --force`, `sennel docs changelog --dry-run`, `sennel docs forge --prompt-file prompt.md --mode agent --max-runs 3`.

#### `sennel flow`
Usage: `sennel flow <prepare|resume|get|set|run> ...`.
Aliases: `flow prepare` routes to `run prepare-spec`; `flow resume` routes to `run resume`.
Impl-phase tests are centralized in `flow run test-execute`. The persisted `test-execute-result.json` uses version `"2"`, keeps requirement results in `summary[]`, and stores project-level regression evidence in `regression`. `flow run test-result-review`, `flow run gate --phase integration`, reports, and finalize consume that v2 artifact instead of legacy flow-state test summaries. Top-level `.sennel/config.json` `test.command`, `test.projectPaths`, and `test.timeout` configure project-level regression; `commands.test` remains separate task prompt configuration.
Examples: `sennel flow get check dirty`, `sennel flow set step approval done`, `sennel flow run review --phase spec --agent-work-dir .tmp --log-file .tmp/review-spec.log`, `sennel flow run tests --baseline`.

#### `sennel metrics`
Usage: `sennel metrics <command>`.
Behavior: registry-dispatched metrics commands; help path shows available keys.
Example: `sennel metrics --help` and `sennel metrics token` (listed in help layout).

#### `sennel spec`
Usage: `sennel spec <command> [options]`.
Known analyzed subcommand: `render` with `--spec <dir>` and `--out <path>`; validates schema before writing Markdown.
Example: `sennel spec render --spec specs/001-example --out specs/001-example/spec.md`.

#### `sennel help`
Usage: `sennel help`.
Behavior: prints localized grouped command list with package version and per-command descriptions.
Example: `sennel help`.
<!-- {{/text}} -->

### Exit Codes and Output

<!-- {{text({prompt: "Define exit codes and describe stdout/stderr conventions in table format. Extract from process.exit() calls and output patterns in the source code.", mode: "deep"})}} -->

| Context | Exit code behavior | Stdout convention | Stderr convention |
| --- | --- | --- | --- |
| Top-level routers (`check`, `docs`, `flow`, `metrics`, `spec`) | Missing/unknown command paths exit non-zero (`EXIT_ERROR`); explicit help exits `0` in most commands; `check` exits `1` when no subcommand is provided. | Usage/help or normal command output is printed to stdout (for example `flow --help`, `spec --help`). | Error and usage diagnostics are commonly printed to stderr in router failures (`unknown command`, guidance lines). |
| `docs build` and other orchestrators | Fatal pipeline failures call `process.exit(EXIT_ERROR)` or throw; help returns without error. | Progress logs and successful step messages are printed to stdout. | Validation and pipeline errors are printed to stderr (for example unknown flag, regenerate precondition failures). |
| `flow report show` | Exits `1` on pointer/report resolution or parse failures. | Writes only report `text` payload to stdout on success. | Prefixes failures as `sennel flow report show: ...` to stderr. |
| Shared process wrapper patterns | Non-zero subprocess outcomes are escalated through thrown errors or explicit asserts. | Machine-readable command results often return JSON-like objects through command framework output modes. | Retry notices, warnings, and command-failure details are written to stderr (for example review retry lines, guardrail warnings). |
| `spec render` | Invalid options, missing files, or schema validation errors exit with `EXIT_ERROR`. | Success prints `rendered: <relative-path>`. | Validation and path errors are written to stderr before exit. |
<!-- {{/text}} -->

---

### Cancel a stopped Flow

Run `sennel flow run abort --expect-run-id <runId> --expect-spec <specId> --reason "Reason"`.
Abort refuses a running Flow or an execution owner whose termination cannot be confirmed.
`--force` permits discarding changes in the owned worktree; execution checks still apply.
Successful cancellation removes the selected Version, owned worktree and branch, active registration,
and cleanup journal. Requested and completed observations remain in `abort-log.jsonl` directly
under the configured Spec root. Other Versions and earlier log lines are preserved.

<!-- {{data("base.docs.nav")}} -->
[← Project Structure](project_structure.md) | [Configuration and Customization →](configuration.md)
<!-- {{/data}} -->
