# ff4a — Flow 回帰保証の統合

## 対象と基準

2026-10-13 に取得したボード ff4a の実装。作業ブランチは `codex/ff4a`、
worktree は `.sennel/worktree/ff4a`。開始 commit は
`f6c763ee3115d93ace6f675fa4d4e4dfe9538abb`（main）。
初回はテスト整理だけを対象とした。後にユーザーが正規 producer の停止原因も
対象に含め、main へ rebase したうえで完了まで進めるよう明示したため、
必要な製品修正も含む。検証完了まで実プロジェクトの canonical 証拠・Flow・ボードは
変更せず、コミット・merge・push は実施しなかった。

旧失敗件数を製品障害件数や受入条件にはしない。旧テストの有効な assert は
条件、保護対象、拒否位置を比較し、同じ保証を持つ既存の試験へ統合する。
廃止済みの内部操作を復活させず、妥当な拒否の期待値を緩和しない。

## 保証と実装の対応

| 保証 | 統合・補完と実際の検証境界 |
| --- | --- |
| merge の失敗停止、認可済み復旧、成功後の sync | 旧 hook 単体ファイルを削除。既存 recovery F04 の実 conflict→拒否→修復→認可→実 merge を再利用し、認可前の merge/sync/cleanup が canonical/Git/docs に副作用を出さない assert を補完。pre 単独 reset、raw status 単独成功化は廃止契約。 |
| source 限定 commit と index 保持 | 旧 B01 の不正な準備を既存 F02 の正規 Report/frontier に統合。completion-boundary の target Spec/docs 限定 commit、runtime 除外、無関係 index 保持、ignored spec root の独立保証はそのまま残す。 |
| main authority の受け渡し | managed F07 の Prepare/report/merge を再利用。登録済み merge post をそのまま実行して受け取った context から正規 claim と実 sync pre/body/post を実行し、保存 Report と実 docs process の main cwd を確認する。オブジェクト同一性を契約にはしない。 |
| metadata の結合・stale bytes・cache sidecar | 正規 cleanup Attempt の既存 writer→保存→fresh manager→catalog consumer で binding と append を確認。stale bytes の拒否を物理 snapshot で保護。実 managed frontier で cache API の sidecar 保存と通常 metric の無増加を確認。catalog の判断をテスト側で実装しない。 |
| writer 再入と managed worktree 削除拒否 | 正規 cleanup frontier で独立 writer lock を取得する前に context/snapshot を保存。保持中の実 teardown の拒否を物理 bytes・refs・directory・registry・journal で確認し、解放後は fresh manager と同じ実 teardown で再開を確認。dirty な実 worktree の所有 binding と Report 保持も補完。 |
| 限定 auto-rescue と Git の復旧 | 既存 F07 の actual rescue、CAS lock/race、unknown status を再利用。独立した checkout/raw index、適用済み CAS 応答喪失、実 process loss 後の materialization、conflict probe 失敗は standalone immutable Git seed の低い境界へ統合。exact audit/独立 facts/stale catalog/不正 metadata は実 producer からの clone で区別する。remaining ref の validation は既存 ref-observation suite に補完。 |
| force audit の保存失敗と中断後の facts/audit 保持 | 既存 F07 の本物の canonical 保存 fault と Git branch deletion failure/retry を再利用。前者には物理 persistence snapshot を追加。旧 issue-log directory 準備と廃止補償手順は、そのまま戻さない。保存済み journal と stable audit、独立 facts の保持を確認する。 |
| finalized 後の拒否と replay | 旧 finalizedFixture の手作業全工程確認を削除し、既存 F07 の実 cleanup producer を再利用。note/metric/policy/artifact/approval/runtime/direct Activity の入口を同一の finalized seed で検証。完全一致 replay と不一致 replay、flow/Activity/catalog bytes、catalog hash、permanent identity と bytes、未 catalog 化の試行先 artifact 不在を確認する。旧 flow_created の2契約は保持。 |
| promoted 実行と延期義務の下流引渡し | 旧 mixed の不正な独自準備を削除。既存 Requirement 混在 R を正規 producer の immutable seed にまとめ、成功 clone は既存 `consumeMixedDownstream` で実 Test/Retro/Acceptance/Report を利用する。拒否 clone は延期 receipt だけを既存 corruption helper で除き、fresh manager の実 consumer と call/Activity/budget/物理 persistence の不変性を確認する。 |
| Result 期待値の単一化 | 固定期待値は `finalization-phase-result-contracts.js` に一度だけ定義。既存 assertion owner と共通 unit が同じ値クラスを利用する。既存共通クラスを `phase-result-contract.js` へ抽出し、unit には Definition/process/Git/Flow fixture を持ち込まない。完全集合・順序・一意性・codec・Error・不一致拒否を保持し、製品 registry から期待値を作らない。 |

