# 0717 最終化フェーズの先行テストと検証

対象は `finalize-commit`、`finalize-merge`、`finalize-sync`、
`finalize-cleanup` の4責任leafと、その保存・再開・最終consumerへの接続。
取得した最新本文は [finalization-phase-board-source.md](finalization-phase-board-source.md)。
親指針 `67fd`、共通検査 `fc21`、後続実装 `5ab3` の取得結果を
`.tmp/0717/parent-board.json`、`shared-board.json`、`product-board.json` に保存した。

作業ブランチは `codex/0717`、worktreeは `.sennel/worktree/0717`。
開始ブランチは `main`、開始commitは
`96a78e9dc04580a3032aae6ca76a1491ced6810a`。
元checkoutの未コミット変更は引き継がず、実装・検証はこのworktreeと
検証専用の独立一時リポジトリで行う。

## 到達点と受け入れ単位

0717はテスト契約の先行固定と、意味のある初期redの記録を所有する。
親指針と5ab3の本文では、製品移行と全4工程のgreen受け入れを5ab3が所有する。
0717の本文にあるgreen条件はその後続実装の合格条件として保持し、
製品未移行をskip、弱い期待値、仮のStepやServiceで通さない。
今回の依頼はテスト実装と実際の検証を指示しているため、本文の
「設計作成ではテストを実行しない」という記述を今回の検証禁止として扱わない。
製品変更、実作業のFlow開始、ボード変更、commit、merge、push、Issue公開は含めない。

docs freshnessは作業開始時に `stale`。`sennel docs build` を提案し、
現行ソースを根拠に確認した。生成docsの更新は本テスト変更の対象外。

## 要求と検証経路

| 結果 | 必要条件・正規producer・保存と読戻し | 実consumerとassert |
| --- | --- | --- |
| F01 正常完了と最終報告 | 正規Draft/Spec/Requirement Test/Implementation/Acceptance/最終回帰/Report。実Git commit、squash、main docs同期、cleanup。各境界でmanagerを作り直す | outbox key、receipt、report producer/source binding、target Spec/docs限定completion commit、current解除、last-finalized catalog、実report-show/status |
| F02 範囲・no-change・承認 | 正規Reportを生成し、実装dirty、Spec/docs、無関係index、既存実装commitを実Gitで作る。manual approvalは実dispatcherのAction/tokenに束縛 | 実commitのtree/indexと次merge。source/approval driftは効果前拒否。Acceptanceのrisk判断をcommit承認へ流用しない |
| F03 merge戦略とPR待機 | 正規direct/branch実行、実local squash、独立したlocal Git peerと外部gh応答。送信前pending/claimと応答喪失後の同key remote確認 | policy skip、PR receiptのAwait、PR重複公開なし、merge後のsync/cleanup自動起動なし |
| F04 conflictと復旧 | 実Gitで競合・branch drift・busy ownerを作る。正規Definition選択のexact/pre-sync recoveryとmain authority | 下流skipと認可済みpending reset、sync admission、拒否時のcanonical/Git入力保持。未知dirtyを所有metadataへ分類しない |
| F05 sync警告と中断 | 外部docs processの成功/失敗、実Git diff障害、実RuntimeLogBlockWriterのincomplete receipt、pending outbox、repository operation ownership | stdout/stderr/元phaseの保持、警告付きcleanup、read-only next-action、busy/foreign runtime拒否、正規recoveryによるskip |
| F06 保存・外部効果の断点 | 実commit/merge marker、PR公開、docs観測、canonical保存の前後。元ctxを再利用せずfresh managerから再構築 | 保存失敗と外部成功を分離し、現実のmarker/ref/PR/journalを照合。確定済みActivity/commit/PRを重複させない |
| F07 teardownと完了後不変性 | 実post-squash orphan、ref lock、force audit保存失敗、auto-rescue、実prepareが作った管理worktreeとbinding、全6journal phase | audit失敗の破壊操作0、独立facts保持、expected-ref publication、main writer、worktree削除後の保存、last pointer、exact replayのみ許可、新Activity拒否 |
| 構造・本番実DI | 既存05 manifestの固定4leafと本番finalizationStepRegistrations。正規producer frontierから各createを準備 | A01〜A12、entry/登録双方向、private Service、argumentTypes、direct/project/dispatch/recovery、単独違反の位置・依存経路・除去後成功 |
| ResultとSettlement | 単一STEP_RESULT_REGISTRY、14正常/分岐kind＋4共通Error kind、保存ResultのみのDefinition API | 全18kindのclass/type、復元、Execution/target/Await/Failure/Completionと3Connectorの厳密対応。合成fixtureの成功で本番登録を代用しない |

