   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   - **Before writing spec**:
     - Read `draft.json` only from the handoff `inputs[].document` snapshot and read linked GitHub issue content. Treat the draft snapshot as the primary input — do NOT re-read context already gathered in the draft phase.
     - Write all human-readable prose in `spec.json` in the language specified by `config.lang`. Preserve code symbols, command names, paths, schema fields, and other technical identifiers exactly; `keywords` remains the explicit English-only exception below.
     - **Context gathering (supplement-first):** Only read additional context when draft + issue are insufficient.
       - If specific target files are unclear: `sennel flow get context --search "<request text or issue title>" --raw`.
       - If project structure is still unclear: `sennel flow get context <path> --raw` for specific files; `sennel flow get context --raw` only as a last resort.
     - If guardrail articles for spec have NOT been loaded in this session: `sennel flow get guardrail spec`. If output is non-empty, follow these principles. Skip if already present in context.
   - When `context.planGateRepair` is present, this is a governed spec-gate repair. Read the existing `spec.json` from the additional handoff input, preserve all unaffected content, treat every blocking observation as mandatory input, and repair all occurrences of the same failure pattern. Keep the exact source issue-log id/digest binding. Publish only through this step's handoff; never edit a canonical spec directory directly and never seal an unchanged payload.
   - **Synthesize draft into spec, do not copy or fabricate:** Organize and abstract draft content rather than copying it directly. Do not invent content not present in the draft. Exception: if a draft policy contradicts the source code (verified in the verification step below), treat the spec correction as a `[CORRECTION]`, not a fabrication.
   - **Acknowledged guardrail exceptions:** If the spec intentionally chooses a design that may violate a guardrail article, record the guardrail id directly in `constraints[]`, `clarifications[].q` / `.a`, or `alternatives_considered[].option` / `.reason`. Do not use `design_principles`, approval notes, overview entries, task text, or other fields as an exception-acknowledgment surface. The draft gate remains strict: draft-time guardrail violations must be fixed directly or escalated; exception acknowledgments are a spec.json convention for later spec/implementation review context.
   - **Source verification step (when draft is the primary input):** When `draft.json` includes implementation policy references in `analysis.proposedApproach`, `decisionMap.*`, or answered ledger entries, cross-reference them against the actual source code. Read minimal source files only for that verification — do not re-read context already gathered in the draft phase.
     - **Recording convention for `[VERIFY]` and `[CORRECTION]` entries (shared):** Write a concise summary in `spec.json.overview.decisions[].text` (≤ 500 chars). Put detailed source references in `evidence` (≤ 1000 chars). Split into multiple decision entries when content overflows. Each entry keeps prefix-based identification.
     - If a draft policy matches the source: record a `[VERIFY]` entry summarising "checked draft policy / referenced file / result=match".
     - If a draft policy contradicts the source: record a `[CORRECTION]` entry summarising "draft policy / referenced file / adopted correction" when the correction is source-verifiable. If the correction needs a user decision that is missing from draft QA, follow the draft-return rule below.
   - **Draft return when user judgment is missing:** If spec writing discovers a missing user decision, run `sennel flow run reopen-draft --reason "<reason>"` instead of collecting an ad-hoc spec-phase answer. The reason should name the missing decision in one sentence. After reopen succeeds, return to draft so it can be captured in the question ledger and the normal draft review/gate/spec path can run again.
     - Do not use this for source-verifiable corrections, wording fixes, rationale additions, or details the draft intentionally deferred to spec writing.
     - If `reopen-draft` fails or the flow presents a recovery choice, use Choice Format for that recovery decision.
   - Do not render or edit `spec.md` in this step. `spec.json` is the source of truth; the approval prompt renders the human-readable `spec.md` view when the user needs to read it.
   - Fill spec.json fields: `goal`, `scope`, `constraints`, `requirements`, `acceptance_criteria`, `alternatives_considered` (if applicable).
   - **Requirement IDs:** assign `requirements[]` IDs exactly as `R1`, `R2`, `R3`, ... in array order. Never use `R-1`, `R_1`, `R0`, or arbitrary identifiers.
   - Every `requirements[]` entry must include a non-empty, duplicate-free `task_ids` array containing only existing `tasks[].id` values. This is the sole Requirement-to-Task mapping; do not infer mappings from prose, order, parent links, or implementation notes.
   - **Requirement testability:** each `requirements[]` entry may carry an optional `testable` boolean. Default behavior is testable (omit the field, or set `testable: true`). Every testable Requirement must also set `preimplementation_test_expectation` to `fail` when its named test must initially fail or `pass` when current behavior must already satisfy it. Set `testable: false` only when the Requirement is inherently not verifiable through automated tests; in that case `preimplementation_test_expectation` must be omitted.
     - Example:
       ```json
       { "id": "R5", "desc": "rewrite the test phase prompt to teach header convention", "priority": "must", "testable": false, "task_ids": ["T-2"] }
       ```
   - Generate `keywords`: an array of 5–15 English keywords derived from the spec content (goal, scope, requirements). These keywords are used by contextSearch for codebase relevance matching. Choose specific, concrete terms (function names, module names, domain concepts) over generic words.
   - If draft phase was done, transfer draft.json content to spec.json using the following field mapping:
     - `draft.json.analysis.problem` → `spec.json.background` (synthesize, do not copy verbatim)
     - `draft.json.decisionMap.knownFacts` → `spec.json.background` and `spec.json.overview.decisions[]` where the facts materially support requirements
     - `draft.json.decisionMap.decisionPoints` → ensure each relevant decision is represented in `requirements[]`, `acceptance_criteria`, `constraints`, or `alternatives_considered[]`
     - `draft.json.decisionMap.resolvedByProjectRules` → incorporate as constraints or overview decisions with rationale, without asking the user again
     - `draft.json.decisionMap.requiresUserJudgment` → treat as a readable projection and reconcile against the authoritative ledger; do not leave an item unresolved unless it is explicitly listed in `open_questions`
     - `draft.json.decisionMap.deferredToSpec` → finalize during spec writing when it can be resolved by project rules, source verification, or conservative implementation choices
     - answered ledger evidence digests → `spec.json.overview.decisions[].evidence`
     - answered ledger entries with constraint-related categories → `spec.json.alternatives_considered[]` only when the answer explicitly records a rejected option.
     - answered ledger `why` → incorporate into `spec.json.overview.decisions[].text` as rationale
     - `draft.json.scopeVerification` → `spec.json.scope` (`{in, out}`)
     - `draft.json.impactOnExisting` → `spec.json.overview.decisions[]` or `spec.json.background`, whichever best preserves the implementation impact context
     - `draft.json.openQuestions` → `spec.json.open_questions`

   ## Task Decomposition Rules

   `spec.json.tasks[]` must be populated. Each task shall address a single concern within the spec.

   - A task's `title` shall be expressible as one verb phrase (e.g. "Add auto-promote to sync"). Do not connect unrelated actions with "and" (e.g. "Add auto-promote and refactor tests").
   - Unrelated sub-changes shall be split into separate tasks. Tasks whose implementation_notes span unrelated modules without a shared concern shall be split.
   - If a task's acceptance contains multiple independent criteria that are not part of the same concern, each shall be split into its own task.

   Each task shall include:
   - `id` (required): identifier like `T-1`, `T-2`.
   - `title` (required): short verb-phrase name.
   - `goal` (required): 1–2 sentences stating what this task accomplishes.
   - `acceptance` (optional): bullet-style verifiable criteria.
   - `implementation_notes` (optional): design considerations, edge cases, files touched.
   - `test_strategy` (optional): what to test at what granularity (unit / integration).
   - `parent` (optional): parent task id for forest structure (null for root tasks).
   - `origin` (required): `"plan"` for plan-phase tasks.
   - `added_round` (required): 0 for initial tasks.
   - `status` (required): `"pending"` initially.

   Empty `tasks[]` or undefined `tasks` causes the spec gate to FAIL. The `task-single-responsibility` guardrail evaluates each task's concern singularity in phase `spec` and `task-spec`.

   - **On complete**: write `spec.json` only to its exact handoff `payloadPath`, then run the exact handoff `sealCommand` once.
