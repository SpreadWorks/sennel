# Task Reviewの因果シナリオと検出力の測定

このテストはFlowをdispatchせず、実worker・実AIを起動しない。既存の
`TaskLifecycleFixture`から、製品のTask実装handoff、Review protocol、親側の
publication、definitionの判断、Storeへの適用を局所的に接続する。
子プロセス境界では製品の応答parser・formatter・seal・エラー分類を使い、
AIの応答とプロセス起動だけを決定論的な代替処理にする。

## 結果から逆に追った契約

| 観測したい結果 | 必要条件／生成元 | 主な確認 |
| --- | --- | --- |
| 上限消費後に再度復旧できる | 失敗Attemptと一致するbaselineまたは正当なreceipt | 2回の失敗・変更証跡・復旧を別Storeインスタンスで接続 |
| semantic回数が保たれる | 現在ラウンド内のcatalog公開済みReview件数、親発行の実行identity | tooling復旧を挟んでも第2回のordinalをworkerへ渡す。実行エラーのretry上限は別に維持 |
| 不正応答で安全に停止できる | complete contractの検証、bounded protocol、親の失敗記録 | array／不正JSON→2回の応答→marker分類→親の保存→reload |
| 未承認変更を次の実行の基準にしない | 応答前のソースsnapshot、変更所有権の検証、source-integrity失敗を保存しDefinitionがblockedを選択 | 不正応答＋変更／完成した応答＋未申告変更で停止。変更を消さず、reload後の通常retry・変更証跡による復旧・直接worker再実行を拒否 |
| 未確定Reviewから安全に復旧できる | 旧work unit、親が保存した無変更checkpoint、同じAttemptに結び付いた復旧receiptと許可時checkout | 許可されたcommitは再開境界を通り、通常retryだけでは許可されない。許可後の追加変更、未承認Task変更、根拠欠落は拒否 |
| 4回目の修正をGateへ一度だけ渡す（C1） | 同一Taskの修正lineage、semantic回数4、公開済みReview、definitionのhandoff | seal後／publication後の中断、tooling復旧の混在、別Storeからのsettlementと冪等性 |
| PASSがGateに受理される | 現在AttemptのReview成果物と公開記録 | 親のpost→reload→Gateのclaim（Gate実行なし） |
| 後の復旧判断に必要な状態が失われない | 通常開始、invalidated-nodeのclaim、直接recover／rewindが保存するAttempt固有のbaseline | 正規の実装handoff／Review PASSから各入口へ進み、array応答2回→親の失敗保存→別Store→変更証跡→復旧receiptと新Attemptを確認 |
| 前段の必須証跡がなければ開始を拒否する | Storeのconsumer admissionがruntimeのrecover／rewindにも渡る | `recovery-admission.test.js`で正規の前段完了後に保存境界の欠落を与え、typed errorとcanonical全ファイル不変を確認 |
| PASS済みGateを既存仕様のまま巻き戻せる | Gate PASSはsemantic FAIL用sourceを生成せず、baselineは必須ではない | 正規のReview PASS→Gate PASS→直接rewind→別StoreでGate Attemptとbaseline不在を確認 |

「4回目の修正完了」はソース変更とmust-fixの対応を表す。修正の意味的正しさや
Gate・Acceptance全体の成功を、このテストの合格だけで保証しない。
各中断テストは保存済みデータを新しいStoreで読み直すが、OSの強制終了・電源断や
実プロセス間競合の網羅試験ではない。

## 通常実行

```sh
node tests/run.js --file tests/integration/flow/task-review-causal-scenarios.test.js
npm test
```

mainは過去の修正がrevertされた状態のため、回帰テストが赤になることがある。
期待値を弱めたり、過去の修正を自動で取り込んだりする運用にはしない。

## 隔離コピーによる測定

```sh
node scripts/measure-task-review-regressions.js <実行worktreeの絶対パス> <canonical版ディレクトリの絶対パス>
```

- 入力worktreeの未コミット変更を含むファイル、`.sennel`、指定canonical版をコピーする。
- 元worktreeの`.git`ポインタはコピーしない。コピーから元repositoryを変更できるGit接続を持たせない。
- 元のcanonical証跡は補完・正規化しない。コピー上でもFlowのdispatch・再開はしない。
- 固定した同じテストを、現行コードと修正を新しい順に外した5版で実行する。
- 外すのは各コミットの`src/`差分だけ。コミットに含まれるテストは外さない。
- 通常ケースはコピー内の製品コードと一時fixtureを使用する。現Flowそのものは
  `task-review-snapshot-probe.js`で読み直し、停止Attemptのbaselineを検査する。
- `original-before.json`／`original-after.json`、seedのhash一覧、版別TAP、
  snapshotログ、`results.json`を表示された一時ディレクトリに保持する。
