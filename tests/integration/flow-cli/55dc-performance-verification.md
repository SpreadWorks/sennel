# 55dc 実装・検証記録

**判定: ユーザー指定の例外付きで55dcのテスト高速化を完了。** ユーザーが既存製品不具合の6件をスキップし、製品修正を別セッションで行うよう指示した。現在の限定検証は303 PASS / 0 FAIL / 6 SKIP。主要2群の性能目標と追加19群の短縮を確認した。スキップした6件はPASS・製品修正済み・保証済みとして扱わない。

## 1. 実装方針と判断

各scenarioが正規producerで選ぶfrontierを共有し、immutable filesystem seedから独立rootを作る。Approval、Review claim、対象producer、保存、fresh readback、consumer、拒否、復旧は各caseに残した。歴史的receiptのID、absolute root、device/inode、processStopは書き換えない。

既存`SeedWorkRoot`、`CanonicalPersistenceSnapshot`、`CanonicalFlowFixture.fromExisting`、各phaseの`seed/fromSeed`を再利用した。共通の凍結・canonical readback・Git/non-Git確認・cleanupを、既存assertionモジュール内の`CanonicalScenarioSeed`に集約した。コピー失敗時の所有root回収も既存builderで行う。producer側のmock復元、physical runtime quiescence、空slot、command lease解放を確認してから凍結する。

内容matrixのCLIは既存registry、hooks、正規dispatcherをin-processで呼ぶ。実provider subprocessと代表CLIは残す。runnerの即時表示は表示改善であり、速度目標への寄与として計上しない。

## 2. 変更内容と作業場所

- ブランチ: `codex/55dc`
- worktree: `/home/nakano/workspace/sennel/.sennel/worktree/55dc`
- 開始commit: `199193954d15d6a4a962d7d2904282d0e0774750`
- 製品source hash: `82c0313929f0631b6d639a372b92a505a1cec27c7470f11d7d9b63fa08868f63`
- 変更は対象tests、既存support、coverage文書、`tests/run.js`。`src/`、package、依存、Flow、preset/skillは変更していない。commit、merge、push、ボード更新は行っていない。

| 群 | 通常ファイル実行の共通工程・起動回数 | 各caseに残す利用経路 |
| --- | --- | --- |
| Requirement | Spec生成/Review/GateからApproval直前: 全件復帰時88→1、今回の有効対象85→1 | Approval、生成、Review、repair、Gate、fault/refusal、receipt、次工程。複数batchの3件はユーザー指定でSKIP |
| nonblocking | ImplementationとGate exhaustion/defer: 13→1 | activation、decision、race、journal recovery。cloneの再初期化なし |
| canonical | test-execute前提: 2→1 | 実test-execute/result-review、publication、履歴consumer、原子的拒否 |
| Spec lifecycle | 初回strict stop: 2→1 | prefixのGate4回/repair3回、cloneの持越し・Draft再生成・新cycle |
| Spec repair | ファイル別失敗Gate前提: 34→3 | request、claim、seal、fault、保存/reload/replay、non-Git authority |
| Task Gate | implementationとPASS Review: 6→1 | Gate、repair、source drift、再評価、拒否/readback |
| Task Review | 未claim implementation: 26→2 | activation、baseline、claim、worker、checkpoint、復旧 |
| Report | unlinked/linkedのReport直前: 7→2 | preview、delivery、保存fault、response loss、receipt replay、commit拒否 |
| orphan cleanup | commit/squash/sync/orphan前提: 11→1 | 各rootの新claim、audit、dirtiness、retry/rescue、CAS、teardown |
| Service audit | Acceptance 6→1、Impl 13→1、Requirement 3→1 | 全leaf/all-five/all-twelveの実create/consume/projectとfresh readback |
| Finalization Service | Report直前5→1と4派生leaf | 正規advance、direct/dispatch、pending Report拒否 |
| Spec prepared | 全registration prepare 2巡→1巡 | 旧2caseのconstructor、typed arguments、dependenciesの全assertion |
| CLI | 全件復帰時Gate 12→3、今回Gate 10→3。i18n 6→2、test-mode 4→1。今回合計20→6 | 全件復帰時16、今回14呼出しを正規dispatcherへ。代表CLI3件とproviderの物理境界を保持 |

これらは入力/frontier別の静的回数。異なる区間を足して全suiteの短縮率へ換算しない。正規bootstrapを必要とするPrompt旧fixtureを両側訂正したため、有効baselineの削減起動は`src/sennel.js` bootstrap/runtime captureを含む。bootstrap単独時間は未分離。スキップ2件によるGate起動減を高速化の効果に足さず、before/afterとも同じ2件を除外する。