`CanonicalPersistenceSnapshot` は旧物理 snapshot の契約を移管した共通 assertion。
既存 scenario の `snapshot()` は意味上の JSON 投影であり、byte rewrite や
未 catalog 化の副作用を検出できないため、同一契約の代用としては使わない。
lock 保持中の assertion は manager を読まず、取得前に保存した物理パスを読む。
新しい汎用 Flow fixture 基盤や製品側の検証ロジックは追加しない。

開始 HEAD に存在する `AcceptanceReviewExecutionHeldResult` が共通 unit の固定一覧に
欠けていたため、その確定契約も追加した。完全集合 assertion を弱めていない。

## 初回のテスト整理の検証証跡（製品修正前）

全コマンドはこの worktree で実行し、出力を `.tmp/ff4a-*.log` に保存した。
当時の候補のファイル hash は `.tmp/ff4a-test-revision.json` に記録した。
当時の変更 JavaScript（削除も含む19ファイル）の fingerprint は
`fffb7ec014d699ce2376588000dc81ff8471c44da05c6027bd3bf676cd1cd371`。
直前候補は `d2ef5c692c30304df224efc182456906edc7a7ea661cf8b98f6b7e52a81363af`
であり、そこからの変更は C04 の実 dispatcher completion への接続だけである。
相対パスと各 bytes の SHA-256 をソートした一覧に SHA-256 を適用した値であり、
削除は null として区別する。
Result クラスの抽出先に関連する caller は impl/acceptance assertion、finalization
scenario、共通 unit、Task Gate source-authority で検索した。

