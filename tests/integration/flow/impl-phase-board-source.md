# Board 37e4 — implementation-phase test contract

Captured at work start. Base branch: `main`; base commit: `340cf933bac55be0592417e16a67449698ac09a4`.

## 目的

`67fd`に基づき、03/05の実装フェーズについて、実装前に構造・実DI・横断シナリオテストの契約を固定する。対象は生成、レビュー、修復、Gate、保存、再開、次フェーズ受け渡しまでの一連の実装フローとする。

根拠HEADは`51ff765a51438635131b69daa12b207e32d12caf`。旧Step別設計は背景・契約参照として再利用するが、scope、受入単位、コマンド、担当は本カードと`67fd`を正とする。

## 対象scope

固定対象は次の12 leaf。

- `implement`
- `task-impl`、`task-review`、`task-triage`、`task-repair`、`task-gate`
- `test-execute`、`test-result-review`
- `impl-review`、`impl-triage`、`impl-repair`、`impl-gate`

02フェーズから昇格したSpec／Task、`tests.source`、実行plan、延期receiptを入口とし、integration Gateの正規Result／receipt、同一sourceにboundされたtest／finding証拠を04フェーズのRetroが利用できる状態を出口とする。source実装のみ、Task一件のみ、Gate単独の合格では完了としない。

## 非対象

本カードではボード設計、tests、fixture、検証対応表のみを作成する。プロダクト実装、テスト実行、Flow起動、Issue公開後のremote操作は実施しない。新しいruntime phase、状態正本、Result型、retry方針、Task専用registry、独自runner、任意source全体のOS rollbackは追加しない。04フェーズのRetro実装と05フェーズの最終regressionも対象外とする。

## 固定する設計契約

- 既存の`StepRegistration`、`StepExecutionContract`、単一`STEP_RESULT_REGISTRY`、`StepBinding`、`StepConnector`、canonical Store、共通structure checkerを再利用する。
- 02で導入するtyped operand、Review純粋値、TaskCollectionを再利用し、共有moduleは一度だけ導入する。
- Stepは工程上の意味をResultに確定し、DefinitionはResultだけからSettlementを選択する。未実行は`loop-required`、採用・完了は`completed`、意味分岐は`branch-required`、判断待ちは`user-input-required`、工程エラーは`StepErrorResult`とする。Execution／Await／Failureに偽Connectorを作らない。
- `task-impl`等の固定定義IDと、`<taskId>-impl`等の実nodeを`TaskStepIdentity`で対応付ける。lookup、Binding、digest、receipt、reloadでTask、round、Attempt、source baseline、manifest、handoff、producer Activity、sequence、finding identityを検証する。
- Result、候補、artifact、Activity、選択済み効果、receipt、次activation／Await／Failureを既存Storeで同時確定する。未実行triage／repairを不要判定で完了扱いする場合も、worker成功artifactやResultを補作せず、元Result／receiptへ理由を結ぶ。
- worker／Reviewの入力はimmutable file referenceとtyped handoffを使用する。UTF-8 bytes、digest、byteLengthを保持し、未読、改変、欠損、入力上限超過、context-limitは型付き拒否・停止とする。空finding成功や未評価のPASSへ変換しない。

## 作成するテスト

- `tests/structure/impl-phase.test.js`
- `tests/integration/flow/impl-phase-service-boundary-coverage.test.js`
- `tests/integration/flow-cli/impl-phase-artifact-scenario.test.js`

A01〜A12で固定12 leafの登録、entryとの双方向対応、組立、caller、保存契約を検査する。登録済みleafの列挙だけでは不十分とし、欠損、空scope、不正export、単一registry不整合を失敗にする。A07ではcanonical fixtureから全12登録の`create()`を呼び、実Service、constructor引数、Symbol／non-enumerable公開propertyを検査する。

`src/flow/steps/impl/`の7 leafと`src/flow/steps/task/`の5 leafを、`engine/composition/impl.js`および`task.js`の本番selectionで検査する。04フェーズのRetroを03 entryへ混入させない。

