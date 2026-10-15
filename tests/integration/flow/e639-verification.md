# e639 実装・検証記録

基準は `main` の `4d6366aa434531f9690e592c35a3581a0a685c1c`。
作業ブランチは `codex/e639`、worktree は `.sennel/worktree/e639`。
最新ボード本文と開始情報は `.tmp/e639/board.json` / `start.json` に保存した。

## 実装方針と変更

既存の `RequirementTestGenerationExecutionState` と
`CanonicalFlowManagerStore.requirementTestGenerationExecutionState` を repair に拡張した。
Store が同一 canonical view の plan、progress producer、保存 Result、Requirement
receipt、completed request group、stored execution contract を照合し、Definition が
認証済み完了の generation + 1 と同じ budget owner を選ぶ。未完了 claim を削除したり、
世代を進めるために coordinator Attempt を作り直したりしない。

production の変更はボード指定の6ファイルに限定した。

- `src/flow/definition.js`: 完了済み repair progress に基づく次世代選択。
- `src/flow/lib/canonical-flow-manager-store.js`: 同一 view の認証、保存時の原子的照合。
- `src/flow/lib/worker-artifact-handoff.js`: 選択済み契約の利用、plan/progress baseline、完了 cleanup の優先認証。
- `src/flow/lib/test-review-repair.js`: 既存 progress episode の読取りと共通 group 照合の利用。
- `src/flow/engine/step-result.js`: 既存 progress identity に projection、group、進捗差分照合を集約。
- `src/flow/engine/composition/test.js`: 旧 projection export を削除。

新しい schema、journal、registry、依存、agent host 固有機構は追加していない。
設定や実行コマンドの追加はなく、既存の Requirement dispatcher / handoff / Store 経路で利用する。

## 受け入れ条件と実測根拠

| 条件 | 判定 | 主な証拠 |
| --- | --- | --- |
| 1. 同じ Attempt の複数 batch と最終候補の Review/Gate 利用 | 達成 | 元の `persists multiple repair batches...` が正常 producer・保存・reload・後続利用を実行 |
| 2. 別 group の identity、次世代、budget owner | 達成 | 元の same-size REPLAY、`GENERATION repair reload...`、実際の第1 receipt を第2保存へ流用する ATOMIC ケース |
| 3. 新 coordinator Attempt が旧 progress を認可しない | 達成 | 元の public tooling retry REPLAY が正規 retry と旧 coordinator 拒否を検証 |
| 4. write / Result / request group 不一致を原子的に拒否 | 達成 | 3つの ATOMIC ケースが実際の Store 呼出しを改変し、状態・catalog・receipt・progress の保存前後を比較 |
| 5. 未完了 claim、別 producer、旧 progress の拒否と完全一致 replay | 達成 | GENERATION refusal、exact Store replay/conflict、claim/provider の plan/progress baseline race、既存 before/after commit ケース |
| 6. 第2 nonfinal commit 後の process-stop cleanup 復旧 | 達成 | 実 managed Node 子プロセスの stop callback と永続 receipt を照合。manager と coordinator を再生成し、完了済み2 batch は各1回、残る第3 batch だけ実行 |

詳細な outcome → producer → storage → readback → consumer の対応は
`.tmp/e639/test-map.md` に記録した。process-stop ケースは実際の子プロセス終了証拠を用いるが、
OS crash 全般の保証を主張するものではない。

## 実行結果

全コマンドは作業 worktree 内で実行し、長時間コマンドの出力を保存した。
ログは `.tmp/e639/` に残している。

| ログ | 結果 |
| --- | --- |
| `baseline.log` | 元の3ケース: 0 PASS / 3 FAIL / 0 SKIP。すべて第2 batch の `promptDigest` 競合 |
| `frozen-after-fix.log` | 同じ入力・body・期待値の3ケース: 3 PASS / 0 FAIL / 0 SKIP |
| `values-and-structure.log` | 値型・ポリシー・Requirement 構造: 18 PASS |
| `shared-contracts.log` | 共有 provider/baseline/replay、generate 継続、repair codec: 18 PASS。既存 fixture 2 FAIL は下記で分離 |
| `shared-baseline-existing-failures.log` | 開始 commit の短命 detached worktree でも同じ既存2ケースが同じ契約不足で FAIL |
| `repair-regression.log` | 18ケースの初回測定: 15 PASS、追加テストの契約・返却形状の取り違えによる3 FAIL |
| `repair-corrected-cases.log` | 追加期待値を訂正した3ケースと coordinator を再生成する復旧ケース: 4 PASS |
| `draft-spec-consumers.log` | Draft / Spec の正規 producer・保存・reload・Acceptance 利用: 2 PASS |
| `shared-cleanup.log` | 既存 Draft / Spec Gate handoff の拒否・sealed recovery・cleanup: 4 PASS |

repair の18種類は、変更していない14ケースの結果と最終4ケースの結果を合わせて達成した。
新規テストの訂正根拠は `test-map.md` に残した。元の3つの障害回帰は body・期待値を変更せず、
SKIP のみ解除した。Requirement の履歴は `55dc-product-defects.md` に保持している。

同じ frozen 選択を再実行するコマンド:

```sh
node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='persists multiple repair batches in one Attempt before publishing the next candidate revision|REPLAY same-size subsequent batch cannot reuse the first real checkpoint|REPLAY public tooling retry cannot authorize saved repair progress' tests/integration/flow-cli/requirement-test-phase-scenario.test.js > .tmp/e639/frozen-rerun.log 2>&1
```

## 既存機能への影響と制限

generate の次 Requirement は既存の同一 Attempt receipt から正しく次世代へ進み、budget identity を維持した。
Draft / Spec の後続利用と共通 cleanup も選択ケースで確認した。
通常の dispatch、永続化、実行契約を共有し、利用者の新しい設定は不要。

既存 `requirement-test-lifecycle-regressions.test.js` の
`discards Attempt-bound repair progress atomically before a tooling retry` と
`restarts partial repair progress under the new tooling Attempt and continues the remaining batch`
は、repair 前の手組み Review fixture が canonical execution contract を持たず失敗する。
開始 commit と変更後で同じ失敗を測定し、テストや product を変更して隠していない。
ボードの正規 public tooling retry 経路は元の frozen ケースで成功した。
この2件は今回の変更による回帰ではなく、受け入れ条件に影響する未確認事項は残っていない。

最終判定: **完了**。検証は対象と共有利用箇所の選択実行であり、フル suite の成功は主張しない。
上記の検証時点では、コミット・merge・push・公開・Flow 起動・ボード変更は実施していない。
短命 baseline worktree は削除し、作業 worktree と受け入れ証拠はレビュー用に保持した。
