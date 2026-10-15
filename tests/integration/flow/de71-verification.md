# de71 構造化 recovery command の実装・検証

対象は Definition が選択した既存 CLI 操作の値型、保存・復元、target を束縛した
next-action 投影、共通 registry 実行、canonical な進捗確認である。
最新ボード取得結果は `.tmp/de71/board.json`、開始情報は
`.tmp/de71/start.json` に保存した。

作業ブランチは `codex/de71-implementation`、worktree は
`.sennel/worktree/de71-implementation`。開始ブランチは `main`、開始 commit は
`63896e778d11fba9b94cdb07a6479e589663e78a`。
元 checkout の既存変更と他の worktree は変更していない。
実装・初回検証の時点では、実作業の Flow 開始、既存 Flow の復旧、board 更新、
commit、merge、push、公開は実施していない。テストの Git 操作と Flow は独立した
検証用 repository 内に限る。後続の commit・main 統合については末尾に記録する。

開始時の docs freshness は `stale`。`sennel docs build` を提案し、現行 source と
実行結果を判断根拠にした。生成 docs の同期は実施していない。

## 実装判断と利用経路

- 既存 `FlowExecutionCommand` を専用 module に移動し、Definition の通常 Step と
  `ExecuteCommandDirective` が同じ immutable 値を使う。command の表示は
  `toString()`、保存は `toJSON()`、復元は `fromStored()` が所有する。
  表示を再 parse せず、空文字を含む argv 要素を保持する。旧文字列 directive は拒否する。
- `FlowTargetBinding.guardArguments()` と既存 guard helper が target の束縛を所有する。
  dispatcher は投影済み args をそのまま唯一の core registry へ渡す。
  `agentWorkDir` は entry が明示的に宣言した場合だけ一度注入する。
  command module に registry を import すると Definition/registry の初期化循環になるため、
  登録存在の判定は実行境界と既存 source checker で行う。
- `FlowDispatchInvocation` は選択済み actionId と command 全体を照合する。
  Action は選択時の型付き directive を保持し、元の保存 JSON が変更されても
  実行する command が差し替わらない。
  実行直前に最新 next-action と canonical revision を読み戻す。
  実行後の継続は既存 `parentCommandProgress` に集約し、repository の変化だけを
  recovery の進捗として扱わない。通常 Step worker への fallback は置かない。
- revision の取得は既存の lock 内 `CanonicalTransitionView` を使い、active Attempt の
  ない claim frontier も同じ API で扱う。末尾の型付き dispatcher 承認 Activity と
  その confirmationOrder だけを execution revision から正規化する。
  それ以外の状態、非承認履歴、入力 descriptor は保持し、generic revision は変更しない。
  承認保存前後の検証は既存 `DispatchApprovalReceiptMutation` を上下の境界で再利用する。
  承認済み invocation は共通 registry の既存第4引数へ引き継ぎ、finalization の
  typed authorization 検証を維持する。保存済み Execution の承認情報は置き換えない。
- Draft Review の完全な publication intent 復元は既存
  `CanonicalDraftReviewObservation.commandResult(record)` に集約した。
  `settlementPublication(record)` と `RunReviewCommand` が同じ復元を再利用する。
  target、Attempt、generation、publication digest、receipt、process stop の検証は維持する。
- cleanup の Completion receipt は既存 `RunFinalizeCleanupCommand.projectCompletedReceipt`
  で投影する。dispatcher は認証された Completion と strict/advisory assurance を
  確認して終了し、削除済み worktree から next-action を取得しない。
  Execution Settlement、receipt 欠損、assurance 欠損だけでは完了しない。
- recovery の適格条件、retry budget、semantic 回数、route 優先順位、outbox key、
  receipt の消費回数、A10/A11 の登録済み実行経路は変更していない。
  RepairEvidenceDirective と手動案内は既存の責務を維持する。

利用者の追加設定は不要。従来の `sennel flow get next-action` が構造化 command を返し、
`sennel flow run dispatch` が選択された操作を実行する。新しい実行 registry、
host hook、agent 専用 lifecycle、外部依存は追加していない。

## 受入条件と検証境界

