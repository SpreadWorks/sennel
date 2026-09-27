   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   <!-- include("/flow/prompts/partials/draft-qa-rules.md") -->

   **Note on subsequent task decomposition:** The spec step decomposes requirements by concern. Keep draft discussion at the requirement level and keep scope within the Issue or request boundary. Task decomposition granularity is evaluated later by the `task-single-responsibility` guardrail (phase=[spec, task-spec]).

   **Draft artifact format: draft.json**
   The draft artifact is a JSON file (`draft.json`), not markdown. The AI writes structured JSON directly.

   If `contextSnapshot.entries` contains an available `reopen` entry, use its
   `reason`, cited source evidence, and previous Draft question ledger as input.
   Reconsider the missing decision in the normal `questionLedger`. For a Spec
   Gate repair return, preserve earlier valid answers and resolutions exactly.
   For another reopen, retain supported answers and correct entries that the
   reopen reason and evidence show are obsolete. Do not turn a note or an unresolved
   proposal into an answered question. If the Issue, request, project rules, or
   source evidence already resolves the reason, record that fact and do not
   create a duplicate question. The reopen entry is bound to this Draft Attempt.

   **Communication rules:**
   - Questions MUST be written in the language specified by `config.lang`. Do not mix languages within a single question.
   - When using a technical term for the first time, add a 1-2 line definition or explanation.
   - Each question MUST be self-contained — understandable without reading prior conversation turns.

   **autoApprove mode — autonomous draft:**
   When `autoApprove: true`, the AI conducts the draft phase autonomously:
   - Do NOT ask the user questions in the draft step.
   - Do NOT answer draft questions yourself in this step. Create `CandidateQuestion` entries only for genuine unresolved user decisions. An empty `questionLedger.questions[]` is valid.
   - Use Issue content (if linked), `docs/` chapters, guardrail articles, and source code as input.
   - Follow Draft QA Rules premise validation before creating candidates for requirement areas that need user judgment. Use the shared category list from Draft QA Rules.
   - **Deep-read trigger:** If the linked Issue body is under 200 characters, read the relevant source code files directly from the execution checkout to build sufficient understanding before creating the checklist questions.
   - Create the declared `draft.json` payload with these required fields checked by draft-gate:
     - `devType` — enum: `feature` / `bugfix` / `refactor` / `docs` / `chore` / `test` / `other`
     - `goal` — non-empty string
     - `analysis` — `problem`, `proposedApproach`, and `validation` are all non-empty
     - `decisionMap` — arrays for `knownFacts`, `decisionPoints`, `resolvedByProjectRules`, `requiresUserJudgment`, and `deferredToSpec`; each `deferredToSpec` entry is `{ boundary, relevance, owner: "spec" }`. Draft verifies only that delegation is bounded, relevant, and owned by Spec; it must not invent final specification detail.
     - `questionLedger` — typed entries conforming to the Draft QA Rules schema
   - Write the draft to the declared `draft.json` payload. The parent dispatcher proceeds to `draft-questions-review` after validation and publication.

   **Communication rules for the draft phase (when NOT autoApprove):**
   - Create `draft.json.questionLedger.questions[]` entries with state `CandidateQuestion` and stable ids (`q1`, `q2`, ...) only for genuine user decisions left unresolved after reading the authoritative Issue or request and project context. The ledger may be empty.
   - Do not ask the user to reconfirm a requirement, constraint, scope boundary, or acceptance condition already stated by the Issue or request. Record it in `decisionMap.knownFacts` instead.
   - Do not ask or answer the draft questions in this step. The draft step only creates the initial question list.
   - **MUST: Every question to the user — including confirmations after applying user-requested changes — MUST use the Choice Format. No free-form questions. No exceptions.**
   - Use the shared category list from Draft QA Rules to check coverage, not to manufacture a question for every category.
   - **Before starting draft discussion**:
     1. Use the handoff `contextSnapshot.inputAuthority` entry as the authoritative Issue or request input. If an Issue is selected, display its number and body before the first question.
     2. **Context gathering (supplement-first):** Start from the immutable project overview and guardrail entries. If target files/modules are still unclear, inspect relevant source files directly in the execution checkout.
     3. Do not run nested Flow context, Issue, or guardrail commands; the parent materializes and binds those values before worker startup.
   - Fill draft.json fields for the initial question list:
     - Candidates record provenance and evidence digests; do not select a user wait from this worker.
     - On an initial Draft, do not create answered or discarded entries while generating the question list. On a Spec Gate repair return, retain prior valid answered and resolved entries exactly; on another reopen, correct only entries made obsolete by the reason and evidence.
   - When the initial question list is complete, proceed to `draft-questions-review`.
   - Write `draft.json` only to its exact handoff `payloadPath`, then run the exact handoff `sealCommand` once.
