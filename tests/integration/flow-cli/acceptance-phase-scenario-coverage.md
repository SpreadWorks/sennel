# d538: 受け入れ・報告フェーズの先行テスト

対象は `retro`、`acceptance-review`、`acceptance-decision`、`final-regression`、
`report` の5責任leaf。親指針は67fd、共通検査はfc21、後続の製品移行は6af5。
本成果物はテスト契約と未達検出を所有し、製品移行の合格を意味しない。

開始ブランチは `main`、開始commitは
`f7264f38e79714c4e85fdbb778aa83df10ecc5d0`。
作業ブランチは `codex/d538`、worktreeは `.sennel/worktree/d538`。
ボード本文の取得結果は `.tmp/d538/board.json`、親・共通指針の取得結果も
同ディレクトリに保存する。古いボードの参照HEADを現行実装の事実に代用しない。

## 到達点と責任

正規producerが生成した証拠をcanonical Storeへ保存し、managerを破棄して
読み戻した実consumerが判断する経路を固定する。構造checkerのfixtureは
検査力の証明にのみ使い、本番登録・実DI・工程実行の代替にしない。

正常な05引き継ぎから逆算すると、reportの採用とbinding、最終回帰の正規証拠、
Acceptanceの全Requirement/finding被覆または明示判断、Retroの現在の集計、
03のTestChain/Review/Gate、SpecとRequirementTestの正規publicationが必要となる。
拒否・保留・修復・中断はこの依存関係の個別の境界として検証する。

| 保証する結果 | 条件・正規producer・保存と読戻し | consumerとケース |
| --- | --- | --- |
| 正常な05引き継ぎ | Draft/Spec/RequirementTest、03の実worker・test-execute・結果Review・Impl Review/Gate、Retro、Acceptance、最終回帰、reportを実経路で生成。各descriptorのActivity/Attempt、fingerprint、catalog hashを読み戻す | A01。artifactless decision no-opのsource receipt、実finalize-commit admissionを含む |
| 修復後の再受け入れ | 実Acceptance findingをimpl-triageへ渡し、impl-repairのsource mutationを採用。選択されたreset範囲と新TestChain/Review/Gate/Retroを確認 | A02。旧履歴の保持、新producer Activity・fingerprint、finding keyと実worker入力を確認 |
| 正規Spec変更後の再評価 | 認可されたreopen-draft/spec-correction、版付き質問への回答、Spec/RequirementTest/03証拠の再生成。旧Report/decision/明示FAIL受容を新publicationへ流用しない | A03。実decision-facts consumerとfinal-evidence consumerが古い証拠を拒否。Acceptance→Spec直行routeを補作しない |
| previewの副作用ゼロと通常のstale rewind | Gate後のsource driftを正規Retro consumerで観測。previewではcanonical state/catalog/Activity/Attempt/receiptと外部call数が不変。通常実行では新test-execute Attemptで証拠を再生成 | A04 current/stale preview、通常rewind。現行dry-run違反の初期検出を分離 |
| tokenlessの明示risk判断・park | 正規Acceptance provider応答から意味上の未検証事項を採用。autoApprove両値でAwaitを維持し、既存set commandから受容/abort | A05。decisionのreview digest/Attempt/fingerprint、issue.log、park後の作業root保持を確認 |
| 証拠不足・不正・失敗の安全な拒否と新世代 | 正規保存済み証拠の読取り障害、不正入力、実TestChain失敗を区別。同一根拠の繰返しはprovider call=0。新Spec/producer publicationから再評価 | A05。境界拒否を架空のStep Errorに変換しない。歴史的missing-producer回復を流用しない |
| 最終回帰FAILの明示受容がReportまで残る | 実プロジェクトcommandがtyped child process証拠を出力。Definition認可のrepair上限と選択済みuser Actionを経て、最新の失敗execution bindingを受容 | A06。provider/processの再実行なし、FAIL・残存risk・元のraw証拠をreportの実入力へ結ぶ |
| 報告配信・中断・再開 | linked Issueへ送信する前にpending report/outboxを保存。同keyのremote確認、pending/failed/done、保存前失敗と保存後応答喪失を区別 | A07。remote responseのみfake。canonical保存・error hook・recovery・ReportBinding・実commit consumerは本番 |
| 構造境界・本番実DI | 04 manifestと本番acceptanceStepRegistrationsを双方向照合。全5 create、PreparedStep.dependencies、型付きconstructor引数を検査 | acceptance-phase.test.js、acceptance-phase-service-boundary-coverage.test.js。A01〜A12の単独違反と除去後成功 |
| 全Result kindと保存後の同じSettlement | 単一STEP_RESULT_REGISTRYのclass/kind/type/stepId、既存StepErrorResult、Result-only Definition選択、receiptとproducerの対応 | scenario entry末尾の23 kind検査と各実シナリオのassertResults。未来moduleのimport失敗を初期redに数えない |