- 出力ディレクトリは証跡として保持するため、自動削除しない。

この測定は「コピーしたFlowを最後まで実行できるか」ではない。コピーした現在地の
検査と、そこから抽出した因果条件を実行する局所シナリオの組合せである。

## 検出力の判定方法

現行版での合格と、対応する修正を外した版での**意図した契約違反による失敗**を
一対で確認する。importエラー、構文エラー、fixtureの不正、タイムアウトは捕捉に
数えない。累積除去なので、先に発生した失敗が後の不具合を隠す場合がある。
その場合は原因を区別するケースまたは個別の比較が必要である。

5つの既知修正を捕捉した割合は、未知のバグに対する検出率・網羅率・統計的な
precisionではない。既知修正に対する回帰検出感度としてだけ報告する。
以下の過去測定時点で未修正だったbaseline不足は、その時点の現行版でも失敗したため、
過去5修正の除去による検出数とは別に報告している。

## 一次証跡との対応

調査したrunのActivityでは、T-6-reviewに次が記録されていた。

- 767／771／773: `TASK_REVIEW_PARTIAL_EFFECT`（commit・stageされた状態を比較できない）
- 769: current execution roundの外としてworkerが停止
- 775: semantic retry accountingが不正としてworkerが停止
- 778: must-fix findingsが所有しないソース変更を親が拒否
- 818（T-7-review）: array応答がcomplete contractに違反し、protocol 2/2で停止

現在地のbaseline不足と、上記各停止は別の観測である。一つのテスト失敗を
すべての停止の再現として扱わない。

## 2026-09-07の測定結果

対象はmain `f8ae899da`、実行worktree `5cf1d97e0` とその未コミット変更。
各版で同一hashの16ケースを完走した。構文エラー・importエラーによる検出ではない。

| 版（修正の除去は累積） | 成功 | 失敗 | 直前の版から新たに検出したもの |
| --- | ---: | ---: | --- |
| 現worktreeのコピー | 15 | 1 | 未修正のrecover_attemptのbaseline不足 |
| 5cf1d97e0を除去 | 13 | 3 | 不正応答時のrollback、未申告の変更を受理する問題 |
| さらに39148ea56を除去 | 12 | 4 | workerへ渡すsemantic ordinalの欠落 |
| さらに9e839d1dcを除去 | 11 | 5 | receiptがある未確定Reviewのcommit後復旧がPARTIAL_EFFECTで停止 |
| さらに4dab68ee2を除去 | 9 | 7 | tooling失敗のsemantic回数混入、4回目のGate引き渡し失敗 |
| さらに857c2a64cを除去 | 8 | 8 | 復旧Attemptが再び失敗した際のbaseline読取り失敗 |

当時の期待値での対象5修正に対する検出は **5/5**。未知の不具合の網羅率を意味しない。
ただし、後続の契約確認で任意のprovider変更を自動rollbackする期待値は採用しないと
判断した。この履歴測定は保存するが、rollback修正の正当性の証明には使用しない。
mainでの通常runnerによる追加テストの実行結果も8成功・8失敗だった。
過去の修正をmainに戻したり、製品コードを直して緑にしたりはしていない。

現在の停止Flowは、全6版で同じT-7-reviewの失敗Attemptとbaseline不足を読み戻せた。
コピーしたcanonical 197ファイルは全6版でbyte hash・modeが元と一致した。
元worktreeのHEAD・status・src・`.sennel`、元canonicalの測定前後一致も確認した。

最終測定の一次証跡:

- `/tmp/sennel-review-measurement-3yDoBC/results.json`
- 同ディレクトリの版別`*.tap`と`*-snapshot.log`
- 同ディレクトリの`original-before.json`、`original-after.json`、`seed-manifest.json`
- mainの追加テスト: `/tmp/sennel-task-review-normal-selected-2.log`
- 通常テスト全体: `/tmp/sennel-task-review-npm-test-1.log`

探索途中の測定は最終結果に含めていない。とくにfixture・API呼出しの準備不足を
訂正する前の失敗は、製品の不具合検出として数えていない。

### 通常テスト全体の完了結果

`npm test`はexit code 1で終了した。

| suite | 成功 | 失敗 |
| --- | ---: | ---: |
| unit | 687 | 0 |
| integration | 3,064 | 9 |
| e2e | 43 | 0 |
| acceptance | 6 | 0 |

integrationの失敗は追加ケース8件と、既存の
`does not record context-read metrics from a managed handoff worker`の1件。
後者は当該ケースだけの別プロセス実行でも再現し、期待値`[]`に対して
`{ phase: "impl", counter: "docsRead" }`が記録された。
この既存テストと製品ソースは今回変更していない。原因の修正は行っていない。
単独確認ログは`/tmp/sennel-task-review-existing-metrics-failure.log`。