| 対象 | 測定結果 | 証跡 |
| --- | --- | --- |
| 共通 Result unit | 7/7 成功 | `.tmp/ff4a-result-unit.log` |
| 最終化 Result/Settlement 専用検査 | 89/89 成功 | `.tmp/ff4a-result-contract.log` |
| 実装工程 Result の既存 caller | 64/64 成功 | `.tmp/ff4a-impl-result-contract.log` |
| Acceptance 固定 Result の既存 caller | 25/25 成功 | `.tmp/ff4a-acceptance-result-caller.log` |
| retained completion-boundary と Requirement validators | 4/4 成功 | `.tmp/ff4a-completion-retained-bootstrap.log` |
| cleanup ref-observation | 9/9 成功 | `.tmp/ff4a-cleanup-refs.log` |
| 独立した Git rescue 境界 | 4/4 成功。既存 contract registration を直接実行し、assert のコピーは作らない | `.tmp/ff4a-cleanup-git.log` |
| retained flow_created、Task Gate caller、共通 producer recovery | 15 成功・3 失敗。creation 2件と Gate 7件は成功。recovery の3件は変更していないテスト/API の別原因であり、今回の受入成功へ合算しない | `.tmp/ff4a-retained-and-shared-callers.log` |
| Requirement 混在 consumer | 前段 producer の TypeError で seed hook が停止。success/R02 の2件は cancelled、consumer assert に未到達 | `.tmp/ff4a-requirement-mixed-bootstrap.log` |
| 通常の最終化シナリオによる producer seed 生成 | 正規 Draft→Spec→Impl→Acceptance→Regression→Report で immutable frontier を生成。後の保存 assertion 補強を含まない候補の実行は superseded/cancelled（exit 143）。suite 成功とは扱わない | `.tmp/ff4a-finalization-integrated.log`、`.tmp/ff4a-producer-seeds.log` |
| F06 Execution 等を含む先行対象実行 | broad r2 は superseded/cancelled（native exit 1）で suite 合格ではない。ただし影響を受けない F06 の4ケース、F04、C08、C09、I01/I02 を一つにまとめた real-completion ケースの計8ケースは成功を測定。後述の dependency／import 証跡の制限を付けて保持 | `.tmp/ff4a-finalization-current-r2.log` |
| 最終候補の source 限定 commit と index 保持 | F02 terminal exit 0。1 test / 1 pass / 0 fail / 0 cancelled / 0 skipped | `.tmp/ff4a-commit-scope-current.log` |
| managed writer 再入／dirty-input | r3 terminal exit 1、2 tests / 1 pass / 1 fixture fail / 0 cancelled / 0 skipped。C07 は clean baseline と exact injected dirty path の拒否・binding/Git/Report 保持に成功。訂正した C04 の r4 は最新 fingerprint で terminal exit 0、1 test / 1 pass / 0 fail / 0 cancelled / 0 skipped。実 lock 拒否→解放→同じ raw teardown→active entry 保持→実 registered completion replay→main consumers を確認。両ケースで実 C03 接続も到達 | `.tmp/ff4a-managed-current-r3.log`、`.tmp/ff4a-writer-current-r4.log` |
| metadata stale bytes の拒否 | 最終候補の C01 は成功。破損後に verified catalog を再読込する不正な assertion 準備を修正し、物理 bytes を比較する同じ拒否保証で確認 | `.tmp/ff4a-metadata-dirtiness-current.log` |
| exact audit の限定 dirtiness allowance | terminal exit 1。exact audit の許可が MAIN_REPO_DIRTY（flow/Activity/catalog）で失敗。独立 fact・stale catalog・不正 metadata の3拒否条件は成功。suite/container の失敗数を別製品障害として重複集計しない | `.tmp/ff4a-dirtiness-current-r2.log` |
| 共通 finalization helper の既存保存 caller | r2 terminal exit 0。5 tests / 5 pass / 0 fail / 0 cancelled / 0 skipped。実 completion の2保存 fault→rollback→retry と権限境界、登録済み required audit の保存失敗前後を確認。旧 verifier は受入結果に使わない | `.tmp/ff4a-caller-checks-r2.log` |
| suite manifest 境界 | 2/2 成功。通常の分類・unit の禁止依存規約を維持 | `.tmp/ff4a-runner-manifest.log` |

初回の bootstrap なし `node --test` は `RUNTIME_UNPROVEN` で import 前に停止した。
正規 runner または `--import ./src/sennel.js` を使った結果だけを契約検証に数える。
古い候補で開始した3本の phase pattern job と、後で assertion/fixture 補強を加えた
候補の broad job は最終候補の対象実行へ集約して明示停止した。
明示停止した suite の終了判定は superseded/cancelled とし、suite 合格や
追加の製品障害には数えない。一方、すでに正常終了した個々のケースは、
関連する本体・利用 helper・依存の変更を校正できる範囲で、上表と後述の
制限を付けた成功観測として保持する。
保存 assertion の補強後に変更された箇所は、古い import の実行結果だけでは
最終候補の検証済みと扱わない。


先行 r2 の成功を再利用する範囲は、変更した責務との依存で限定する。
F04/F06 は登録済み recovery contract と通常の branch scenario を使い、
`process.execPath` matcher は r2 の開始前に補正済みだった。その後の tracked
analysis baseline は managed Prepare 専用で、これらの branch 入力には適用されない。
C01/C05 の後の訂正は各ケースの準備だけであり、C08/C09／real-completion の
本体と共通 orphan producer は変更していない。Snapshot の後の optional
`expectedChanges` は C01 が使う `assertPhysicalUnchanged` に限り、C08/I が使った
constructor／`assertUnchanged` の保証は変更していない。r4 の変更は C04 本体だけで、
F02 と既存 caller の既測定対象・利用 helper の bytes も変更していない。
一方、superseded import 時点の cleanup/helper ファイル全体の hash を別保存して
いないため、先行 r2 の imported 全 bytes の一致は再証明できない。
関連 case 本体・利用 method・編集履歴の校正として成功観測を保持し、
現在の全 suite 合格や別 candidate 全体の実行完了へ読み替えない。
C02 の先行成功も記録は残すが、tracked baseline 訂正後の managed fixture 全体の
再測定とは扱わない。C01/C05 の不正準備による先行失敗は各対象再実行へ置換し、
C04 の不正 consumer 境界は r4 に分離した。