## 共通APIの再利用

- `ImplPhaseScenario` / `RequirementTestPhaseScenario` を継承し、外部応答だけを
  制御する。実dispatch、登録CLI、Definition、内部consumer、Storeを置換しない。
- `SeedWorkRoot` は実producerが生成した不変のfrontierを個別rootへコピーする。
  canonical snapshotの完全一致を確認し、absolute pathや版をpatchして通さない。
- `ProductionRegistrations` の既存責任内へ `PhaseProductionRegistrations` を
  抽出し、02/03/04の同じadmissionを共有する。
- 既存 `StagedExecutionSeed`、checker、source reader、ServiceBoundaryCoverage、
  PublicationObserver、Result assertionを共有する。checkerのコピー、個別allowlist、
  第2registry、違反baseline、skipは追加しない。
- 04 assembly adapterのnamed select/project/executeは同一登録・selectionの
  消費を固定する検査宣言である。既存APIが持つroute、NonGate予算、TestChainの
  判断を別名で再実装する指示ではない。preview契約は既存retro/reportだけに限る。

最終回帰の分類・件数解析・遷移の判断表は、固定済みの既存回帰を再利用する。
新シナリオでは保存済みartifactを `validateFinalRegressionEvidence` へ渡し、
実processのstarted/exit、rawログ・stream・件数、repository bindingの接続を確認する。
機械的保留では旧Awaitのexact receiptを元のAttemptで認証し、新Attemptへの流用を
既存receipt validatorで拒否する。新provider呼出し前のclaim、input digestと
Attempt/sequence/execution generationの組、旧receipt/Activity/journalの保持を確認し、
未定義のlineageフィールドや独自の世代認可APIを補作しない。

04 scopeのregistry snapshotは存在する先行phaseを含み、04を必須、05を対象外とする。
先行phaseの欠損検出はそれぞれの固定suiteも実行して担保する。
同じServiceでも代表1leafで代用せず、all-five実DIはrisk判断を明示受容する正規経路で
acceptance-decision自身も準備する。PASS時のartifactless no-opはA01で別に扱う。

## 固定した実行集合

工程専用コマンド:

```sh
node --test tests/structure/acceptance-phase.test.js
node --test tests/integration/flow/acceptance-phase-service-boundary-coverage.test.js tests/integration/flow-cli/acceptance-phase-scenario.test.js
```

scenario entryは `acceptance-phase-finalization.contract.js` を読み込み、A04/A06/A07も
同じ指定コマンドで実行する。`.contract.js` は別の製品実装・別registryではない。

ボード指定の既存回帰:

```sh
node --test tests/integration/flow/run-retro-no-missing-requirements.test.js tests/integration/flow/run-acceptance-review-source.test.js tests/integration/flow/definition-route-ownership.test.js tests/integration/flow/final-regression-transition-definition.test.js tests/integration/flow/final-regression-record-and-proceed.test.js tests/integration/flow/final-regression-terminal-replay.test.js tests/integration/flow/run-report-show.test.js
```

この7ファイルに加え、既存のprocess/最終回帰分類・outbox・runtime・Result/receipt、
Draft/Specと01〜03の構造・実DI・シナリオを先に
`.tmp/d538/frozen-tests.json` に固定する。構造集合と未来05の初期redを混ぜない。
長時間実行は1回のログを保存して読み、失敗・関連変更・未確認の懸念がある場合だけ
影響集合を再実行する。

