## 目的

`67fd`の共通方針、`fc21`の共通構造テストに従い、05/05「最終化」フェーズのテスト契約を先行固定する。対象は以下の4 leaf と横断接続である。

- `finalize-commit`
- `finalize-merge`
- `finalize-sync`
- `finalize-cleanup`

テスト作成の完了は実装合格を意味しない。契約不足や未移行登録を検出する初期redを記録し、対応する実装ボードへ引き継ぐ。Flow開始、プロダクト実装、テスト実行、remote書込みは本Issueの対象外とする。

## 固定する契約

- 既存のID、lifecycle、Result型、retry方針、runtime phase、状態正本を変更しない。
- canonical読取り・admission・Git/gh/docs/worktree観測は外側で行い、意味の採用はStep、Execution/target/Await/Failure/Completionの選択はDefinitionが担う。
- canonical保存はprivate typed Service/Writer/既存Storeで行い、外部効果をStore transactionへ押し込まない。
- 全外部効果の前にoutbox pending/claimを保存し、外部効果後は実際のmarker、ref、PR、journalを照合してcanonical確定する。
- 未確認の外部成功を補作せず、保存失敗時もGit等を取り消したことにしない。証拠を保持し、exact recoveryへ引き継ぐ。
- 既存の`FlowOutboxIdentity`、`FinalizationExecutionIdentity`、共通`StepErrorResult(stepId, error)`、Result registryを再利用する。専用kind/codecの追加は本フェーズ内で一度だけ行う。
- Stepごとの独立Spec、独立受け入れ、別のError class、Park/Completionの新規state機構は追加しない。

## 既存APIと責任範囲

- commit: `RunFinalizeCommitCommand`、permission/approval/preflight、`FinalizeCommitPathSet`、`commitOrSkip`、`hasOutboxCommit`、marker/outbox
- merge: `resolveMergeStrategy`、`FinalizeMergeTransaction`、`RepositoryFlowOperationLock`、isolated worktree、expected SHA/ref CAS、main materialization、marker/PR確認
- sync: `RunFinalizeSyncCommand`、`FinalizeFlowStateOwner`、`InterruptedFinalizeSyncRecovery.inspect/recover`、interrupted-sync settlement、runtime log/outbox/operation lock
- cleanup: `FinalizeCleanupStateResolution`、`SharedFinalizeCleanupJournal`、teardown/validate、auto-rescue ref CAS、`FinalizeTeardownAuthorization`、force audit、`FlowCompletion`、completion commit、current解除、last-finalized pointer

`direct4commands`、registry pre/post/error、dispatch/get-next-action/claim、recover-finalization、recover-interrupted-finalize-sync、manual approval、force/auto-rescue、plugin境界、main state owner、status/report showをcaller台帳へ対応付ける。read-only取得による保存、caller独自のretry/skip/route、merge後にsyncを自動起動する実装は負例として検出する。

## ResultとConnector

正常・分岐Resultは既存registryでCamelCaseの`<Kind>Result`として固定する。代表例は以下のとおり。

- commit: `execution-required`、`created`、`unchanged`
- merge: `execution-required`、`squashed`、`policy-skipped`、`pr-opened`
- sync: `execution-required`、`built`、`unchanged`、`skipped-with-warning`
- cleanup: `execution-required`、`completed`、`completed-with-warning`
- 各leafのerror: 共通`StepErrorResult`による工程内Failure

Connectorは次の3つだけとする。

- `FinalizeMergeConnector`: commit → merge
- `FinalizeSyncConnector`: merge/skip → sync
- `FinalizeCleanupConnector`: sync成功・unchanged・正規skip → cleanup

PR Await、Execution、Failure、最終Completionへ偽Connectorを追加しない。source Attempt、publication/receipt、main authorityを選択済みtargetへ結ぶだけとする。

## 横断シナリオ

`tests/integration/flow-cli/finalization-phase-scenario.test.js`を新設し、正規04 report producer → 保存 → manager破棄 → 05の実command/Store/次consumerを使用する。内部判断、Store、Git helperはmockせず、必要なremote gh/provider/docs processのみfakeとする。

最低限、以下を検証する。