通常シナリオが実際に生成した公開済み immutable seed のうち standalone Git
repository だけを `SeedWorkRoot` で独立保存した。コピー前後と fresh manager の
flow/Activity/catalog/permanent identity/bytes が完全一致し、Git common-dir が
自分の `.git`、linked worktree 登録がないことを確認した。
Report の hash `0a7327b525cb4bfd3f6f73c41af1816c514f06ac93f28332edd63e807abbd8bc` は
本物の `report-generated` Activity
`acceptance-step-settled-4d9bfcdd-09a4-4416-8a7b-3ddb9cafbca7` に結び付く。
取得記録は `.tmp/ff4a-producer-seeds.json` に残す。

対象実行の一時 verifier は元の fixture seed API を delegate し、既存の
`seedRoot` 引数だけに上記 checkpoint を渡す。現在の元 phase module を import
するため assert のコピーや製品 producer/Store の代替はない。managed worktree
のケースは毎回実 Prepare から作成し、worktree の `.git` はコピーしない。
対象は F02、F04 conflict/recovery、F06 の4 Execution publisher、C01/C03〜C09 と
finalized 拒否/replay。これは対象境界の検証であり、全 suite の合格ではない。

初回の対象実行は F06 cleanup の docs callback 件数で停止した。
現在の `RuntimeChildExecution.runSync` が `process.execPath` を実行するのに対し、
既存 fixture は literal `node` だけを照合していた。独立した診断で実 docs
subprocess は exit 0・diff なし・outbox done であり、fake を通らず callback が
0件になったことを確認した（`.tmp/ff4a-sync-diagnostic.log`）。製品の sync 失敗ではない。
`FinalizationPhaseScenario` の外部 process matcher を現在の実行 API に合わせ、
同じ assert で r2 を実行する。旧 executable の互換分岐や内部 producer の代替は追加しない。
この補正後の Source/F06 と、検索した他の helper caller の保存境界を確認する。
初回の `.tmp/ff4a-finalization-current.log` は superseded/cancelled として区別する。

C01 の負例は、破損前の Snapshot を取得し、意図的に変更した入力 bytes を
`assertPhysicalUnchanged` に渡す。破損後の verified catalog 読込みで、対象の
writer assert に未到達となる準備は使わない。C05 の clean baseline は既存の
orphan producer が checkpoint 済みであり、変更のない二度目の Git commit は
不要。audit 保存前には正規登録 pre で Execution Result/outbox を保存する。
いずれも拒否・許可の期待値は変更していない。

managed の writer 再入拒否後の再開では、fixture が Prepare 後に生成した
未追跡 analysis.json で WORKTREE_DIRTY となった。分析用の同じ `{}` bytes を
Prepare 前の tracked baseline に置き、実 Prepare が両 checkout へ配布する
ように訂正した。dirty-input ケースも挿入前の clean worktree と、挿入した
ファイルだけの dirtyRootFiles を assert し、別の fixture dirt を理由に
成功扱いしない。この2条件は `.tmp/ff4a-managed-current-r3.log` で確認する。

C04 r3 は raw `runTeardown` が worktree 削除と completed journal を保存した後、
まだ dispatcher が処理していない active registry の消去まで期待して失敗した。
これは削除拒否や再開の製品障害ではない。旧 C04 も raw teardown の時点では
active entry を保持する契約だった。最終候補では raw 再開後に worktree 不在、
completed journal、取得前の activeFlows 保持を確認し、実 registered cleanup replay
で dispatcher の runtime log／completion commit／active clear を行ってから、
既存の `assertMainConsumers` をそのまま実行する。前段の拒否・再開の観測は残すが、
r3 の C04 全体の受入成功は主張しない。訂正した同じ保証は r4 で terminal exit 0
となり、既存 main consumers を緩和せず実 dispatcher completion まで確認した。