## 測定と判定

実行ログ、revision/diff hash、ケース別結果、未達と不正fixtureの区別は
`.tmp/d538/` に保存する。最終候補の測定結果はこの節へ追記する。
初期のsetup調査、修正前の不正なCLI指定、途中で止めた試験を合格や契約検出へ合算しない。

製品コードは変更しない。現行未達を正当なテスト失敗として6af5へ引き継ぐ。
テスト作成の完了と製品移行の受け入れを分け、正しい期待値を弱めて緑にしない。
実OS crash、任意の外部processの全面rollback、GitHubとStoreの単一transaction、
未保存provider batch応答の自動復旧は保証しない。

### 確認済みの既存回帰と基準比較

- 02/03の構造・全leaf実DI・共通loader/checker回帰7ファイル：230/230成功、
  fail/cancel/skip 0。`.tmp/d538/structure-di-regression-cases.json` にケース別結果を保存。
- Draft/Spec/準備とproduction contract/Service境界の構造回帰5ファイル：17/17成功、
  fail/cancel/skip 0。`.tmp/d538/prior-structure-regression.log`。
- 実producerが保存した17個の03 Resultをfresh managerで読み、抽出後の共通
  Settlement roundtrip assertionで検証：成功。
  `.tmp/d538/restored-phase-settlement-regression.log`。
- Draft/Spec/Requirement Test/Implの工程専用シナリオ、準備実DI、Impl Resultの
  回帰6ファイル：229/229成功、fail/cancel/skip 0。
  `.tmp/d538/prior-phase-scenario-regression.log` と `.cases.json`。
- ボード指定回帰を含むruntime/最終回帰/Result集合16ファイル：295件中213成功、
  75失敗、7キャンセル、skip 0。`.tmp/d538/legacy-and-runtime-regression.log`。
  失敗とキャンセルの82ケースを開始commitのdetached checkoutで同じ入力・assertionで
  比較した結果も75失敗・7キャンセルとなり、ケース名・code・最初の理由の差は0。
  `.tmp/d538/baseline-failure-comparison.json` / `.log` を参照。
  この既存失敗を04の初期redや新しい回帰へ合算しない。旧fixtureが現在必須の
  atomic Result/receiptを伴わず状態を進めるなど、対象動作より前で拒否されるケースを
  既存回帰の未達として保持する。期待値変更やskipで隠していない。
- `npm run test:structure` の全体集計：740件中734成功、6失敗、cancel/skip 0。
  6件は04のproduction composition/登録欠損だけであり、未導入04を含む全体集計と
  先行phaseの受け入れ集合を分ける。`.tmp/d538/structure-aggregate.log`。

### 04の測定と初期失敗

| 実行集合 | 測定結果 | 証跡 |
| --- | --- | --- |
| 04構造＋実DI | 76件、59成功・17失敗、cancel/skip 0。構造6件と実DI11件は本番composition/登録欠損を検出 | `acceptance-structure-di-final.log` / `.cases.json` |
| ボード指定実DI＋全シナリオの最終候補 | 64件、12成功・52失敗、cancel/skip 0。後述の不正fixture2件を契約検出に数えない | `acceptance-phase-final-audit.log` / `.cases.json`、`final-candidate-revision.json` |
| 追加assert・fixture補正後のA01/A05/A06 | 3件すべて意味のある初期失敗、cancel/skip 0 | `acceptance-focused-assertions-audit.log` / `.cases.json`、`focused-run-revision.json` |
| fixture補正後のA03 | 1件、意味のある初期失敗、cancel/skip 0 | `acceptance-a03-corrected-audit.log` / `.cases.json` |
| 実PASS artifactと共有validatorの接続 | 実producerのPASS、testCount 1、rawEvidence verified | `final-evidence-validator-narrow.log` |