## 3. 性能の受入結果

Node `v22.22.0`、jobs `1`。各before/afterは同じ選択・source・storageで直列実行し、temporary-root作成と所有scope cleanupを含むwall timeを比較した。負荷は各JSONに記録しており、完全な無負荷は保証しない。

| 主要群・storage | PASS before→after | before秒 | after秒 | 短縮率 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| Requirement `/tmp` | 3→3 | 133.987 | 96.689 | 27.84% | 30%未達、記録を保持 |
| Requirement `/dev/shm` controlled | 3→3 | 68.252 | 42.602 | 37.58% | この条件で30%達成 |
| nonblocking `/tmp` | 3→3 | 536.731 | 202.949 | 62.19% | この条件で30%達成 |

Requirementの具体的な未達を受け、同じ固定3caseを両側とも`/dev/shm`で比較した。storageを跨いだ比較ではなく、`/tmp`未達を取り消す結果でもない。初回高負荷beforeと途中の失敗afterは判定から除外して保存した。

追加群はすべて`/dev/shm`、jobs 1。下表の先行18比較は両側で期待数PASS、fail/cancel/skip 0。CLI Gateはユーザー指定の同じ2件を両側でSKIPし、他の11件が両側PASS、fail/cancel 0。

| 群 | PASS before→after | before秒 | after秒 | 短縮率 |
| --- | ---: | ---: | ---: | ---: |
| canonical | 2→2 | 7.471 | 6.612 | 11.50% |
| Spec lifecycle | 2→2 | 463.941 | 379.607 | 18.18% |
| Spec repair restart | 2→2 | 18.860 | 17.991 | 4.60% |
| Spec repair durability | 2→2 | 10.711 | 9.612 | 10.27% |
| Spec repair replay | 2→2 | 12.643 | 10.860 | 14.11% |
| Task Gate | 2→2 | 41.142 | 33.123 | 19.49% |
| Task Review causal | 2→2 | 12.810 | 9.306 | 27.35% |
| Task Review checkpoint | 2→2 | 19.423 | 15.947 | 17.90% |
| Report unlinked | 2→2 | 308.330 | 158.884 | 48.47% |
| Report linked | 2→2 | 320.023 | 165.164 | 48.39% |
| orphan cleanup | 2→2 | 229.073 | 204.687 | 10.65% |
| Acceptance Service | 2→2 | 267.781 | 147.861 | 44.78% |
| Impl Service | 2→2 | 90.472 | 66.137 | 26.90% |
| Requirement Service | 2→2 | 36.315 | 24.382 | 32.86% |
| Finalization Service | 6→6 | 368.628 | 220.136 | 40.28% |
| Spec prepared全assertion | 2→1 | 24.415 | 13.619 | 44.22% |
| CLI i18n | 7→7 | 14.042 | 6.319 | 55.00% |
| CLI test-mode | 4→4 | 9.773 | 4.263 | 56.39% |
| CLI Gate、同じ2件をSKIP | 11→11 | 206.779 | 180.628 | 12.65% |

CLI Gateは19群目として、今回実行する11件で短縮を確認した。旧13件比較の両側8 PASS / 5 FAILは性能実績へ算入しない。旧観測API3件は両側で訂正済み。新比較は[同じSKIPのmanifest](../../../.tmp/55dc/cli-authorized-skip-comparison.json)、cli-gate-before/after-quiet-authorized-skip JSON/logを使い、別subsetのcase durationは足していない。Finalization Serviceの6件は親2＋子4であり、6producerの意味ではない。

SKIP後の初回比較は両側11 PASS / 2 SKIPだったが、258.839秒→420.058秒で短縮しなかった。その間、2 CPUで5分平均負荷が4.39→9.53へ上がったため、結果を保持して同じ11件を一度再比較した。有効な再比較はbeforeの負荷が開始`[0.22,3.61,4.90]`/終了`[2.30,3.17,4.48]`、afterが開始`[2.30,3.17,4.48]`/終了`[2.13,2.84,4.12]`。無負荷の保証や環境全般への保証ではない。初回未達はcli-gate-before/after-authorized-skip JSON/logに残す。

## 4. 限定検証と証跡

固定afterの成功caseをcorrectnessに算入し、残りは同名caseを除外した17選択・期待235件で実行した。全17選択が終了し、初回raw集計は227 PASS / 8 FAIL、cancel/skip 0。手動Acceptance deferredの1 FAILはimport段階のfile wrapperで、実case実行は234件だった。修正後の個別結果は下記。親・子・wrapper・再実行を独立caseとして重複計上しない。