共通 helper caller の一時 verifier は、全 import を async owning describe に
まとめ、後続 caller 登録前の一時 root／seed forwarding 解放を訂正した。
結果は `.tmp/ff4a-caller-checks-r2.log` に記録し、旧 verifier は受入結果に使わない。

```sh
node --test --import ./src/sennel.js --test-name-pattern 'F02 implementation commit|F04 genuine squash conflict|F06 .*publishes its exact Execution Result before effects|F07 cleanup metadata|F07 rescue dirtiness|F07 force audit|F07 forced branch deletion|F07 real completion|F07 prompt-cache|F07 writer reentry|F07 dirty managed' .tmp/ff4a-current-finalization.test.js
```

## 初回に分離した製品阻害の記録

Requirement の正規 Spec/approval/test producer を進める途中で、
`WorkerArtifactHandoffRequest` → `CanonicalFlowManagerStore.draftStepExecutionState`
→ `DraftStepExecutionState` が
`TypeError: Draft execution state receipt must be typed` で停止した。
今回の receipt 欠損操作はまだ行われていないため、R02 による拒否ではない。
変更していない permission scenario でも同じ停止を測定した。
runtime revision は `90de4f977ddb3061c1e5c2300b29ea11258d769a29cee0dac9bb33d70426c951`。

静的には共通 reader の `executionLifecycle !== null` が lifecycle を持たない
receipt も選択する可能性がある。正確な発生 receipt の校正と製品修正は
別項目で扱い、source を変更したり内部 producer を fake にしたりして
今回の受入を通さない。この障害が解消されるまで R01/R02 の最終候補は未確認である。

変更していない recovery suite の別原因は、拒否 code の期待差、競合 process の
期待成功数不足、廃止済み `repairAcceptanceReview` API の呼出しである。
共通 raw Activity の完全一致／不一致 replay 保護の対象ケースは成功した。
これらの失敗も期待値変更や互換 API 復活で隠さない。

新たな別修正候補は、exact-owned canonical audit の metadata allowance である。
通常の cleanup checkpoint→登録 pre の Execution publication→`appendIssueLog`
を通した入力が、`runAutoRescue` で flow.json/activities.jsonl/artifact-catalog.json
を dirty として拒否された。issue.log は dirty list に入っていない。
`appendIssueLog` は `publish_artifacts` Activity と issue.log descriptor 更新を保存
する一方、`FinalizeFlowMetadataAllowance` は begin_outbox／settlement の suffix
だけを認め、他の catalog descriptor の変更を認めない。
`AutoRescueIssueLogAllowance` が許す exact audit を前者が拒否する契約の不足である。
canonical audit を消す、raw file writer を使う、都合のよい metadata commit を
作る操作では直さない。本項目では positive assert を保持し、c482 等の別製品
修正の対象として、この producer/readback/consumer 接続の再現を引き渡す。

再開時は最終 source/test revision を記録し、次を対象として実行する。

```sh
node tests/run.js --file tests/integration/flow-cli/finalization-phase-scenario.test.js
node --test --import ./src/sennel.js --test-name-pattern 'mixed promoted/deferred' tests/integration/flow-cli/requirement-test-phase-scenario.test.js
```

通常の suite discovery、CI、工程専用シナリオの義務は変更しない。
全 repository の合格、既知障害を外した比較、未知障害までの網羅性は主張しない。
初回の判定は **受入検証が未完了** だった。以下の追加実装・検証が、
その時点の未到達 consumer と製品阻害の扱いを更新する。

未解消の別製品修正と再開のため、独立保存した immutable seed、取得記録、
最小の一時 verifier script は必要な再現資産として保持する。完了済みの診断
harness は削除済みで、残した verifier を canonical Flow の代替には使わない。

## ユーザーが対象を拡張した後の実装と検証

`git fetch origin main` と `git rebase --autostash origin/main` を実行した。
取得時の main／origin/main／ff4a HEAD はすべて
`f6c763ee3115d93ace6f675fa4d4e4dfe9538abb` で、追加の upstream commit はなかった。
rebase 前後で23変更ファイルの bytes／削除状態が一致した。
記録は `.tmp/ff4a-pre-rebase.json`、`.tmp/ff4a-rebase-fetch.log`、
`.tmp/ff4a-rebase.log` に保存した。