F01〜F06は `finalization-phase-scenario.test.js` と
`finalization-phase-recovery.contract.js`、F07は
`finalization-phase-cleanup.contract.js` と
`finalization-phase-worktree.contract.js` に対応する。
`.contract.js`は同じシナリオentryから登録されるテストであり、
別の製品実装、runner方針、保存正本ではない。

## 再利用と必要な共通拡張

- 構造検査は既存 `PhaseProductionRegistrations`、05 manifest、
  `StructureChecker`、source reader、A01〜A12、named execution shapeを使う。
  finalizeディレクトリとfinalization compositionの名前が異なるため、
  `NamedPhaseExecutionSeed`が既存base compositionから対応するsourceを
  取り出せるようにした。検査規則や個別allowlistは追加しない。
- 実DIは `PrepareExecutionObserver`、`ServiceBoundaryCoverage`、
  `PreparedStep`、`StagedExecutionSeed`を再利用する。代表1leafやService型数だけで
  全4leafの準備を合格にしない。実行前の表示用createも実行DIの証拠に数えない。
- Report producerは既存 `AcceptancePhaseScenario`、管理worktree producerは
  `PrepareArtifactScenario`を再利用する。既存dispatch fixtureへ
  `mainRoot`、`inWorktree`、`config`の取得済み入力を渡せるようにし、
  元のdirect/branch defaultを維持する。dispatcherの方針はコピーしない。
- Resultのclass/registry/serialization検査は `ImplPhaseResultContract`、
  復元とSettlementの共通検査は `assertPhaseSettlementRoundtrip` を使う。
  最終化固有の期待値クラスは厳密なkind/target/Connectorの検査を所有する。
  第2の製品Result registryやError classは作らない。
- canonical faultは既存Version Storeのfault injectorを使う。
  journal断点のobserverは、正規 `AtomicJsonFile.write` を実行して保存された
  bytesを確認した後、一度だけ応答喪失を起こす。journalの値やGit/Store結果を
  作り替えない。これは保存後のreadback検証であり、OS crashの証明ではない。
- Gitは独立した実リポジトリで実行する。gh/provider/docs processの外部応答だけを
  fakeにする。worktreeのoriginは検証所有のlocal bare repositoryであり、
  外部サービスへの書込みは発生しない。

## 固定した検証集合

各実行のファイル一覧は `.tmp/0717/frozen-tests.json`。
既存の判断単位のテストをシナリオへ複製せず、保存境界と実consumerへの接続を追加する。

```sh
node --test tests/structure/finalization-phase.test.js
node --test tests/integration/flow/finalization-phase-service-boundary-coverage.test.js tests/integration/flow-cli/finalization-phase-scenario.test.js
node --test tests/integration/flow/finalization-phase-result-contract.test.js
node --test tests/integration/flow/finalize-completion-boundary.test.js tests/integration/flow/finalize-merge-transaction.test.js tests/integration/flow/finalize-merge-retry.test.js tests/integration/flow/finalize-cleanup-robustness.test.js tests/integration/flow/finalized-flow-immutability.test.js tests/integration/flow/run-report-show.test.js
npm run test:structure
```

上記は0717の測定時に固定した集合である。ff4aで旧merge-retry／cleanup-robustness
の保証を工程専用シナリオへ統合した。現在の対応、実行コマンド、受入判断は
[ff4aの統合証跡](ff4a-regression-consolidation.md)を参照する。

