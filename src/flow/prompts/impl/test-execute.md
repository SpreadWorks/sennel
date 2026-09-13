   - **Post-implementation execution point:** `impl/test-execute` verifies promoted spec-local tests against implemented code. Earlier, each testable Requirement passes through `plan/test-generate`, `plan/test-review`, optional `plan/test-repair`, and `plan/test-gate`; only Gate promotes a compatible candidate.
   - **Project regression responsibilities:** `test-execute` owns four cases:
     - `spec-local`: always run spec-local requirement tests and write per-requirement evidence.
     - `targeted`: run targeted project regression only when changed files are configured by `test.projectPaths`.
     - `explicit-full`: run full project regression only when `.sennel/config.json` explicitly sets `test.testExecuteRegression: "full"`.
     - `deferred final-regression`: record deferred full regression evidence when full regression is not explicitly enabled here; `impl/final-regression` owns the default full project regression point.
   - **Downstream artifact use:** `test-result-review`, `impl-review`, `impl-gate`, and `retro` consume the cataloged current Attempt in `steps/test-execute/result.json` and its transient `steps/test-execute/output.log`; they MUST NOT re-run tests.
   - **Test command discovery:** Determine the test runner from the project's declarative configuration in this priority order:
     1. `.sennel/config.json` top-level `test.command`
     2. `package.json` `scripts.test`, executed as argv `["npm","test","--"]`
     3. `composer.json` `scripts.test`, executed as argv `["composer","run-script","test","--"]`
     4. `Makefile` target `test`, executed as argv `["make","test"]`
   - Do not use non-declarative documentation hints, language-specific implicit config, or task-prompt test command settings as root regression command sources.
   - If no supported command can be determined for a required project regression, do NOT guess. Fail before writing a normal `test-execute-result.json` and record the prerequisite failure in issue-log.
   - **Verbose execution:** Run the test command with verbose / non-quiet flags so individual test names appear in output (`--reporter spec`, `--verbose`, `jest --verbose`, `pytest -v`, etc.). Do not summarize; preserve raw output verbatim.
   - **Outputs:**
     - `<Version>/steps/test-execute/result.json` (Attempt-history machine-readable summary, schema = `src/flow/schemas/test-execute-result.schema.json`)
     - `<Version>/steps/test-execute/output.log` (transient raw stdout/stderr concatenation)
     - Each successful invocation publishes exactly one result for its current Attempt. No result cache or sibling-file fallback is used.
   - **Result schema (canonical):**
     ```json
     {
       "version": "2",
       "raw_output_path": "<Version>/steps/test-execute/output.log",
       "summary": [
         {
           "id": "R1",
           "execution": "executed",
           "result": "pass",
           "evidence": {
             "test_file": "<configured-spec-root>/<specId>/tests/foo.test.js",
             "test_name": "R1: parser accepts valid header",
             "command": "node --test <configured-spec-root>/<specId>/tests/foo.test.js",
             "raw_output_lines": { "start_line": 12, "end_line": 18 }
           }
         }
       ],
       "regression": {
         "required": true,
         "mode": "full",
         "root_test_command": "npm test --",
         "root_test_command_source": "package.json:scripts.test",
         "command": "npm test --",
         "commandSource": "package.json:scripts.test",
         "argv": ["npm", "test", "--"],
         "env": {},
         "source": "package.json:scripts.test",
         "metadata": { "script": "node --test" },
         "resolvedScriptDigest": null,
         "resolvedConfigDigest": null,
         "result": "pass",
         "raw_output_lines": { "start_line": 19, "end_line": 42 },
         "changed_files": [{ "status": "modified", "path": "lib/example.js", "fingerprint": "<sha256>" }],
         "trigger_relevant_changed_files": [{ "status": "modified", "path": "lib/example.js", "fingerprint": "<sha256>" }]
       }
     }
     ```
   - Each `summary[]` entry reports `execution: "executed"` for a promoted active test or `execution: "deferred_no_active_test"` for a canonical deferred receipt. Executed entries MUST include `evidence` with `test_file`, `test_name`, `command`, and `raw_output_lines` as `{start_line,end_line}`; deferred entries MUST include their canonical receipt and are not passing evidence.
   - Targeted or explicitly enabled project regression failures that start and exit non-zero, time out, or signal are valid v2 artifacts with `regression.result: "fail"`. Downstream gate blocks them. Deferred full project regression is not a impl-gate blocker; `final-regression` owns it after retro.
   - **Verdict values are lowercase:** `"pass"` / `"fail"`. Never `"PASS"` / `"FAIL"`.
   - **MUST: AI summary of raw output is forbidden.** Save the raw stdout/stderr exactly as produced by the test command.
   - **On complete:** the registry post-hook marks this step done automatically. Do not call `flow set step` manually.