| 条件 | 正規 producer・保存・読み戻し・consumer | 検証 |
| --- | --- | --- |
| 1: 同一値の往復と argv 保持 | Definition/既存 next-action producer → command JSON → directive 復元 → actual `set.retry` registry → canonical retry receipt | `flow-execution-command.test.js`、`flow-target-binding.test.js`、`dispatcher-recovery-command.test.js`。日本語・空白・両引用符・改行は receipt まで保持。空文字は保持したまま既存 CLI の必須値検証で拒否し、canonical mutation なし |
| 2: 共通実行・worker 非起動・Review 再利用 | normal failure/retry producer → exhausted recovery → manager 再構築 → next-action → dispatcher/registry → 新 Attempt。retained Draft checkpoint、実 finalization outbox、正規 Review publication の応答喪失も再開 | `dispatcher-recovery-command.test.js`、`draft-checkpoint-restart.test.js`、`recovery-command-replay.test.js`、finalization の既存 scenario。Review の provider は初回一回のみ、artifact 内容と execution publication 一回性を保持。terminal evidence owner の移動も検証 |
| 3: run/set と runtime option | 共通 `runRegisteredFlowCommand` → `flowCommands[group][subcommand]` →既存 `dispatch`/pre/post hook | actual run Review/finalizer と set retry、entry 宣言、runtime 注入の構造負例。`set.retry` に `agentWorkDir` を付与しない |
| 4: stale/変更済み入力・権限の拒否 | 保存した invocation と最新 target、Attempt、入力、canonical revision を再照合 → registry admission | 変更 command/actionId/args、未登録 command、target 不一致、concurrent note、古い Attempt replay、明示承認の保存・再開。拒否前後の state/activity/catalog/Git を比較 |
| 5: blocked/await の維持 | 既存 Definition disposition と RetryRecoveryPlan の判断 → status/next-action →実 retry admission | `set-retry.test.js`、`get-next-action.test.js`、`task-review-reconciliation.test.js`、read-only recovery。semantic failure、uncertain stop、source integrity、baseline/receipt 不足、明示理由待ちを自動 reset しない |
| 6: 永続化・再構築・冪等性・停止 | 正規 producer → Store commit →応答喪失/fault → manager 再構築 → actual dispatcher →次の判断 | Review の exact replay、retained checkpoint、canonical 進捗なしの有限停止、real managed worktree cleanup、cleanup Execution/Completion と exact recovery、欠損 receipt/assurance、foreign receipt、完了後応答喪失 |
| 7: 構造違反の独立検出 | production constructors/registry/登録済み Step を既存 SourceRepository/parser/resolver で発見 | `recovery-command-contract.test.js` の文字列生成、args 破棄、guard/runtime option 重複、worker fallback、登録済み実行迂回の独立負例。各 source 復元後 green、文言だけの変更も green。A10/A11 は既存共通検査を再利用 |

## 同一テストによる修正前後比較

`recovery-command-replay.test.js` は normal Draft questions/coverage Review を実行し、
本物の publication commit が済んだ直後に応答喪失を注入する。
manager を破棄・再構築し、actual dispatcher と registered post が残りを確定する。
artifact や receipt の手書きで前提を作らない。

開始 commit の短命 detached worktree に同じテストだけをコピーして実行した。
2 ケースとも `DRAFT_REVIEW_ADMISSION_REFUSED` で失敗し、保存済み intent の
generation 接続契約違反を検出した。修正後は publication を重複せず次の Step へ進む。
`maxDispatches=1` の終了は既存契約に従って `FLOW_DISPATCH_LIMIT_REACHED` を期待し、
単なる `ok=true` を成功条件にしていない。
テスト SHA と比較ログは `.tmp/de71/baseline-comparison.json` および
`.tmp/de71/review-replay-verified-before.log`、`review-replay-verified-after.log`。
修正前 0/2、修正後 2/2、skip/cancel 0。比較用 worktree は検証終了後に削除した。

再開後の保存監査は、完了した Step の producer API や未認可の後続 consumer を
使わず、既存の lock-scoped `readCanonicalTransitionView` で行う。
source descriptor と bytes は完全一致、review.evidence の bytes・path・hash・size・
slot は完全一致である。evidence の `activityId` は、正規 terminal confirmation が
同じ bytes を引き継ぐため変わる。questions の `confirm_attempt`、coverage の
`complete_draft_completion`、元の Attempt binding、passed Result、coverage connector
の source/target を照合する。所有権移動を無検証で除外したり、product 契約を
変更して元の Activity のままにしたりしていない。

