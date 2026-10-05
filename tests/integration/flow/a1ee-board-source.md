# a1ee — frozen board input

Base branch: `main`; source commit: `5c8b7f62fa384bc18b52ed05d02b2701164e6c63`.
Implementation branch: `codex/a1ee`.
Captured on 2026-10-05 with `sennel workflow show a1ee`.

## 目的

親指針 `67fd` と共通構造テスト `fc21` に従い、実施順 `02/05` の「Spec承認・RequirementTest作成」フェーズについて、生成・レビュー・修復・Gate・保存・再開・次フェーズ連携の構造、DI境界、横断シナリオを先にテストとして固定する。

本カードの作業範囲は、対象5 leafのテスト作成・実行・証拠保存である。製品コードの修正は実装担当へ引き渡す。本文のrefine、Issue公開、Flow開始、テスト実行は別操作であり、本カードのrefine完了を実装合格とはみなさない。契約不足による初期失敗は、checker結果と分離して記録する。

## 対象範囲と非対象

対象leafは次の5つに限定する。

- `approval`
- `test-generate`
- `test-review`
- `test-repair`
- `test-gate`

既存のStepId、API、Task、状態正本、StepResult基底type、retry方針、単一registryを再利用する。固定責任leaf、新しいruntime phase、Step単位の別Spec、先行受け入れ、旧Step番号単位の個別受け入れは追加しない。旧ボード `22ca`、`f178`、`971e`、`e9b9`、`ecc1` は背景資料とする。

`03` が未移行の場合は、現在の正規implement入口を使用し、未来のStepを前提にしない。

## 既存契約の再利用

- 承認: `CanonicalSpecApproval`、`approvalRouteFacts`、`resolveDefinitionRoute`、`approveSpecContinuation`
- Task順序: `TaskCollection.admissionOrder`
- 初期化: `initializeRequirementTestLifecycle`
- 生成・修復: claim/seal、RequirementTestのPlan、Budget、BundleLineage、CandidateBundle、ArtifactStore
- Review: `CanonicalReviewWorkUnit`、Promotion、ReviewEvidence、Disposition、`TestReviewPromptPlan`
- Gate: `runRequirementTestGate`、`RunRequirementTestGateCommand`、`RequirementTestCheck`、`GateResult`

未承認Await、manual/auto承認、testable R plan、Rなしの4 leaf skip→implementは既存ルートで扱う。auto承認にacceptance権限を与えない。Stepは意味と候補、Definitionは予算と接続を確定し、whole-file入力、provider、runner、seal、materialization、読み取りは外側境界に置く。

## Result、Connector、Settlement

Result kindは閉じた集合として、専用具象classを単一の `STEP_RESULT_REGISTRY` に登録する。`test-*` のfull kindは `leaf-suffix` 形式とし、target connectionだけがConnectorを持つ。Execution、Await、FailureをConnectorへ持たせない。

| leaf | Result kind | type | Definitionの選択 |
| --- | --- | --- | --- |
| `approval` | `approval-awaiting-user` | `user-input-required` | Await |
| `approval` | `approval-confirmed-with-tests` / `approval-confirmed-without-tests` | `completed` | generate / implement＋4 leaf skip |
| `test-generate` | `candidate-saved` | `completed` | Review |
| `test-generate` | `structural-rejected` | `branch-required` | semantic repair / defer |
| `test-review` | `execution-required` | `loop-required` | Review / Gate |
| `test-review` | `passed` / `advisory` | `completed` | Gate、repairはskip |
| `test-review` | `rejected` | `branch-required` | semantic repair / defer |
| `test-repair` | `progress-saved` | `loop-required` | 同Attempt残batch |
| `test-repair` | `candidate-saved` | `completed` | 次revisionでReview |
| `test-repair` | `structural-rejected` | `branch-required` | repair / defer |
| `test-gate` | `compatible` | `completed` | promotion＋次frontier |
| `test-gate` | `incompatible` | `branch-required` | 同candidateでReview |
| 全 `test-*` | `tooling-unavailable` | `loop-required` | tooling retry |
| generate/review/repair | `external-blocked` | `error` | 外部依存の停止 |