source entry、host filter、外側process、決定論的Reviewの実行shape、callerのselection保持、旧post判断・早期迂回、manager読取りとIO closureを検査する。provider、process、Git、FS読取りのみfakeとし、内部判断、dispatch、command、Storeは本番を使用する。

## 必須シナリオ

各ケースは正規producer→保存→全manager破棄→fresh manager／Store→実consumerを通す。ケースを一つの長大な全Flowへ直積化しない。

1. 全Task完了後に`test-execute`、結果Review、ImplReview、ImplGate、Retroへ到達する。Task frontier、parent状態、各receipt、Retroが参照する正規test producerを確認し、Taskなし経路も確認する。
2. implementation round 2、各roundのdurable semantic Review 4を再起動後も正しく計数する。4回目後のrepairは5回目Reviewへ戻らず、未レビューのfinding／source／Acceptance引渡しをGateへ保持する。
3. no-change、UNAVAILABLE、empty manifestを安全に消費する。限定zero-effect UNAVAILABLEはfailure artifactとして保存するがsemantic Review数へ加算しない。
4. host filter、未知・重複finding、flow readonly triage、修復apply集合、mutationIdを検証し、別Task／round／baseline、管理path／stage／commit、mutationなしrepairを拒否する。
5. immutable入力の先頭・末尾をまたぐ内容をworker／Reviewが同じbytes・digestで利用する。改変、欠損、byte上限、argv超過、file-read-failed、context-limitを停止として扱う。
6. test exit 1を完全な失敗観測として結果Reviewへ渡し、spawn／signal／timeoutをtooling停止として扱う。証拠ReviewのPASSで意味上のtest failを消さない。
7. ImplReview→triage→mutation→repair→新test chainを再構成し、旧chain、旧fingerprint、旧AttemptのPASSを再利用しない。quality issueは後続checkpointへ保持する。
8. Gate evaluatorのPASSだけで義務を消さない。identity、順序、apply集合、must-fix解消を再検証し、未実行worker成功を補作しない。
9. claim、sealed、publication-only、commit前失敗、commit後応答喪失、readback／cleanup失敗を区別し、exact receipt以外のreplay、二重適用、誤direct commandを拒否する。

## 実行コマンド

作成後に次を実行する。現時点では未実行とする。

```sh
node --test tests/structure/impl-phase.test.js
node --test tests/integration/flow/impl-phase-service-boundary-coverage.test.js tests/integration/flow-cli/impl-phase-artifact-scenario.test.js
node --test tests/unit/structured-step-result-contract.test.js tests/unit/flow-engine-step-result.test.js
node --test tests/integration/flow/review-whole-file-input.test.js tests/integration/flow/worker-artifact-handoff.test.js tests/integration/flow/task-review-causal-scenarios.test.js tests/integration/flow/task-review-round-exhaustion.test.js tests/integration/flow/gate-transition-boundary.test.js tests/integration/flow/repair-state-identity.test.js tests/integration/flow/non-gate-transition-boundary.test.js
```

検証前に、共有checker、既存Draft／Spec、01・02の受入済み構造／実DI／シナリオ、旧Step別設計の関連回帰を展開済みの直接コマンド一覧として証跡へ保存する。fixture、assert、source revision、dirty差分、ケース別結果、未検証境界も同一logへ対応付ける。`npm run test:structure`は全作成済みscopeの集計として別記録し、04・05のredを混入させない。

## 完了条件

- 合法positive fixtureで12 leafの登録、組立、保存、consumer利用が確認できる。
- checkerのnegative検出と、違反除去後の成功が確認できる。
- 契約不足を検出する意味のある初期red、横断シナリオ、予算、producer／consumer対応表が固定される。
- syntax／import失敗だけのredを契約検出として扱わない。
- 実装受入では、本カードの必須構造、実DI、横断シナリオ、回帰の全greenを要求する。

関連背景：旧Step別ボード`ede4`、`fdc7`、`9a58`、`28a5`、`cbd1`、`54d4`、`fd3b`、`57ec`、`6167`、`5f3f`、`8504`、`9eec`。旧ボードの番号、個別受入、旧コマンド列は実施指示として使用しない。