追加の command-selection 回帰では、capture 後に元の serialized command と表示を
同時に変更し、actual recovery registry に渡す。修正前は変更理由が受理され、
`Missing expected rejection` を検出した。修正後は選択時の immutable directive と
一致しないため拒否し、追加 receipt/Activity は残さない。
`.tmp/de71/dispatcher-selection-before.log`、`dispatcher-selection-after.log` に保存した。

## current producer と historical 境界

次の分岐では command 値、target guard、registry 接続、既存の拒否条件を移行した。
これらを current normal producer からの成功 scenario としては数えない。

- missing-producer recovery の Store は、producer の exact start/fail/record_failure
  履歴を持つ historical candidate を消費する。現在の public producer/consumer
  admission は、必要な出力を欠いたままの遷移を拒否する。
  既存の private runtime で構成した historical journal の成功を、現在の通常 producer
  の成功根拠に置き換えていない。
- generic Gate の retry/publication reconciliation/defer は既存の typed staged facts
  から選択できるが、現在の registered Draft/Spec/Task/Impl Gate は対応する専用
  StepResult/Settlement を原子的に保存し、generic publication fallback より前に返る。
  Spec Gate の通常 retry は新しい Step の投影であり、CLI reconciliation を挟まない。
  current Spec Gate の publication-only 不正状態は、reload 後も拒否される。
- `SETTLE_CANONICAL_FAILURE` と Task execution overrun はボードの明示した範囲に従い、
  current 正規 positive producer が未確認のため値型・接続の検査に限定する。
- `RESUME_DRAFT_REVIEW` の新しい選択 policy は作っていない。Draft Review の本物の
  producer/replay 検証は、既存の通常 Step と `run review --phase draft` 経路を使う。

この区別は、新しい producer や recovery policy を足して到達不能な成功を作らず、
実測した利用経路と source 上の接続だけを明示するためのもの。

`get-next-action.test.js` の finalization 前提と全 leaf 確定後の表示 case は
canonical decision fixture である。upstream の test/review/gate/retro/acceptance/
final-regression/report は registered producer を使うが、finalizer の fixture
confirmation は物理 Git/cleanup や Completion receipt の生成を実行しない。
この表示 case を、実 cleanup の証明には数えない。
物理 cleanup、main authority、finalized 状態、journal、Completion と assurance は
実 finalization scenario と registered persistence の結果で判定する。

## 測定記録

terminal 結果を以下に示す。異なる集合、初回失敗と再実行、基準版の結果を
合算して全体成功とは扱わない。最終の変更ファイルと SHA256、差分、対象集合と
ケース別 TAP 結果は `.tmp/de71/final-source-manifest.json`、`final-implementation.patch`、
`test-result-manifest.json` に保存する。

