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
| semantic回数が保たれる | canonical consumption、現在ラウンド、親発行の実行identity | tooling復旧を挟んでも第2回のordinalをworkerへ渡す |
| 不正応答で安全に停止できる | complete contractの検証、bounded protocol、親の失敗記録 | array／不正JSON→2回の応答→marker分類→親の保存→reload |
| 不正な変更を次の応答へ持ち越さない | 応答前のソースsnapshot、応答と変更所有権の対応 | 不正JSON形状と、完成した応答が変更を申告しない場合のrollback |
| 未確定Reviewから安全に復旧できる | 旧work unit、同じAttemptに結び付いた復旧receipt | 許可されたcommitは再開境界を通り、通常retryだけでは許可されない |
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

対象5修正に対する検出は **5/5**。未知の不具合の網羅率を意味しない。
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