追加集合はruntime/recovery 9ファイル、Result/receipt/canonical 9ファイル、
導入済み全フェーズ実DI 7ファイル、工程専用シナリオ7ファイル、
共通checker 3ファイル。全repositoryや実AIの一律実行は行わない。
長時間実行は一度ログに保存する。候補変更後は影響集合を再実行し、
途中結果を最終候補の全体合格へ合算しない。

## 測定の区別

ログとケース別JSON、最終source/test digest、dirty差分、基準比較を `.tmp/0717/` に保存する。
途中の不正fixture、syntax/import/setup失敗、終了前の実行は初期契約違反に数えない。
先に失敗したassertによって後段が未到達の場合は、後段の保証を成功したと報告しない。
既存回帰の失敗と05の追加契約の未達を分ける。

現在の合法direct実行は `featureBranch = null` を要求する一方、
既存merge strategyのskipはfeatureとbaseの一致を条件にしている。
direct fixtureへ不正なfeature名を埋めることでskipを作らず、正規producerが保存した
direct authorityから実consumerへ渡した結果を、後続5ab3への未達として記録する。

最終候補の測定結果と受け入れ監査を以下へ追記する。

## 最終候補の測定と受け入れ監査

0717の成果物は全4leafの構造・実DI・Result/SettlementとF01〜F07の
テスト契約、および意味のある初期redの証跡である。親67fdが区別する
「テスト契約の作成完了」と「05製品のgreen受け入れ」を混同しない。
製品移行とgreen受け入れは5ab3に残る。今回のsourceは開始HEAD
`96a78e9dc04580a3032aae6ca76a1491ced6810a`から変更していない。

最終候補は無条件の3ファイル集合を完走した。実行は既存
`TestTemporaryRoot.createOnTmpfs() ?? TestTemporaryRoot.createOnSystem()`で作り、
`use()`で隔離して子Nodeへ環境を継承した。今回の実storageはprocess記録のtmpfsである。
実コマンドとexit/signal/経過時間は
`.tmp/0717/final-phase-resumed-process.json`、全stdout/stderrは
`.tmp/0717/final-phase-resumed.log`、元TAP行番号・全診断・ケース別分類は
`.tmp/0717/final-outcomes-classification.json`に保存した。
142 tests、66 pass、76 fail、cancelled/skipped/todoは0、exit codeは1、signalはnull。
76件は未移行契約・実際の拒否/回復不足・正規producerの前提不足に分類した。
新規候補のsyntax/import/TypeError/不可能なfixture/APIセットアップ失敗は0である。
初期redをskipやbaselineで隠していない。

| 検証集合 | terminal測定 | 判定・証跡 |
| --- | --- | --- |
| 最終05実DI＋シナリオ＋Resultの3ファイル | 142 / 66 pass / 76 fail、exit 1 | 最終候補の単一完走。初期redとmaskをケース別に分類 |
| 05構造 | 88 / 83 pass / 5 fail | 本番finalization composition欠損。独立fixtureの成功を本番適合へ数えない |
| 全structure | 937 / 932 pass / 5 fail | 上記と同じ5件。05構造件数との単純合算はしない |
| 共通Result/receipt/canonical runtime | 240 / 240 pass | terminal TAPを実測。元schedulerを停止していたためexitは未回収、0の推定と区別 |
| 導入済みフェーズ実DI | 70 / 70 pass、exit 0 | `priorDI.log`、`prior-regression-processes.json` |
| 導入済み工程シナリオ7ファイル | 272 / 272 pass、exit 0 | `priorScenarios-resumed.log`と対応process/cases証跡 |
| publication observerのDraft正例 | 1 / 1 pass | authority入力拡張の既存consumerを検証 |
| 指定既存最終化回帰6ファイル | 42 / 26 pass / 16 fail | detached基準commitと同一ケース名/codeの失敗。`baseline-comparison.json` |
| 共通checker3ファイル | 19 / 17 pass / 2 fail | module-isolation失敗2件はdetached基準と同一 |
| runtime/recovery9ファイル | 100 / 94 pass / 6 fail | 既存get-next-actionの不正fixture。05初期redへ数えない。基準比較は未測定；変更していないsource/当該fixtureから既存由来と推定 |