| 集合 | 結果 | ログ |
| --- | --- | --- |
| command 値・target binding・retry view | 17/17 pass、exit 0 | `.tmp/de71/command-values-final-tests.log` |
| next-action 全ファイル | 33/33 pass、exit 0、skip/cancel 0 | `.tmp/de71/get-next-action-final.log` |
| dispatcher owner・実 recovery・executable Step（最終 source） | 30/30 pass、exit 0、skip/cancel 0 | `.tmp/de71/dispatcher-latest-source.log` |
| actual registry の空 reason 拒否 | 1/1 pass、exit 0 | `.tmp/de71/dispatcher-empty-reason.log` |
| recovery source checker の本番・独立負例 | 28/28 pass、exit 0（最後の承認引継ぎ callsite 修正前） | `.tmp/de71/structure-focused.log` |
| 最終 production baseline と承認引継ぎ欠損の独立負例 | 2/2 pass、exit 0、skip/cancel 0 | `.tmp/de71/structure-authorization-focused.log` |
| actual cleanup Completion 応答の境界4種 | 4/4 pass、exit 0、skip/cancel 0 | `.tmp/de71/cleanup-response-proof.log` |
| 正規 Review publication の応答喪失・再開 | 2/2 pass、exit 0、skip/cancel 0。同一テストの基準版は2/2契約違反 | `.tmp/de71/review-replay-verified-after.log`、`review-replay-verified-before.log` |
| 実 managed worktree cleanup F07 | 1/1 pass、exit 0、skip/cancel 0 | `.tmp/de71/cleanup-dispatch-worktree-final.log` |
| 実 finalization 明示承認・保存・exact recovery・競合拒否 | 4/4 pass、exit 0、skip/cancel 0。同一 seed/test の修正前は正規再開2件が失敗、競合拒否2件が成功 | `.tmp/de71/dispatcher-approval-corrected-after.log`、`dispatcher-approval-corrected-before.log`、`dispatcher-approval-corrected-manifest.json` |
| `npm run test:structure` 全体 | 1007/1007 pass、exit 0、skip/cancel 0。専用 recovery checker の最終29件を含む | `.tmp/de71/structure-all.log` |
| Draft/Spec artifact scenario 初回 | 14 tests: 13 pass、1 fail、exit 1。全Spec7件とDraft6件は成功 | `.tmp/de71/phase-scenarios.log` |
| `npm run test:agent` | 14 tests: 11 pass、1 fail、1 cancelled、1 historical opt-in skip、exit 1 | `.tmp/de71/agent-regression.log` |
| 上記失敗 Task Review case の同一テスト再実行 | 1/1 pass、exit 0、skip/cancel 0 | `.tmp/de71/agent-task-review-rerun.log` |
| 上記 cancelled Spec worker case の同一テスト再実行 | 1/1 pass、exit 0、skip/cancel 0 | `.tmp/de71/agent-spec-worker-rerun.log` |
| Draft quoted findings case の同一テスト再実行 | 1/1 pass、exit 0、skip/cancel 0 | `.tmp/de71/draft-quoted-findings-rerun.log` |
| 関連 integration 拡張集合 | 269 tests: 211 pass、58 fail、exit 1、skip/cancel 0 | `.tmp/de71/related-integration.log` |
| process runtime 起動待ち失敗 case の同一テスト再実行 | 1/1 pass、exit 0、skip/cancel 0 | `.tmp/de71/process-runtime-startup-rerun.log` |

実 agent 初回の失敗は、Task Review 実行後の managed process 観測が
`PROCESS_EXECUTION_OBSERVATION_UNKNOWN` / `LINUX_PROCESS_STAT_INVALID` を返したもの。
後続 Spec worker は suite 固定 480 秒の期限で cancelled になった。
両ケースを元のテスト・期待値・期限のまま個別に再実行し、完走を確認した。
初回の失敗と cancellation はログに保持し、全 agent suite が初回 green だったとは
報告しない。historical opt-in skip は既存設定によるもので、新規 skip は追加していない。

実 worktree の初回 F07 は cleanup 前の observer setup で失敗した。
`flowDefinition` が `FLOW_COMMANDS` の hook を core `flowCommands` entry へコピーするため、
コピー元の post を mock しても実呼出しを観測できない。観測先を actual core entry に
訂正し、元の post をそのまま実行して main authority の受渡しを検証する。
authority の独立再取得や assertion の緩和で通していない。
再実行は既存 `registerFinalizationWorktreeContracts()` を呼ぶだけの検証用一時 entry で
同じ F07 body を実行する。無関係な branch seed は構築しないが、F07 自身の
real managed Prepare、Report、commit、merge、sync、cleanup の producer はすべて実行する。
初回ログは `.tmp/de71/cleanup-dispatch-worktree.log`、再実行は
`cleanup-dispatch-worktree-final.log`。一時 entry は削除し、source と SHA を
`worktree-cleanup-entry-evidence.json` に保存した。

承認の正規 fixture は、actual commit execute 後に registry の失敗経路が failed
outbox を保存した状態を使う。pending は ordinary-execute を選ぶため exact recovery
の前提にせず、Execution Settlement 後の outbox を done とも期待しない。
exact recovery 後の pending と元 Execution receipt 全体を確認し、別の通常承認・
registered dispatcher で完了する。同じ Git HEAD/key と worker/provider 非起動を照合する。
承認 receipt は再構築後も再利用し、note の競合が下位実行境界まで拒否される。
初期の不正な fixture 結果を受入成功に数えない。

関連 integration の58失敗は次の区分で確認した。