実AIを呼ぶagent suiteは通常テストの対象外であり、今回実行していない。

## Review baseline修正後の比較（2026-09-07）

上記の履歴測定とは別に、main `ca4b70d8995b39fcd70beb3367678fb4467c76f1` と、
そのmainへ今回の製品3ファイルの未コミット差分だけを加えた版を比較した。
旧版はGit接続を持たない `/tmp/sennel-recovery-before-n6AeWb` に展開し、
同一のcausal 19ケースとadmission 2ケースを実行した。

| 比較対象 | 成功 | 失敗 |
| --- | ---: | ---: |
| 修正前 | 9 | 12 |
| 修正後 | 14 | 7 |

今回解消した5件は、Reviewのinvalidated claim・直接recover・直接rewindにおける
baseline欠落3件と、recover／rewindで前段証跡の欠落を拒否しない2件。
修正前の失敗はbaselineがnullになる契約違反と、期待する拒否が発生しないことであり、
import失敗や不正なfixtureによる失敗ではない。
修正後はarray応答2回による非retryable停止の保存後、新しいStoreで証跡変更を評価し、
receipt.previousが失敗Attemptのbaselineに一致すること、新AttemptのID・sequence、
semantic消費の維持、failure解除まで確認した。

Gateのsource生成仕様は変更していない。PASS済みGateの直接rewindは両版で成功し、
FAIL用のsourceやbaselineを捏造しない。既存のspec Gate正常系とplan Gate rewindの
2件も成功した。関連するrecovery／artifact readinessの既存31件とset-retryファイル
全体も成功した。

残る7件は両版で失敗しており、今回新たに失敗したケースはない。対象は反復復旧、
toolingのsemantic回数混入、worker ordinal、不正／未申告変更のrollback 2件、
receiptを使う未確定Reviewの復旧、tooling復旧を挟むGate引き渡し。
未確定Reviewのケースは今回のmainでは前段の反復復旧で止まるため、後段の
reconcileそのものをこの比較だけで評価したとは扱わない。
これらの期待値を弱めず残しており、テスト全体が成功したという結果ではない。

固定したテスト・fixtureのSHA-256（両版で一致）:

- causal test: `e182d98528966a6ac7c4b7df308c1cbbf1b6d8cc16bfb2ed022fbba533716d97`
- scenario builder: `f71d473b05ffd447f2a65142190ddddfdba3ed5d1a27728ec7224d15b8c3d7b4`
- admission test: `1d7a122d54981cb361aabab634372abefec92a7afd06ecc9d8d2d387c10023bc`

一次証跡:

- `/tmp/sennel-review-causal-before-comparison.log`
- `/tmp/sennel-review-causal-after-comparison.log`
- `/tmp/sennel-canonical-gate-regression-final.log`
- `/tmp/sennel-recovery-existing-boundaries.log`
- `/tmp/sennel-set-retry-after.log`

今回の修正後にnpm test全体、実AI、OSクラッシュ、実プロセス間競合は実行していない。
停止Flowのcanonicalや実行worktreeは変更しておらず、既に欠落しているbaselineを
この修正で後付け生成したり、停止Flowの再開を確認したりはしていない。

## A〜Dの契約別検証

比較元は `b4c610b471c4a60ca176a06bc12381ad3d8debc1`。Git接続を含まない
`/tmp/sennel-task-review-abcd-before-Ee2Teu` に展開し、製品ソースを変更せず
同じシナリオテストを配置して比較する。Dの前段でAの失敗に遮られないよう、
`/tmp/sennel-task-review-a-only-FhOcLN` には同じ比較元とAのreceipt読取りだけを
配置した。実行中worktreeやcanonicalデータへ修正を適用する比較ではない。

| 契約 | 修正前に検出する違反 | 修正後に確認する結果 |
| --- | --- | --- |
| A: 反復復旧 | 再び失敗した復旧Attemptのbaselineを読み戻せない | exact Attempt/route/Flowとcatalog Activityに一致するreceipt.currentを読取り、古い証跡や不一致を拒否 |
| B: Review回数 | toolingをReview件数に混ぜ、worker ordinalや4回目のhandoffがずれる | 現ラウンドの公開済みReview件数を使い、tooling上限とsemantic上限を別々に維持 |
| C: 未承認変更 | 不正応答＋変更は変更証跡による復旧が通り、未申告変更は通常retryが通る | ソースを削除せず停止し、別Storeから両retryと直接worker再実行を拒否 |
| D: 中断後の正当な復旧 | Aだけを直しても、許可されたruntime修正commitをworkerによるcommitとして拒否 | 親の無変更checkpointと復旧許可時の状態を照合し、未承認の変更は引き継がない |