製品修正は既存 owner の契約を拡張した。

- lifecycle を持たない Requirement receipt を Draft reader が選択しないようにし、
  既存の typed receipt、binding、codec invariant を維持した。
- 成功後に消える handoff request だけでは実行世代を復元できないため、既存
  Requirement receipt に typed execution contract を同じ transaction で保存する。
  保存済みの正規 R1 結果・同 Attempt・次 R・plan publication から次世代を認可し、
  既存の contract reader と publication admission で episode／budget／limit を保護する。
  旧 R1 claim は plan baseline で拒否し、同入力再取得は重複保存しない。
- 正規 audit の文書許可を metadata allowance と共有し、その catalog producer と
  cleanup Attempt に結び付く publication だけを許可する。他の Activity、fact、
  catalog descriptor の変更は従来どおり拒否する。
- R02 の直接 consumer は通常の `dispatchContainer` を DI する。既存の延期義務検査を
  `RequirementTestExecutionLifecycle`／`readExecutionLifecycle` へ移し、Execution 保存前と
  実行時の fresh read で同じ検査を使う。期待する拒否・bytes・call・budget assertion は維持する。

Requirement receipt の wire fields と identity hash は新契約であり、旧 seed は再利用しない。
最終化は既存の正常な seed API を変更せず、正規 producer で再生成している。
旧 seed による `.tmp/ff4a-audit-fixed.log` は schema 不一致で hook が止まった
取消結果であり、製品の失敗や assertion の合格には数えない。

| 対象 | 結果と証跡 |
| --- | --- |
| 次 R の保存・復元・世代・予算・replay・旧 claim 拒否 | 新回帰1件成功。Draft owner4件、contract owner3件、tooling retry owner1件も成功。`.tmp/ff4a-receipt-generation-*.log` |
| 元の2障害の検出 | 同じ新回帰を隔離コピーで実行し、presence filter の旧条件で TypeError、世代選択の旧経路で inputRevision mismatch を検出。`.tmp/ff4a-receipt-{presence,generation}-fault.log` |
| R01 の実 Test／Retro／Acceptance／Report | 成功。permission 拒否・予算保持も成功。R02 は当時 DI 不備で停止し、別の限定実行へ移した。`.tmp/ff4a-requirement-generation-fixed.log` |
| R02 の先行失敗 | DI 訂正後、延期 receipt の拒否前に Execution／audit 保存が発生する契約違反を検出。sources 列挙だけの precheck は不足であり、共通 lifecycle reader に置き換えた。`.tmp/ff4a-requirement-missing-admission-fixed.log` |
| 新しい Requirement lifecycle value | 正常 mixed、missing、stale を含む15件成功。`.tmp/ff4a-requirement-prerequisite-unit.log` |
| Draft／Spec 専用の実 producer→保存→readback→consumer | 代表2件成功、terminal exit0。`.tmp/ff4a-draft-spec-product-fixed.log` |
| 実 agent handoff | 実 Codex Spec worker の seal／canonical publication 1件成功、terminal exit0。全 agent suite は実行していない。`.tmp/ff4a-agent-handoff-product-fixed.log` |
| 共通 Result と lifecycle の owner 集合 | unit7件・最終化 Result89件は成功。lifecycle26件は14成功・12失敗。`.tmp/ff4a-owner-contracts-product-fixed-r2.log` |
| 上記 lifecycle の既存失敗の分離 | 同じ test bytes で HEAD の隔離コピーを実行し、代表2件が同じ missing execution contract で失敗。review fixture が通常の checkpoint／contract claim を省略している既存準備不備。`.tmp/ff4a-lifecycle-baseline.log` |

最終候補の32 JS path（削除を含む）の fingerprint は
`67a4faa198e9f41a401bf9dbb6b41de0d8e04de2a46d8027d8260a53da10eecb`。
`.tmp/ff4a-product-candidate-final.json` と照合し、内容・削除状態の一致を確認した。
最終 Requirement scenario の SHA-256 は
`0ff8d79c2e3fff6ededb1331c95cfe0ce82347da9693203b2304da8b142bc0b8`。