全leafの意味上のErrorは既存 `StepErrorResult` を用いる。`external-blocked` は専用Errorを伴う閉じた分類観測とし、汎用Error別名は追加しない。pre-Step失敗は正確なclaimに基づくコマンド失敗として扱い、typed観測を正規経路で注入できる場合だけResultを採用する。

`RequirementTestResultBinding`、`RequirementTestResultFrontier`、`RequirementTestRetryState` で、run/spec/leaf/Attempt、plan publication、R/specRevision/status/candidate、残存Rの順序・identity・status、Budget、承認方式、既計上findingを固定する。候補、Review evidence、repair progress、Gate publicationには必要な証拠だけを持たせ、path/hash/size、lineage、receipt、staged digest、named observationを利用する。bytes、汎用payload、追加facts、未定義のtarget/effectは拒否する。

`test-generate`では専用operandのserialize/rehydrateを一度拡張する。`settleRequirementTestStepResult(stepId, result)` は保存済みResultだけから既存LifecycleDecision/applyを選択し、`Decision.facts` はsource bindingへ置換する。Store Admissionはplan、Attempt、candidate、Result digest、effectを照合し、routeを再解決しない。

ReviewのPASS/ADVISORYはrepairをskipしてGateへ進む。Gate不適合は同candidateを再Reviewし、semantic予算の加算は0とする。適合した候補だけをpromotionする。

## 保存、再開、retry、原子性

- 承認は親先行・兄弟順・既存runtime Taskを維持し、Task、Spec承認、初期plan、Result/receipt/Activity、次activationを原子的に保存する。
- 既存承認へのrequested承認は拒否し、通常継続は同じreceiptを再利用する。replayで `confirmed_at` やnotesを変更しない。
- R、specRev、bundleRev、predecessor、source Attempt、findingの完全identity、primary/support owner、plan hash/size、Activityを保持する。
- 非final生成はR別receiptで同Attemptに保存する。repairはbatch進捗とstaged sourceを保存し、最後のbatchだけ次candidateを公開する。
- 同件数別batch/finding、新tooling Attemptへの旧coordinator権限流用は拒否する。
- tooling retryは3回、semantic retryはRごとにauto/manual各5回、permission/externalは0回とする。duplicate findingは二重加算せず、reloadやauto/manual切替で予算をリセットしない。stale、権限、seal、保存不正はretry分類にしない。
- Gate適合時はResult、plan、receipt、Activity、`tests.source`、provenance、support baseline、次activationを原子的に保存する。
- defer時はfailure、deferred receipt、findings、plan、次Rを保存し、deferredをactiveへpromoteしない。
- commit前後の応答喪失、receipt read、cleanup失敗は区別して検証するが、別の汎用Errorやfallbackは追加しない。
- canonical reloadでは一致replayだけを許可し、同bytesの別publicationを拒否する。

## 実装配置、構造、DI

予定配置は以下とする。

- `src/flow/steps/test/` 配下の5 leaf
- `src/flow/engine/composition/test.js` の `requirementTestStepRegistrations`
- `src/flow/services/{approval,requirement-test}-{input,service,settlement-writer}.js`
- `src/flow/engine/connectors/test/{approval,requirement-test}-connector.js`
- 純粋値: `src/spec/lib/task-values.js`、`src/flow/lib/{review-evidence,test-review-repair}-values.js`

lifecycleのSpec schema検証は既存validatorを使う外側境界へ移し、factory caller検証と値invariantは維持する。A01〜A12を5 leafへ適用し、A07では全登録の `create()` を検証する。責任leaf欠損、間接IO、実DI欠落、迂回caller、別phase追加、単一registry不整合を拒否する。

