# f0c5 正規Draft Reviewのquery投影・検証記録

基準commit: `3ff0e282d8651d462ed7671963465a820085cb2e`（main）。
作業branch: `codex/f0c5`、worktree: `.sennel/worktree/f0c5`。
対象ボード本文はworktree内の`.tmp/f0c5/board.md`に保存した。
この記録は未コミット差分の検証であり、ボードの完了・更新を表さない。

## 実装判断

正規Draft questions／coverage Reviewを、保存済みconcrete Result、receipt、
execution lifecycleに基づいて解釈する。checkpoint／claimedの評価は0件・
`not-applicable`、publicationは保存verdictと指摘、terminalはpublicationの
同じentityを参照する。coverage PASSの正規completion connectorも保存receiptで検証する。

`CanonicalDraftReviewObservation`は本文、source revision、内部3項目を既存の型で
検証する。Evidence変換とpublication identity生成はproducerとreaderが共有する。
内部値は公開せず、未知field、矛盾、失われたgenerationは既存のerrorで拒否する。
raw worker bytes、runtime seal、未保存時刻を再生成しない。

過去Attemptは保持されたexact recordから解決し、sourceは実際のpublication Activityと
保存位置を指す。最新descriptorのownerと過去producerを混同しない。
公開Schema Revision 2、request、検索、cursor、recordedAt、capture／hydrationは維持した。
同じIDのJSONをterminalの読取り順で変更しない。

共有historyの既存`.attempts`／`.current` DTOとobservationのown fieldsを維持し、
新しい`.currentRecord`／`.atAttempt()`で完全recordを読む。
独立レビューで発見した`.current`形状の回帰は、既存テストを変更せず修正した。

## 受入条件との対応

| 条件 | 確認結果・根拠 |
| --- | --- |
| 1 既知障害 | 正規Draft→questions→refine→coverageのsave／reload後、実CLIを`after=null`から最終ページまで取得。最新回帰testの同じ選択を基準sourceの隔離コピーへ向けるとcheckpointで`PRODUCER_NOT_SUPPORTED`となる。`frozen-baseline.log`、`query-draft-final-extra.log`。 |
| 2 実行と評価 | 両routeの未publication checkpoint／claimed、publicationで中断した状態、reload後terminalを検証。実行記録は0件・not-applicable、publicationとterminalは同じID／JSON。`query-draft-final.log`の該当2件。 |
| 3 保存意味 | PASS、ADVISORY、REJECTED、blocking／advisory／repairTargetsの本文・件数・出典・pointer・IDを正規producer経由で検証。内部値は公開しない。`query-draft-final-extra.log`、`producer-observation-shape-final.log`。 |
| 4 履歴とbinding | 再レビューの全ledger、旧Attemptと最新descriptorのowner差、exact target／generation／manifest／input／claim、publication欠落・曖昧・terminal Result矛盾、保存payload／command resultの改変を検証。`query-draft-reopen-full-ledger.log`、`query-draft-review-binding-final.log`、`query-draft-final.log`。 |
| 5 全件性とclosure | metadata／全ページのsnapshot一致、合計件数・重複なし、同IDのJSON一致、referenceBindings、filter外producer閉包、coverage／completenessを検証。時刻のない正規ReviewをrecordedAtで除外し、時刻境界は既存query testsで検証。`query-draft-final-extra.log`、`query-draft-reopen-full-ledger.log`、`query-regression.log`。 |
| 6 producer接続 | Draft publication／Review／Gate→Spec Reviewまでの全履歴は実CLI先頭取得成功。Spec Triage／Repair後は旧Review generationが保持されず、全履歴取得は明示拒否。最新Repairの保存auditは取得成功。受入解釈についてユーザー回答待ちであり、達成とは扱わない。 |
| 7 失敗を隠さない | 保存済み内部型・意味の不正、参照、truncation、欠落・破損・hash／size、snapshot、response上限は新規および既存query testsで拒否を確認。正規scenarioではcanonical state／ledger／catalogを取得前後とreload後で比較。`query-draft-final.log`、`query-regression.log`。 |

## 実測したテスト

ログ名はすべてworktree内`.tmp/f0c5/`を基準とする。実行対象が重複するため件数は合算しない。