1. 通常完了: commit、merge、docs同期、cleanup、reload、current解除、last-finalized pointer、実report showまでのreceipt/outbox/target/source report整合。
2. commit範囲とno-change: implementation、Spec/docs、無関係indexを分離し、合法なno-changeと拒否を検証。
3. merge戦略とPR待機: skip、local squash、PR公開、同key再確認、PR Awaitからの自動sync/cleanup禁止。
4. conflict再開: merge失敗、認可済みexact/pre-sync recovery、skipのpending reset、busy owner・branch drift・未知dirtyのcall前拒否。
5. sync警告と正規中断skip: build/diff失敗、診断保持、認可skip、`completion_with_warnings`、runtime identityとlock再検証。
6. 外部効果・保存断点: reload後にmarker/ref/remote/journalを照合し、未完了効果だけを再開。二重commit、削除、PR、Activityを発生させない。
7. teardown救済と不変性: orphan、unknown status、所有違反を拒否し、auto-rescue/force auditはCAS・限定compensation・自分のaudit identityに限定。完了後はexact replay以外を拒否。

last-finalized catalog reader、report show、statusを実consumerとして検証し、最終statusやcommit数だけでなくreceipt、authority、key、元failure/警告、Git tree/index、consumer入力をassertする。

## 構造・実DIテスト

以下を追加する。

- `tests/structure/finalization-phase.test.js`
- `tests/integration/flow/finalization-phase-service-boundary-coverage.test.js`
- `tests/integration/flow-cli/finalization-phase-scenario.test.js`

`steps/finalize/`全4leafと`composition/finalization.js`の`finalizationStepRegistrations`を双方向に対応付ける。共通checker A01〜A12で、登録欠損・重複、選択破棄、direct/recovery bypass、Stepの間接IO/Store/Definition依存、ServiceのGit/gh/削除/manager読取り、広いWriterを検出する。

実DIでは4leafを正規canonical fixtureから生成し、全argumentTypesとprivate Serviceを検査する。各違反についてrule、位置、依存経路、除去後の成功、runtime state不変性を個別に記録する。

## 実行コマンド

```bash
node --test tests/structure/finalization-phase.test.js
node --test tests/integration/flow/finalization-phase-service-boundary-coverage.test.js tests/integration/flow-cli/finalization-phase-scenario.test.js
node --test tests/integration/flow/finalize-completion-boundary.test.js tests/integration/flow/finalize-merge-transaction.test.js tests/integration/flow/finalize-merge-retry.test.js tests/integration/flow/finalize-cleanup-robustness.test.js tests/integration/flow/finalized-flow-immutability.test.js tests/integration/flow/run-report-show.test.js
npm run test:structure
```

syncのruntime、next-action、recovery、Result/receipt、canonical runtime、operation lock/outbox、導入済みDraft/Spec、01〜04の構造・実DI・シナリオ試験は、検証前に実ファイル一覧を固定する。

## 受け入れ条件

- 05全4leafと横断接続の構造・実DI・シナリオ契約が定義されている。
- 導入済み全フェーズ、05全4leaf、横断case、既存回帰がgreen必須である。
- 初期redはテスト先行の契約不足として全suite集計と別記し、skipやbaselineで隠さない。
- producer → 保存 → reload → consumer、fixture/assert、revision、dirty差分、ケース別ログ、未検証項目を記録する。
- 検証後に変更があれば影響集合を再実行し、部分結果を全体合格へ合算しない。
- last-finalized catalog reader/report show/statusまで、canonical resultと実consumerの整合を確認する。

## 対象外・制限

新たなtransaction/lock/rollback基盤、無制限dirty削除、全面abort、汎用worker終了、未承認のpost-merge orchestration、外部Git/remote/OS削除の全面原子性、証拠のないexact recovery、任意dirtyの救済成功は保証しない。

根拠は既存APIとHEAD `51ff765a51438635131b69daa12b207e32d12caf`のソースとする。旧Step別ボード`8f05`、`689c`、`0843`、`c53c`は背景・詳細契約として保持するが、実施scope、配置、コマンド、担当、受け入れ単位は本本文と`67fd`を正とする。
