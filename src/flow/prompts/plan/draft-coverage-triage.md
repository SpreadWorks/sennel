   <!-- include("/flow/prompts/partials/worker-artifact-handoff.md") -->
   - Classify findings from `draft-coverage-review` before any draft coverage repair work.
   - Read `draft-review-coverage.json` only from the handoff `inputs[].document` snapshot whose `name` is `draft-review-coverage.json`. Treat only its `blockingFindings[]` and `repairTargets[]` as triage input. `advisoryFindings[]` are advisory memory only.
   - Do not edit `draft.json`, spec files, task files, or tests in this step. This step decides what should be repaired; the next `draft-coverage-repair` step performs the edits.
   - Write `draft-coverage-triage.json` only to its exact handoff `payloadPath`.
   - If the immutable input is missing, invalid, or does not match the current phase, stop without writing or sealing. If it is valid and contains no blocking findings or repair targets, write `draft-coverage-triage.json` with an empty `items[]` and a concise `summary`.
   - For every blocking finding or repair target, add one `draft-coverage-triage.json.items[]` entry with:
     - `title`: copied from the finding or target.
     - `target`: copied from the finding or target.
     - `decision`: follow the shared accepted-decision contract in the handoff `workerInstructions.schemaGuidance`.
     - `rationale`: why that decision was made.
     - `evidence`: concrete evidence for the decision, such as a `draft.json` field path, request fact, source/code context, or the reason the finding is non-blocking.
   - Read and follow `workerInstructions.schemaGuidance` before classifying findings. It defines accepted decisions, repair field permissions, and the safe stop when new user input is required.
   - `draft-coverage-triage.json` shape:
     ```json
     {
       "version": 1,
       "phase": "draft-coverage-triage",
       "sourceReview": "draft-review-coverage.json",
       "summary": "short summary of triage decisions",
       "items": [
         {
           "title": "copied finding title",
           "target": "copied finding target",
           "decision": "apply",
           "rationale": "why this decision was made",
           "evidence": "draft.json analysis.validation does not name the required verification",
           "allowedFieldPaths": ["analysis.validation"],
           "requiredFieldPaths": ["analysis.validation"]
         }
       ]
     }
     ```
   - Do not run another draft review loop from this step. The downstream `draft-coverage-repair` step applies `decision=apply` items, and draft-gate remains the blocking validation step.
   - **On complete**: run the exact handoff `sealCommand` once.