caller台帳は、Specからset-approval/dispatch、get-next-action/status/claim/auto/retry、worker handoff、run-review/registry post、Gate command/post、LifecycleAdmission/completeRequirementTestLifecycleと失敗入口、repair recovery、implement/test-execute/retro/acceptance/reportまでを結ぶ。同一registration/selectionへの統一と旧caller判断の除去を構造・実DI・シナリオで検証する。

## 作成・実行するテスト

- `tests/structure/requirement-test.test.js`
- `tests/integration/flow/requirement-test-service-boundary-coverage.test.js`
- `tests/integration/flow-cli/requirement-test-phase-scenario.test.js`

実行コマンド:

```sh
node --test tests/structure/draft.test.js tests/structure/spec.test.js tests/structure/prepare.test.js tests/structure/requirement-test.test.js
node --test tests/unit/structured-step-result-contract.test.js tests/integration/flow/requirement-test-service-boundary-coverage.test.js tests/integration/flow-cli/requirement-test-phase-scenario.test.js
node --test tests/unit/requirement-test-definition-policy.test.js tests/integration/flow/requirement-test-lifecycle-regressions.test.js tests/integration/flow/run-requirement-test-gate.test.js tests/integration/flow/mixed-requirement-downstream.test.js
```

共有registry変更時は `flow-engine-step-result`、`draft-step-result-settlement`、`spec-gate-result-settlement` を実行する。境界変更時は `draft/spec-artifact-scenario`、whole-file変更時は `review-whole-file-input/review-work-unit`、純粋値移転時はTask/render利用先の既存試験を実行する。全repository試験や実AI常時試験は要求しない。

## 必須シナリオ

1. 承認→実装: 正規Specからmanual/auto/Await、Rなし・複数R・非testable混在、生成、Review PASS/ADVISORY、Gate、reload、implement入力までを検証する。親子順とskip Attempt非補作を確認する。
2. 修復→再Review: 構造またはReview拒否、複数batch、次revision、Review、Gateを検証する。同candidate再Review、finding、lineage、許可path、中間進捗を保持する。
3. 誤promotion拒否: expectationが `fail` の場合は `assertion_failed`、`pass` の場合は `assertion_passed` だけをGate適合として扱う。ReferenceError/import/bootstrap/syntax/skip/missing/multipleをassertion結果として誤採用せず、candidate隔離とcross-R ownershipを確認する。
4. 上限・再開: R別semantic/tooling上限、duplicate、permission、auto切替、nonblocking、batch停止、reloadを検証する。二重provider、予算reset、部分skip、誤promotionを許可しない。
5. 混在R出口: promoted/deferred/staged/pendingから次Review/generate/implementへ進む経路を検証する。promotedだけをtest-execute対象とし、deferred receiptはretro/acceptanceの未解決義務として保持する。

各保存点で同bytes別Activity、stale plan/spec/Attempt/candidate、seal tamper、commit前後の応答喪失を検証する。外部依存だけfakeとし、内部producer、Store、次入口は実経路を使う。

## 完了条件と証拠

次を満たした時点でテスト作業完了とする。

- A01〜A12、5 leafの構造・DI・横断シナリオが固定されている。
- Result/Settlement、単一registry、Connector境界、原子的保存、retry予算、reload、誤promotion拒否がテストされている。
- checker結果、製品コードの初期red、ケース別結果、ログ、最終候補の再検証結果を別集計・保存している。
- 架空登録、syntax/import失敗、skip、期待緩和を完了扱いにしていない。
- 旧 `c731d703` 設計を `51ff765a5` のwhole-file契約および着手時の現行ソースへ照合し、実測したsource revision、scope、assert、初期red、ケース別結果、ログ、最終候補の再検証を記録している。

旧Step別ボードは統合済みの背景・詳細契約として保持するが、配置、scope、コマンド、共有API担当、依存順、受け入れ単位は本フェーズ本文と `67fd` を正とする。旧28Step番号、Stepごとの別Spec・個別受け入れ・旧コマンド列は実施指示として使用しない。
