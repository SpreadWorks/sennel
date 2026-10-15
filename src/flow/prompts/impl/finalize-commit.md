Commit implementation changes as a finalize sub-step. This is the first step of the finalize sequence.

## Required Sequence

1. Resolve context.
   - Run `sennel flow get resolve-context` to get JSON with:
     - `mainRepoPath`, `worktreePath`, `activeFlow`, `flowJsonPath`
     - `spec`, `baseBranch`, `featureBranch`, `worktree`
     - `dirty`, `dirtyFiles`, `currentBranch`, `github`

2. Run `sennel flow run finalize-commit [--message "<msg>"]`.
   - The command performs preflight checks, migration hooks, stages implementation changes from the execution worktree, and creates the implementation commit.
   - Flow artifacts remain in the active Flow's configured base-side spec directory. They are not copied into or committed from the execution worktree.
   - The final target-only spec/docs commit is created after worktree cleanup, once the final Flow state and log have been recorded.
   - Display the JSON result to the user.
   - If preflight fails (result=preflight_failed), display the failure reason and stop.

3. After success, the dispatcher automatically advances to finalize-merge.