各集合のファイル一覧は`.tmp/0717/frozen-tests.json`に固定した。
重複するResultや構造ケースを合算して全体greenとは報告しない。
広い実AI/repository全量実行は行っていない。AI実行コードや製品codeを変更していない。

### 到達した保証と未到達の保証

| 結果 | 最終候補で実測した境界 | 未達・mask |
| --- | --- | --- |
| F01 正常完了/consumer | 実commit・squash・docs・cleanup、同key outbox、reload後のfinalized/current解除、last pointer、実catalog/status/report-show、target Spec/docs限定commitとruntime除外 | 最後の専用StepResult/receiptがない。正常case全体はred |
| F02 範囲/no-change/承認 | sourceを先に作った正規Report/回帰がcurrentであること、stale tokenとsource drift拒否、正規承認後の実commit。Spec/docs除外は成功 | unrelated indexが実commitへ混入。合法no-changeはERROR exit1。後段のindex/HEAD/route/receiptassertは最初の失敗でmask |
| F03 戦略/PR Await | 無選択3commandの拒否とcanonical/Git不変、実local Git peerへのpushと外部gh応答、同key PR確認 | PR Awaitがfinalize-syncを公開。foreign PRのexact-key拒否不足。合法directはcommitで停止しmerge skip未到達 |
| F04 拒否/回復 | dirty拒否ではcanonical/Git不変。busy ownerは実lockで拒否するがbegin/fail outbox・suffix skip・auditを追加。実squash conflictのfailed outboxと同じheld Attempt/in_progress、suffix skip | 未修復add/add conflictのexact recoveryを許す。修復後retry/pending resetはmask。managed pre-syncはTask Gate source authorityで停止 |
| F05 警告/中断 | 実incomplete runtime receipt、read-only取得、foreign runtime拒否、lockを経た正規skip、unchanged docsの一回観測/HEAD維持/cleanup route | build/diff failureの正規audit診断が欠損し、警告consumer後段はmask。専用警告Result/receipt欠損 |
| F06 外部効果/保存断点 | 実marker/ref/書込みfault、fresh managerでpending・同marker再開・Git重複なし。mergeは初回postの同key doneまで到達 | 同じ応答の2回目registered postをFINALIZATION_ACTION_CLAIM_REQUIREDで拒否。これは任意raw result回復の証明ではない。後段の無重複/専用receiptassertはmask。各leaf Execution Resultも欠損 |
| F07 teardown/不変性 | cleanな実Git checkpointがcanonical/report bytesを変えないこと、force auditの実保存faultでteardown 0、独立facts保持とforce retry、orphan/unknown dirty拒否、完了後のexact Activity replayと新note/metric/逆policy拒否 | 自分のclaim/pending metadataをauto-rescueがdirty拒否し、実CAS/救済完了をmask。unobservable indexを拒否しない。managed全6journal phase/owner/main writerはF00前提でmask。最終専用receipt欠損 |

構造5件、実DI9件、単一registryの18 kindとResult-only Definition APIは
製品未移行を直接検出する。合成fixtureとchecker正例の成功は、欠けている
本番登録・4leaf実準備・private typed Serviceの実測を代用しない。
Result型・target/Execution/Await/Failure/Completion・3Connectorの要求を保持する。

F00では実Prepare producerのTask Gateが同じlineageを
execution worktreeではpresent、publication mainではdeletedとして読み、
異なるsource fingerprintになることを取得stackとともに実測した。
これによりmanagedのF04/F06/F07の未到達理由を示した。main側へsourceをコピーしたり、
保存evidenceを書き換えて後段を通したりしていない。

directのnull featureに対するpreflight、add/add conflictのmerge-tree判定、
registered postの既存done outboxより早いactive-claim検査という原因説明は、
現行sourceに基づく推定である。失敗した具体的なassert/exceptionを実測として記録し、
推定を実測原因へ格上げしない。OS crash、remote service全体の原子性、
任意dirtyの救済、未承認のpost-merge orchestrationは証明していない。