証跡名はすべて `.tmp/d538/` からの相対名。
全候補のA06は明示FAIL受容後のreport Attempt claimを欠いていたため補正した。
A03はunknown FAILの明示受容を前提にしていたが、既存Definitionが安全にblockedへ
進める契約だったため、実current-change FAILと修復上限後の選択済み受容へ補正した。
補正は妥当な期待値を緩める変更ではなく、正規producer/Action経路の修正である。
親testをdescribeに移し、工程seedをbefore/afterで所有することで、追加assertの対象だけを
Nodeの名前指定で検証できるようにした。誤った親名指定で全子を選んだ中断実行と、
補正前のsetup失敗は検証結果へ合算しない。部分実行を現在revisionの全体合格として
扱わず、最終revision・差分・実行別の範囲を `verification-summary.json` に残す。

| 検出した契約不足 | 正規経路と最初の失敗 |
| --- | --- |
| 本番登録・Result/Settlement | 全5leafのcomposition/createが欠損。単一registryの23 kindとResult-only selectorも未導入 |
| Artifactless no-op | 実Acceptance PASS後のdecision完了に、source-step-settlement receipt参照がない（A01） |
| 修復後の再読取り | 実Acceptance finding→triage→source repair後、03が旧current producerと新publicationの不一致で停止（A02） |
| 受容FAILの引き継ぎ | 実2回のcurrent-change FAILとDefinition選択済み受容を保存した後、reportの実consumerがmatching confirmed producer Activity欠損を検出（A03/A06） |
| Retro preview・保存 | stale dry-runがcanonicalを巻き戻す。通常rewindは新test/Reviewを生成するがRetroのtyped Result/receiptがない（A04） |
| Risk判断・機械的保留 | tokenlessの明示受容/abortは保存されるがtyped Resultがない。正規unavailable Reviewからのblocked publicationにexact Await receiptがない（A05） |
| Provider中断 | 実分割計画で2回目のproviderを中断。初回の実呼出し前にdurable execution claimがない（A05） |
| Report配信・再開 | pending保存・remote確認・重複防止後のtyped Result不足、保存後応答喪失の完了済みexact receipt読戻し未対応、pending previewのremote呼出し（A07） |

成功した独立境界はcurrent Retro preview、unlinked report preview、保存前faultの
canonical不変性、実finalize-commitのstale source拒否、物理的missing/invalid証拠5件の
providerゼロ・正本不変・正確な復元、実FAILを保持するTestChainの直接Acceptance拒否。
これらと先行phaseの合格を、04製品移行の合格に読み替えない。

### 未到達のassertと引き継ぎ

初期失敗の後のassertは保持しているが、次は現在の製品では未到達である。

- A01のno-op receipt以降の正常な全工程・05 admissionの完了保証。
- A02の03再読取り以降の新Acceptance、旧履歴・新finding/fingerprintの後続保証。
- A03のaccepted FAIL→report以降の認可済みSpec再生成と旧質問/decision/FAIL受容/report拒否。
- 機械的保留のexact Await以降の新世代claim、旧Await流用拒否と履歴保持。
- 中断providerのclaim以降の保存後のsafe hold・自動再開拒否。
- A06のaccepted FAIL report本文、A07のexact receipt以降のreplay。

これらはテスト契約の固定であり、現在実測した製品保証ではない。6af5の製品移行では
冒頭の工程専用コマンドを全体実行し、初期失敗と後続assertの両方を解消する。
既存runtime fixtureの基準失敗82件と、未導入05の構造検査を別に管理する。
実GitHub接続、実AI、OS crash、未保存memory-only batchの再開は本検証の範囲外である。

### 完了済みreceiptの読取り補正（2026-10-09）

A07の保存後応答喪失とreplay後の2読取りは、既存APIの`completed: true`を明示する。
active Attempt用のデフォルト読取りが`null`を返すことを、receipt保存不足の証拠にしない。
正規03 producerの限定確認では、保存済みtest-executeをデフォルトでは取得できず、
completed指定では同じproducer Activityに束縛されたreceiptを取得できた。
provider中のclaimと機械的保留中の読取りはactive Attemptに属するため変更しない。
補正後のA07単独実行・変更差分・読取り区分は
`.tmp/d538-receipt-correction-verification.json` に記録する。
