# 4b0b 実装・検証記録

- 対象: Task / integration Gate PASS と同じ保存で再試行表示カウンタを reset する。
- 作業ブランチ: `codex/4b0b`
- worktree: `.sennel/worktree/4b0b`
- 基準: `main` の `fa8cb77813e3f028fb284fca65407777ac91bcf2`
- 元 checkout の既存変更は持ち込まず、専用 worktree 内で実装・検証した。
- 判定: **4b0b の受入条件 1〜4 は達成**。最終結果をケース単位で重複除外すると、38 件 PASS、下記の既存契約問題 2 件が未解決。対象の受入条件に未確認事項はない。

## 実装判断

Definition が選んだ `GateRetryMetricEffect` を既存 `ActivityMetric` に変換し、既存の `confirmAttempt()` → `#applyAttemptTransition()` に渡す。変換は Task metric writer と typed retry でも共用する。Result、receipt、Gate artifact、Task 完了、次工程、reset は同じ canonical transaction に所属する。

保存された Activity metric と選択済み effect の共通検査を、settlement replay、`readCurrentStepSettlement()`、`findStepSettlementReceipt()` に適用する。一般履歴は `metric: null` でも読めるが、reset のない PASS receipt を適用済みの権限にはしない。

Definition の意味判断、Attempt 予算、receipt/schema、agent 実行、表示カウンタの判断権限は変更しない。過去データの自動補正、追加の metric Activity、独自 journal は追加しない。

## 受入条件と因果経路

| 条件 | 正規 producer・保存・読み戻し | 確認する結果 |
| --- | --- | --- |
| 1: R3 / R4a | 既存 Task / Review / Gate dispatcher と fresh `FlowManager`。2 件の SKIP のみ解除し、入力・期待値を維持 | 修正前は 5 / 2、修正後は両方 0。表示履歴が fresh Attempt を exhaustion にしない |
| 2: Task の次 Task / 最終 Task | 正規 Gate execution claim → 登録済み Step / Service / Store → confirmation と `task.gate` → fresh state / metrics / completed receipt | Task count 4 → 0、integration count 7 を維持。Task 完了と正しい successor が同時に見える |
| 2: integration PASS | 実 CLI → 登録済み Gate → fresh reader / completed receipt / exact Attempt binding | integration count 2 → 0、Task count 1 を維持し `retro` へ進む |
| 3: replay / 応答喪失 | 実 writer 入力と保存済み receipt → 新しい manager で replay / receipt 回収 | 同じ receipt。Activity / Attempt / catalog が増えず、後続 increment 1 を古い reset が消さない |
| 4: 保存中断 / 復旧 | 既存 fault injector の Activity append、catalog rename 前、rename 後 directory fsync 前 → fresh reader / 正規再実行 | rollback では元の execution-required checkpoint と count 4 を維持。commit 後の応答喪失では確認・reset・artifact・Task 完了を一度だけ回収 |
| 4: stale 拒否 | Gate producer 後の source 変更、別 Attempt binding → 保存前の検査 | state / Activity / catalog / count に副作用がない |
| 4: metric 認証 | 実 PASS を独立 fixture に複製し、metric を null または異なる increment に変更 → 一般読取り後、3 種の receipt API | 一般履歴は読める。各 receipt API は選択済み effect との不一致で拒否し、履歴を補正しない |
| 4: 既存 retry | 正規 integration Gate producer → semantic retry → fresh metrics / Attempt ordinal | retry 1..4 は count 1..4、5 回目の exhaustion では 4 を維持 |

## 実行証跡

ログは worktree 内の `.tmp/4b0b/` に保存する。

- `baseline-r3-r4a.log`: 修正前、2 件とも対象の assertion で失敗、SKIP 0。R3 は `5 !== 0`、R4a は `2 !== 0`。
- `cli-gate-after.log`: 修正後、R3 / R4a と実 CLI integration PASS の 3 件 PASS、失敗 / SKIP 0。
- `activity-retry-regression.log`: Activity / journal / retry 関連 28 件中 27 件 PASS。下記の既存 fixture 不備 1 件を含む。
- `settlement-after-fixture.log`: retry、metric 認証、issue publication、stale、tooling の 5 件 PASS。下記の既存 recovery 契約問題と、後で訂正した追加テストの API 利用誤りを含む。
- `task-lifecycle-replay-atomic.log`: 最終 Task の reset / artifact / 次工程が PASS。追加テストの receipt 返却型の誤解を訂正する前の実行記録を含む。
- `replay-atomic-final.log`: exact replay / 後続 increment / 次 Task と、3 保存境界の 2 件 PASS、失敗 / SKIP 0。
- `baseline-issue-log-fixture.log` / `baseline-integration-fixture.log`: 基準 commit の detached worktree で既存失敗を比較した記録。