| 修正後の限定確認 | 結果 | wall time・証跡 |
| --- | --- | --- |
| SAV-08 before/after-commit | 2 PASS | 37.397秒、requirement-sav08-response-recovery-after-corrected。実runner1回、rollback、support promotion、receipt、後続consumerを保持 |
| CLI terminal agent failure/no agent | before/afterとも2件PASS | cli-three-migrated-before/after-assertions-fixedの対象2件。stale1件が失敗したため群全体の時間差は性能へ算入しない |
| 手動Acceptance deferred | 1 PASS | 1006.358秒、manual-acceptance-deferred-seed-after-corrected。実行直前cache不在、8回の正規Review、clone readback、保存応答によるrepair再開を確認 |
| NB Version transaction/tooling | 1 PASS | 208.273秒、nonblocking-tooling-diagnostic-after-corrected。親子configを揃え、実Review childと全advisory effectの再検証を保持 |
| CLI stale Gate履歴 | before/afterとも1 PASS | 23.937/22.079秒、cli-stale-history-before/after-consumer-fixed。巻戻し後のActivity、typed Result、正規receipt、次Attemptを確認 |
| Spec Gate publication/query | before/afterとも1 PASS | 5.138/5.243秒、spec-preparation-query-consumer-before/after-consumer-fixed。保存された全criteriaの値、order、sourceを確認。性能比較群ではない |
| Spec Gate failed history/query | before/afterとも1 PASS | 11.918/12.254秒、spec-preparation-failed-history-consumer-before/after-repair-history。実FAIL→bounded repair→Review→実PASSの保存、fresh reader、履歴identityを確認。性能比較群ではない |

ユーザーのSKIP指定前は[元の集計](../../../.tmp/55dc/final-correctness-before-user-skips.json)の**303 PASS / 6 FAIL、期待309 records**。その失敗証跡は保持している。今回の最終集計は[例外付き集計](../../../.tmp/55dc/final-correctness-authorized-skips.json)の**303 PASS / 0 FAIL / 6 SKIP**。内訳は主要固定6、support8、追加性能群46、CLI Gate13、remainder235、共通fixtureの追加consumer1。親testと子testを含むNode test record数であり、309の独立producerを意味しない。failed import wrapper、選択なしwrapper、baseline、旧失敗版、重複rerunは除外した。先行成功結果を再利用し、CLI Gateは新しい11 PASS / 2 SKIPの比較で更新した。remainderは231 PASS / 4 SKIP。cancelは0。

[6件の限定選択](../../../.tmp/55dc/authorized-skip-selection.json)で、実際に対象6件だけがSKIP、PASS/FAIL/cancelが0、seed telemetryが0件であることを確認した。assertionとtest bodyは保持し、内部の判定・保存・証跡を偽造していない。この例外は最新のユーザー指示に基づき、55dc本文とtests規則の通常のskip禁止より優先した。残る製品修正は[55dc-product-defects.md](55dc-product-defects.md)で別セッションへ引き継ぐ。

追加consumerの旧「empty observationsによるsemantic retry」は実producerで作れなかった。Specの実semantic FAILはblocking observationsを生成し、正規factsがrepairを選ぶ。空observationsはPASSになる。sourceに基づく不正scenario訂正として、既存Gate repair/Review/worker helperを使うbounded repairへ直した。失敗と次PASSのAttempt ID、sequence+1、catalog owner、`[fail, pass]` history、query/native result、source pointer/reference分離の保証は保持し、最初の失敗Activityの不変確認も加えた。shared Spec preparationのdefault healthy経路は変更していない。[根拠と対応](../../../.tmp/55dc/query-gate-bounded-repair-notes.md)を参照。

手動deferred検証が作った永続descriptorとseed rootは、境界descriptorを証跡へ保存した後で回収した。以前から存在するcacheは利用していない。baselineと回帰比較のdetached worktreeも、patchと追加テスト入力を保存して回収した。今回の再比較baselineの差分はbaseline-authorized-skip-comparison.patchに保存した。レビュー用`codex/55dc` worktree、測定manifest、JSON、TAP logと必要な再現patchは残した。

support契約8件は全PASS。隔離コピーで修正を外した同一入力/期待値の比較では、copy失敗回収1件とrunner2件がFAILし、修正後8件に含む対応3件がPASSした。runnerはUTF-8分割、即時forwardとcapture、二重表示防止、closeだけでterminal recordを確定すること、error→closeを検証した。

