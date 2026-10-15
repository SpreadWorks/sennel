Merge the feature branch as a finalize sub-step.

## Required Sequence

1. Run `sennel flow run finalize-merge`.
   - `commands.gh=enable` selects the configured GitHub provider for PR submission. Provider availability, authentication and repository access must succeed before Git push; failure stops this route. Unset or disabled selects squash merge.
   - Display the JSON result to the user.

2. If merge fails, the onError hook automatically marks finalize-sync and finalize-cleanup as skipped.
   - Display the error and any recovery hints (e.g., rebase instructions for conflict resolution).
   - The dispatcher will skip subsequent finalize steps.

3. If the result shows PR route (strategy=pr), note that docs sync will need to be run after the PR is merged:
   ```
   PR マージ後に以下を実行してください:
   - ドキュメントの同期: sennel docs build または /sennel.flow-sync
   ```

4. After success, the dispatcher automatically advances to finalize-sync.