Cの以前のrollback期待値は訂正した。最初の停止と証跡保持だけのテストは修正前も
成功するが、後続のretry／復旧まで接続すると上記の違反を検出する。
`/tmp/sennel-C-safety-before-final.log` は同じ入力の2件でこの拒否不足を検出し、
`/tmp/sennel-C-safety-r2.log` は修正後の2件が成功した記録である。
`/tmp/sennel-D-before-with-A.log` はbaseline不足ではなく、commit後の
`TASK_REVIEW_PARTIAL_EFFECT` を検出した記録である。

既存recurrenceテストには、3件の公開結果をraw sequenceが4という理由で4回目と
みなす入力があった。toolingによるsequence 3の欠番は残したまま、sequence 5に
本当の4件目のReviewと修正lineageを追加した。4回目のhandoff要件と既存findingの
再発件数は維持し、追加した別findingの履歴も検証する。

Review実行leaseは一時的なプロセス管理情報であり、対象ソースのidentityではない。
`repair-state-identity.test.js` は製品のleaseを取得／解放してもhashが変わらず、
通常ソース変更ではhashが変わることを確認する。

### 実装後の比較（2026-09-08）

固定した19シナリオのSHA-256は
`7977a155259aba06c26532635eed52d4fdf671a9771badd0c99164891c7e73b4`。
比較元では11成功・8失敗、修正後では19成功・0失敗だった。
失敗はbaseline不足、toolingの混算、worker ordinal欠落、未承認変更後のretry許可、
部分変更の停止分類、4回目のhandoffであり、importやfixture起動エラーではない。
D単独の違反は上記A-only比較で切り分けている。

- 比較元: `/tmp/sennel-abcd-causal-before-final-r22.log`
- 修正後: `/tmp/sennel-abcd-causal-final.log`
- 部分変更後のblocked/retry拒否の個別比較:
  `/tmp/sennel-C-partial-block-before-r19-escalated.log`（失敗）と
  `/tmp/sennel-C-partial-block-r18-escalated.log`（成功）
- 復旧・回数管理・前段admissionの関連65件:
  `/tmp/sennel-abcd-recovery-final-r19.log`（65成功）
- 既存runtimeのTask Review関連11件:
  `/tmp/sennel-abcd-runtime-review-final.log`（11成功）
- 復旧専用10件（通常retry、改変拒否、checkpoint欠落、複数retained、main/execution分離）:
  `/tmp/sennel-D-checkpoint-suite-final-r31.log`（10成功）
  複数retainedでは、失敗対象が後半の不正unitであることも追加assertし、
  `/tmp/sennel-D-atomic-candidate-final-escalated.log`で成功を確認した。
- work unitと成果物契約39件:
  `/tmp/sennel-abcd-artifact-unit-final.log`（37成功、2件はGit起動EPERM）、
  `/tmp/sennel-abcd-artifact-unit-environment-final.log`（該当2件成功）

実装検証で補強した境界:

- `TASK_REVIEW_PARTIAL_EFFECT`も、通常のtooling失敗として記録して進めず、
  source-integrityとしてblockedにする。変更と旧work unitを保持する。
- checkpointと復旧authorizationは自己digestだけでなく、実bytesとcatalog hash、
  Task・Attempt・publication Activityの一致を検証する。
- 通常retryでは、親が正規に公開したcheckpointと新Attemptのbaselineだけを
  checkout差分から区別する。HEAD・indexや任意のcanonicalファイルは免除しない。
  新workerのbaselineは、検証済み旧work unitのcleanup後に取得する。
- checkpoint時のTask source fingerprintを保存し、復旧許可を保存する前にも
  Task sourceが変わっていないことを確認する。
- mainと実行checkoutが異なる場合、canonical Versionの`repositoryRoot`を
  正規の証跡保存先として参照する。checkout外の親の記録はcheckout差分の例外に
  加えない。独立した一時repositoryとworktree-mode Flowでこの構成を検証した。

停止中Flowの保存状態は、過去測定の`original-before.json`とファイル単位で照合した。
canonical 197ファイル、実worktreeのsrc 504ファイルと実行時データ460ファイル、
HEAD、未コミット／未追跡状態は一致した。
確認結果: `/tmp/sennel-abcd-live-preservation-final.json`。
既存の不足baselineを後付けしたり、実Flowを再開したりはしていない。

全体テスト成功とは主張しない。広めの既存runtime検証では、managed handoffの
docsRead metric期待値の不一致が比較元でも再現している
（`/tmp/sennel-abcd-existing-metrics-before.log`）。この独立した既存失敗は変更していない。
実AI、OSクラッシュ、実Flowの再開は未検証であり、このシナリオ群の合格を
それらの保証として扱わない。

別担当による最終実装検証の判定は「承認」。部分変更のblocked分類、保存記録の
bytes/catalog照合、通常retryのpayload identity、main/execution分離の指摘を解消した。