| 最終限定実行 | native terminal 判定と範囲 |
| --- | --- |
| R02 の同一入力による隔離比較（14115） | exit1、1件失敗・cancel0。最終 source から pre-Execution lifecycle read だけを除外し、同じ scenario bytes／期待値／正規 producer を維持。期待する missing receipt error と process／worker／review 無呼出しを確認した後、line815 の protected-state deepStrictEqual が Execution／issue Activity の追加を検出。fixture／import 失敗ではない。`.tmp/ff4a-prerequisite-before-comparison.log` |
| 最終 R01/R02 consumer（45380） | exit0、2/2成功・fail／cancel／skip0。final32 source の正規 mixed producer から実 Test→Retro→Acceptance→Report と、missing receipt の無呼出し・Activity／budget／raw persistence 保持を確認。同一 test SHA の14115との pre/post 検出証明が成立。`.tmp/ff4a-requirement-final-consumers.log` |
| Requirement／Impl 構造検査（91107） | exit0、74/74成功。`.tmp/ff4a-structure-product-fixed.log` |
| 正規 producer で再生成した最終化（27523） | exit0、19/19成功・fail／cancel／skip0。14対象ケースと audit の5子条件。F02、F04、F06の4 Execution publisher、metadata、限定 audit、保存障害と retry、finalized拒否／replay、managed cache／writer再入／dirty worktreeを確認。`.tmp/ff4a-finalization-product-fixed.log` |

R02 の先行修正後試行では、拒否・無呼出し・canonical bytes／Activity／budget 保持まで
成功したが、最後の artifact 不在確認で未認可の `test-execute` consumer を使っていた。
最終45380と隔離14115は正規の `test-result-review` consumer で同じ null expectation
を検証する。先行試行を R02 全体の合格には数えない。

fresh seed を使う最終化の対象条件（27523）は完走した。
その実行は27-path candidate
`eb99f3c709add7ce1751ae14bdf1b5e13422a0cd42e76d1c0aead9383190d29a`
に pin されている。`.tmp/ff4a-product-candidate.json` と final32 manifest の差は
Requirement pre-Execution lifecycle の4 source、Requirement scenario の DI／最後の
consumer role、lifecycle unit test の6 pathだけである。最終化／audit／persistence
helper、receipt generation source と回帰 test の bytes は一致した。
27523を final32 全体の実行とは扱わず、後続の Requirement／Test→Retro→Acceptance→Report
の接続は最新45380の成功で確認する。main／origin/main／HEAD は読み戻して f6c のままである。
最終化の terminal exit0は、停止前に残した同じ session27523から再開時に回収した。
停止・再開による再実行はなく、final32の内容・削除状態も32 pathすべて一致した。

## 最終判定

ボードの保証単位への統合と、ユーザーが追加した製品阻害の修正は完了した。
R01はpromotedのみの実行と延期義務のReportまでの引渡し、R02は欠損receiptの
実行開始前の拒否と無呼出し・Activity／budget／物理保存の保持まで到達した。
既知のreceipt選択・世代継続・拒否前保存の障害は、同じ回帰テストを使う
隔離した修正前比較でも検出した。旧18件の復活や各入口ごとの全Flow生成は行わず、
既存の判断・保存APIと工程シナリオを再利用した。ボード自体に過剰な必須条件はない。

別系列のlifecycle fixture失敗12件は、同じ準備経路のmissing review execution contract
として分離した。代表2件は基準HEADでも再現したが、12件すべての基準実行や修復を
行ったとは主張しない。フルテスト・全repositoryの合格は主張しない。
検証完了時点ではコミット・merge・push・実プロジェクトのFlow／ボード更新は未実施だった。
2026-10-14の追加指示により、検証済みの変更をコミットしてmainへ統合する。
コミット前のstaged差分検査で、新規assertion helper2ファイルの末尾の余分な空行だけを
削除した。上記検証候補からのソース・テスト差分はこの整形だけである。