```sh
node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='R3: display retry history cannot exhaust a fresh canonical Attempt|R4a: gate PASS resets counter to 0|passes bounded cited requirement context through the real gate command' tests/integration/flow-cli/gate-impl-integration.test.js > .tmp/4b0b/cli-gate-after.log 2>&1

node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='persists the sealed.*Task Gate pass lifecycle|keeps Task Gate reset atomic|rejects metricless and mismatched saved Task Gate receipts|rejects a Task Gate decision when allow-listed source|settles exhausted integration semantic failures|binds Task Gate issue settlement|admits only the current recovered integration Gate|keeps a tooling-failed Task Gate' tests/integration/flow/canonical-flow-manager-runtime.test.js > .tmp/4b0b/settlement-after-fixture.log 2>&1

node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='persists the sealed.*Task Gate pass lifecycle|keeps Task Gate reset atomic' tests/integration/flow/canonical-flow-manager-runtime.test.js > .tmp/4b0b/task-lifecycle-replay-atomic.log 2>&1

node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='persists the sealed Task Gate pass lifecycle through Task completion|keeps Task Gate reset atomic' tests/integration/flow/canonical-flow-manager-runtime.test.js > .tmp/4b0b/replay-atomic-final.log 2>&1

node --test --test-concurrency 1 --import ./src/sennel.js --test-name-pattern='Activity|journal-first|crash windows|gateRetry|countGateRetry|issue-log recording' tests/integration/flow/current-flow-state-foundation.test.js tests/integration/flow-cli/current-flow-state-journal.test.js tests/integration/flow/gate-retry-counter.test.js tests/integration/flow/gate-retry-counter-transparency.test.js > .tmp/4b0b/activity-retry-regression.log 2>&1
```

## fixture と既存失敗の切り分け

下位層の既存 Gate helper は execution claim を作らずに synthetic Gate result を渡していた。現行 composition は `acquirePendingExecutionContract()` を必須とするため、このセットアップは対象の保存処理に届かない。基準 commit の既存 integration テストでも同じ missing-contract 拒否を確認した。

今回の対象ケースでは既存 `produceCanonicalFixtureStep()` を再利用し、正規の Gate command と外部 provider fake で実行契約を保存してから、登録済み Step への publication を検証する。追加した `settle: false` は `entry.post` の直前で止めるだけで、既定の `settle: true` は従来どおり。新しい rollback assertion は、その正規 producer が作った execution-required checkpoint を保持することを確認する。

`gate-retry-counter-transparency.test.js` の issue-log ケースは `activate("impl-gate")` が必須の `test-execute` producer を通さず、セットアップで停止する。変更前と同じエラーを detached baseline でも確認した。対象コードに達しないため、4b0b の回帰とは扱わず、このテストの期待値や SKIP は変更しない。

integration evidence rewind の既存ケースも、変更前は missing execution contract で拒否される。正規 producer を先に通した場合も、source 変更後の execution contract の `inputRevision` / `promptDigest` / `inputBaselines` 不一致で拒否された。PASS reset とは別の recovery 契約問題として両方の結果を記録し、期待値や SKIP を変更しない。

追加テストで判明した API の使い方も訂正した。exact replay は保存済みの plain receipt を返し、`assertStored()` は変換せず入力を返す。完了済み `task.gate` は active producer 用の `readProducerArtifact()` では取得せず、契約で許可された後続 `acceptance-review` の `readArtifact()` で読む。これらの訂正で product の契約や期待する結果は変更していない。

## 検証の範囲

実装担当とは別の担当が product 差分・責務境界とテストの producer / 保存 / 読み戻し経路をレビューした。管理者も主要差分、API の返却契約、実行ログと受入条件の対応を直接確認した。追加変更の影響を受けない PASS 結果は再利用し、訂正が必要だったケースだけ再実行した。

フルテスト、実 AI、OS kill による crash、全破断点・全履歴の網羅は実施しない。注入した保存境界と fresh reader による復旧を検証し、未知の障害まで網羅したとは主張しない。既存の不整合表示値は自動補正しない。

比較用 detached worktree と不要な作業ファイルは削除し、受入判断に必要なログと作業 worktree は残した。この実装・検証工程の完了時点では、コミット、merge、push、公開、ボード変更は実施していない。