選択なし20ファイルはseed telemetry 0件で、新しい遅延seedを生成しなかった。raw20 PASSはwrapperであり、scenario成功数は0件。既存の通常suite before hookの費用は、新しいseedの遅延生成と区別する。

証跡はworktreeの[`.tmp/55dc`](../../../.tmp/55dc)に残す。[固定選択](../../../.tmp/55dc/main-comparison.json)、[追加比較](../../../.tmp/55dc/additional-comparison.json)、[残り選択](../../../.tmp/55dc/correctness-remainders.json)、[性能JSON](../../../.tmp/55dc/verification.json)、[区間時計](../../../.tmp/55dc/timing-spans.json)、対応する各TAP log/JSONを参照する。各測定JSONがHEAD、source/test hash、選択、Node、jobs、storage、load、wall time、終了値と件数を保持する。

235件manifestは開始時のtests全体hashを一度採取した。実行中、後続選択の依存に触れないCLI観測訂正とNB診断追加が行われたため、このhashで全選択が同一凍結tests treeだったとは証明しない。記録は上書きせずpatch/順序を保持した。その後の測定は選択開始ごとにhashを採取する。

## 5. 既存機能・後続への影響

製品遷移、provider方針、receipt、fsync、保存/readback、retry予算、repair回数、timeoutを変更していない。各cloneが新しいphysical/effect claimを正規生成し、過去inventoryを現在rootのauthorityに使わない。Service登録の確認は重い生成前に維持し、observerを対象producer前に作る。

旧fixtureの正規経路不足は根拠を確認して訂正した。CLIのTask/Review/Gateは既存`activateWithProducers`を使用し、Promptは既存bootstrapを使う。Spec preparedは実Gateと正規Task strategyを生成する。NBの親/子configを同じ初期化経路へ揃える。queryのJSON値はdeep equality、criteriaは保存された完全な値と比較する。SAV-08は実Gate応答を保持してpostを再開し、uncertain claimによる再実行拒否も確認する。応答を失ったprocess crashの保証へ読み替えない。

## 6. 未達・制限・再開条件

旧コードでも同じ正規producerと期待値で再現した製品不具合は次の3種類。ユーザーが6件のSKIPと別セッションでの製品修正を指示したため、確認待ちではなく、明示された引き継ぎ対象である。正当なassertionとbody、元の失敗結果を保持し、claim削除や偽receiptは使わない。製品の`src/`は変更していない。

| 不足契約 | 対象件数 | 保存した具体案・比較 |
| --- | ---: | --- |
| Task Gate PASSのDefinition reset effectをcounterへ保存する経路 | 2 | [counter計画](../../../.tmp/55dc/counter-effect-gap.md)、CLI Gate before/after-repaired |
| 同一AttemptのRequirement repair次batchが新しいexecution generationを持つ契約 | 3 | [batch計画](../../../.tmp/55dc/requirement-batch-execution-gap.md)、requirement-failure-baseline-before-failure |
| Draft回答後のstep-selection-requiredをworker admissionが尊重する契約 | 1 | [Draft計画](../../../.tmp/55dc/manual-acceptance-correction-gap.md)、manual-acceptance-correction-baseline-before-gap |

共有prefix/コピー/readback/cleanupのmonotonic補助時計を記録した。本体と保存だけ、frontend bootstrapだけの時間は未分離。case durationは準備・本体・保存/readback・case teardownを含み、親は子を含む。入れ子区間や残差を足して独立費用としない。

Requirement controlled afterのprefixは13.389秒、copy4回合計0.010秒、clone readback3回合計0.434秒。NB afterはprefix170.914秒、copy4回合計0.035秒、clone readback3回合計3.404秒。固定subsetとremainderの分割でseedは別々に生成される。これは通常ファイル実行の88→1/13→1とは異なる限定検証の追加費用で、各wall timeに含む。

`npm test`、`test:all`、全integration、旧404件は実行していない。過去6時間20分・69分の全体短縮率は未確認。docs freshnessはstaleで、生成を提案した上で現行sourceを正とした。

## 7. 最終判定

ユーザー指定の6件のSKIPを例外として、55dcのテスト高速化は完了。主要2群の30%条件は表記storageで達成し、CLI Gateを含む追加19群も短縮を確認した。303 PASS / 0 FAIL / 6 SKIPで、fixtureと観測APIの訂正確認も終了した。構文42ファイルと差分の最終検査は通過し、所有した比較worktreeを回収した。レビュー用worktreeと証跡は残した。製品不具合3種類の修正とスキップ6件の保証は別セッションへ引き継ぎ、製品修正済みや全原条件の保証済みとはしない。