| 実行対象 | 結果 | ログ |
| --- | --- | --- |
| 既存queryのunit／integration 6ファイル | 113 pass、fail／skip 0 | `query-regression.log` |
| Draft／Spec専用工程シナリオ | 14 pass、fail／skip 0 | `phase-scenarios.log` |
| 最終共有API／Result／binding／query-details 6ファイル | 92 pass、fail／skip 0 | `final-api-checks.log` |
| 新Draft observation unit | 28 pass、fail／skip 0 | `producer-observation-shape-final.log` |
| 最終Draft binding境界 | 16 pass、fail／skip 0。run／spec／Step／Attempt／sequenceの外側binding差と意味参照つきcheckpointを含む | `query-draft-review-binding-final.log` |
| 新producer integration | 7ケースの成功を確認。最初の全7件実行は6 pass／1 fixture失敗。その合法性を確認して新fixtureを訂正し、該当caseと追加assertを含む3件を再実行して3 pass | `query-draft-final.log`、`query-draft-final-extra.log` |
| 再レビュー全ledgerの追加assert | 1 pass | `query-draft-reopen-full-ledger.log` |
| 最新APIを読む既存admission-refusal test | `.current`回帰で1 fail→同じ既存testで1 pass | `history-current-review.log`、`history-current-consumer-fixed.log` |
| 基準source上の同入力CLI回帰test | 期待した既知障害1 fail（fixture／import／timeout失敗ではない） | `frozen-baseline.log` |
| publication identityの基準／修正後比較 | 同一digest | `publication-digest-comparison.log` |

新cross-phase fixtureの最初の失敗は、`invalid` dispositionに許可targetを渡した
不正なworker応答をproducerが拒否したもの。protocolを確認してfixtureを訂正した。
正当な既存テストの期待値、skip、timeoutは変更していない。

publication identity比較のdigestは両方とも
`5cce6155988835ce2a433243baf6eb522e26fc03582864176969cd3217c41623`。
Storeのpure処理を抽出したもので、保存digestの規則は変えていない。

## AI実行の別記録

`npm run test:agent`は10 pass／1 fail／2 cancelled／1既存opt-in skipでexit 1。
全体成功とは扱わない（`agent-tests.log`）。
取消2件は親suiteの480秒上限であり、同じ2件を個別選択すると2 passとなった
（`agent-cancelled-targets.log`）。
Draft Gate repairの失敗は`STEP_RESULT_ERROR_PERSISTENCE_FAILED`、coverage repairの
stale revision／missing target拒否である。基準sourceの隔離コピーでは単独1 pass
（`agent-base-gate.log`）、修正後も同じtestの単独実行は1 pass
（`agent-current-gate.log`）。両方のsynthetic保存結果は
`agent-base-gate-evidence.json`／`agent-current-gate-evidence.json`に保持した。
real agentの入力・出力は非決定的なので、単独成功から初回失敗の原因を断定しない。

## Spec generationの受入判断

正規`SpecSettlementWriter`のTriage／Repairは同じrevisionの`spec.review`を上書きし、
以前のpublication generationの本文を保持しない。queryはgeneration完全一致を
要求するため、その後の先頭取得は`DETAIL_UNAVAILABLE /
SOURCE_GENERATION_NOT_RETAINED`となる。空の成功履歴へ変更していない。

ボードは保存形式／producer変更、未保持情報の補作を非スコープとする一方、条件6は
Repair後を含む先頭取得を求める。既存保存を維持した明示拒否の検証を受入とするか、
今後のSpec generation保持を追加実装するか、ユーザーに確認している。
回答前に保存契約や受入条件を変更しない。

## 再検証方法と引継ぎ

作業worktreeで必要な対象だけを実行し、出力をログへ保存する。

```sh
node --test tests/unit/canonical-draft-review-observation.test.js tests/integration/flow/query-draft-review-binding.test.js tests/integration/flow/query-draft-review-producer.test.js > /tmp/f0c5-query.log 2>&1
node --test tests/integration/flow-cli/draft-artifact-scenario.test.js tests/integration/flow-cli/spec-artifact-scenario.test.js > /tmp/f0c5-phases.log 2>&1
```

実CLI testはtest専用sourceコピーを固定し、同時source編集がsnapshot signatureを
変えてしまう影響を排除する。canonical保存は正規API、CLIはコピーした実entrypointを使う。
基準比較コピーにはGit metadata、実Flow、元checkoutへの書込み先を含めていない。

独立レビューは`.tmp/f0c5/implementation-review.md`、実測集計は
`.tmp/f0c5/acceptance.json`。最終source／test／logのhashと、基準比較の
選択testが同一である証跡は`.tmp/f0c5/final-evidence-manifest.json`。
基準比較のtest本文は`.tmp/f0c5/frozen-query-regression.test.txt`に保持し、
再作成可能な基準sourceコピーと作業用scriptは片付けた。公開仕様の説明は
`docs/design/flow-query-revision-2/README.md`に反映した。
docs freshnessはstaleで、docs buildを提案済み。生成docs全体の最新性は保証していない。
Flow開始／再開、commit、merge、push、ボード変更は行っていない。
worktreeは差分と証跡のレビュー用に残す。

最終判定は未完了。条件1〜5・7の検証は完了し、独立レビューに残る
実装上の指摘はないが、条件6の受入と保存非スコープの矛盾は未解決である。