### 候補固定と中断の扱い

ユーザーによるpauseと環境再起動で旧12565/72694のプロセスが消失した。
旧logは`.interrupted.log`と中断metadataへ保存し、terminal resultと扱わない。
ユーザーの明示resume後、実プロセスがいないこととsource/testの一致を確認して、
残る最終unionと既存シナリオ集合だけを新しいlogへ各1回再開した。
中断や開発用部分実行の成功を最終142件へ加算していない。
旧`final-phase.log`、`fixture-corrections-r2.log`等は修正前fixtureの調査用証跡である。

`resumed-run-before.json`と`resumed-run-after.json`は同一source、test inputs、
all tests、changed files digestであり、17変更/追加JSのsyntaxとdiff checkも成功。
hash方式はsorted `{path, sha256}` recordsのJSONをSHA256したもの。
source digestは`f5638f8587ca209ab409c321f03bbec3a16c96d18cf404dea9e2e2e90c9ddc6a`、
test inputs digestは`5526a6521386d020091a911c5747f031f6774eed5e265af64da91e1039693537`。
test inputsはこの自己更新する監査Markdownだけを除き、fixturesを含む全testsを固定する。
最後のartifact captureは本追記を含む全file digestと、untrackedも含むdirty patchを保存する。
source/testリスト、正確なbefore/after比較、要求case mapは`.tmp/0717/`に保持した。

最終board readbackは`board-final-readback.json`でstart本文と完全一致し、
0717は`In Progress`のままである。board更新・Issue公開・実Flow開始・製品修正・
commit/merge/push/外部remote書込みは行っていない。Git peerは検証所有のlocalだけである。

## 55dc: cleanup / Service audit の共有前提

この追記は prefix/suffix の保証対応を記録する。上記の過去検証結果を今回の
clone 移植成功や速度比較へ流用しない。

| 対象 | 共有する正規 producer prefix | 独立 clone の suffix と実 consumer |
| --- | --- | --- |
| F07 orphan cleanup 11前提 | 既存 finalize-commit seed から commit、squash、sync、正規 evidence の Git checkpoint、feature orphan commit を生成。cleanup claim 前で固定 | 各 clone で新しい cleanup claim。dirtiness matrix 5件、audit 保存 fault、branch 削除 fault/retry、rescue 成功、base ref lock、unknown dirt、expected-SHA race の6件で既存 fault・refusal・Report readback・rescue・teardown を実行 |
| Finalization Service audit 5前提 | Report 実行前までの同じ上流を一度生成。4 leaf へは元の正規 advance による派生 seed を作る | direct/dispatch 各 route は対象 leaf を実行。別の Report-pending clone は4 direct caller の準備前拒否を検査。Report Result、receipt、catalog publication、保存後 reload、実 create/consume/project を保持 |

cleanup seed は Sync の Definition connector が正規に activate した cleanup Attempt を保持する。凍結前と各 clone で cleanup outbox・execution settlement・journal/resume preparation がないことを確認し、各 clone の実 pre/command 後に新しい execution receipt と begin_outbox Activity、clone 自身の mainRoot/authorityRoot を検証する。Attempt の存在を root-bound execution claim と同一視しない。
completed Finalization receipt の歴史的 mainAuthority や physical receipt の bytes を
移植先 root へ書き換えない。clone の新しい claim と実 consumer が現在 root、refs、
Report receipt を用いる。pending cleanup outbox、rescue journal、operation lock や
handoff reservation を完成証拠として移植しない。matrix の live publication observer に
よる nonterminal Result/receipt の検証も各 clone に残る。

各 Service target の registration admission を重い seed 生成より前に残す。
対象 producer の前に observer を新設し、projection だけで execution coverage を
満たした扱いにはしない。共有 seed と各 clone は既存 seed/fromSeed と SeedWorkRoot を
使い、SeedCleanupScope が owner hook を module 評価時に登録する。cleanup callback が
失敗しても残りの所有 root 回収を試み、失敗を AggregateError で報告する。
