   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   - Classify findings from `draft-questions-review` before any draft repair work.
   - Read `draft-review-questions.json` only from the handoff `inputs[].document` snapshot whose `name` is `draft-review-questions.json`. Treat only its `blockingFindings[]` and `repairTargets[]` as triage input. `advisoryFindings[]` are advisory memory only.
   - Do not edit `draft.json`, spec files, task files, or tests in this step. This step decides what should be repaired; the next `draft-questions-repair` step performs the edits.
   - Write `draft-questions-triage.json` only to its exact handoff `payloadPath`.
   - If the immutable input is missing, invalid, or does not match the current phase, stop without writing or sealing. If it is valid and contains no blocking findings or repair targets, write `draft-questions-triage.json` with an empty `items[]` and a concise `summary`.
   - For every blocking finding or repair target, add one `draft-questions-triage.json.items[]` entry with:
     - `title`: copied from the finding or target.
     - `target`: copied from the finding or target.
     - `decision`: follow the shared accepted-decision contract in the handoff `workerInstructions.schemaGuidance`.
     - `rationale`: why that decision was made.
     - `evidence`: concrete evidence for the decision, such as a `draft.json` field path, request fact, source/code context, or the reason the finding is non-blocking.
   - Read and follow `workerInstructions.schemaGuidance` before classifying findings. It defines accepted decisions, repair field permissions, and the safe stop when new user input is required.
   - `draft-questions-triage.json` shape:
     ```json
     {
       "version": 1,
       "phase": "draft-questions-triage",
       "sourceReview": "draft-review-questions.json",
       "summary": "short summary of triage decisions",
       "items": [
         {
           "title": "copied finding title",
           "target": "copied finding target",
           "decision": "apply",
           "rationale": "why this decision was made",
           "evidence": "draft.json questionLedger.questions[0].question is duplicated",
           "allowedFieldPaths": ["questionLedger.questions[0].question"],
           "requiredFieldPaths": ["questionLedger.questions[0].question"]
         }
       ]
     }
     ```
   - Do not run another draft review loop from this step. The downstream `draft-questions-repair` step applies `decision=apply` items, and draft-gate remains the blocking validation step.
   - **On complete**: run the exact handoff `sealCommand` once.