- 新規 Review replay 2件は上述の最終テストで成功。初期の保存監査 assertion の
  不正さは API の認可と正規 terminal publication を根拠に訂正した。
- process runtime 1件は provider 起動前の100秒待ちで失敗。同じ case の単独再実行
  は成功。初回の起動遅延の原因は断定しない。
- Review 12件は、同一テスト SHA を開始 commit で実行し、同じ case・assertion・
  エラー分類で全12件再現。基準版110件中98成功・12失敗。
  不完全な execution contract/producer fixture と CLI child bootstrap の既存不整合を
  含む。`.tmp/de71/review-fixture-baseline.json` に個別比較を保存した。
- Draft Gate 再公開1件は、開始 commit も同じ assertion で失敗。入力 producer 変更の
  admission refusal を先に返す既存契約に対し、後段の handoff error を期待している。
  期待値を変更して成功にはしていない。
- `set-retry.test.js` の32失敗は、開始 commit でも57件中25成功・32失敗。
  31件は同期 fixture が registered test-execute producer を省略した setup refusal。
  残り1件は Impl Review の `undefined` 対 `false` assertion で、別の既存失敗として
  記録した。根本原因を setup refusal と混同しない。
  個別比較と source/test SHA は `.tmp/de71/unchanged-fixture-baseline.json` に保存した。
- finalization read-only 10件は、shared scenario が integration Gate の file.map
  trust input を用意しないため対象 assertion 前に拒否される。開始 commit で
  pending projection と exact recovery の代表2件を実測し、同じ拒否を確認した。
  残り8件は同じ setup・stack の source trace であり、基準版の個別再測定はしていない。

既存 fixture を広範囲に直すことや product の admission を緩めることは行わない。
基準比較は新規回帰と既存失敗を区別する証拠であり、失敗した既存ケースの正常動作を
証明しない。current producer の retry、retained checkpoint、actual finalization
Completion/approval の受入根拠は、別に成功した正規 scenario に置く。

## 影響・残存境界・完了判断

旧文字列 ExecuteCommand の保存形式は受理しない。alpha 方針に従い migration や
互換 fallback は追加しない。外部依存、設定、retry 上限、semantic 回数、復旧 policy、
outbox/receipt key、authority/assurance の契約には変更がない。
生成 docs は stale のままで、全体 integration と agent suite の初回は green ではない。
未到達の historical branch と既存 fixture の検証不足は上記の範囲に限定して残る。

ボードが認める current 正規 producer の範囲で、受入条件1–7の実装・利用経路・
保存と再開・拒否・構造負例を確認した。de71 の実装と対象検証は完了。
全 repository の検証成功、historical 全経路の positive、既存 fixture の修復完了は
主張しない。レビュー用 worktree と必要な証跡を残し、不要な比較コピー・entry と
所有が確認できた検証 process を cleanup した。
承認比較の修正前3 source と同一テスト・driver は
`.tmp/de71/dispatch-regression-evidence/` に縮約して保持した。
`.tmp/de71/dispatch-cleanup.json`、`agent-orphan-cleanup.json`、`root-cleanup.json` に
削除対象・所有根拠・終了確認を記録した。既存ログや他作業の process は削除していない。

## ユーザー指示後の commit・main 統合確認

2026-10-15 の commit・main マージ指示に従い、レビュー済み33ファイルを
`064f51697`（`Execute selected Flow recovery commands through the shared registry`）
に保存した。その後 main の `766b75e21`（Draft answer admission と authenticated
worker replay の修正）を作業ブランチに取り込んだ。

競合は `RunDispatchCommand.captureAction` の1か所で、de71 の canonical revision
検証と main の retained worker repository fingerprint 再利用の両方を維持した。
統合後の限定検証はすべて exit 0、skip/cancel 0:

- command 値、実 registry recovery、Review publication 再開: 12/12 pass。
  `.tmp/de71/merge-recovery-tests.log`
- recovery 専用構造検査と独立負例: 29/29 pass。
  `.tmp/de71/merge-structure-tests.log`
- Draft artifact scenario と refine admission/replay: 30/30 pass。
  `.tmp/de71/merge-draft-tests.log`

初回の全体検証とは別の統合確認であり、フルテストの再実行はしていない。
main の既存832件の未コミット変更は対象外として保持する。
