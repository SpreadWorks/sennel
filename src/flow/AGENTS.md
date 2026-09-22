# Flow 状態遷移アーキテクチャ

このドキュメントを Flow 状態遷移の責務境界、不変条件、検証要件の正本とする。`src/flow/` と、Flow の状態遷移に関係する `src/lib/flow-manager.js`、`src/lib/flow-version.js`、および対応するテストに適用し、上位の `src/AGENTS.md` と併せて従うこと。

## 状態遷移方針の所有者

- **MUST:** definition layer は、永続化された現在状態からFlow全体の実行方針を決める責務を所有する。StepはServiceから受け取ったtyped factsを具体的な`StepResult`へ確定し、Definitionは`stepId + StepResult`だけからSettlementと次の遷移先を選ぶ。Definitionがfactsを別途受け取り、StepResultの意味を再判定してはならない。意味のあるfacts、disposition、transition planは専用クラスで表現する。
- **MUST:** retry、retry exhaustion、repair、defer、block、external block、Step status、次の route の選択を、実行コマンド、registry、状態読取り、`get-next-action` に重複実装しない。
- command の返却値に含まれる `next` や成果物内の `nextAction` は、必要であれば互換用の投影値として保持できるが、遷移判断の権限として使用してはならない。

## 実行と永続化

- `run-*` コマンドは、選択済み Action の実行、外部出力の境界検証、観測事実の保存を担う。Draftでは、StepのpureなResult factoryだけがtyped factsからsemantic Resultを決める。実行コマンドはsemantic resultからretry回数、上限、repair、次のrouteを独自に決めてはならない。
- transport、protocol、tooling failure の限定的な再試行は実行責務に含めてよい。ただし semantic retry budget と Flow の遷移方針は definition layer が所有する。
- registry、hook、永続化層は、definition layer が選んだ transition plan の原子的な適用と監査記録を担う。未選択の fallback route を決めてはならない。
- Step の境界は `facts -> concrete StepResult`、Definition の境界は `stepId + StepResult -> concrete Settlement` とする。Service は Definition を一度だけ呼び、Store は選択済み Settlement を再解決せずに適用する。
- Step と Step の間をつなぐ副作用は Definition-owned `StepConnector` として表現し、独立した Flow Step にしない。Draftでは、Definitionが`stepId + StepResult`からSettlementとConnector種別を選択し、Serviceが選択済みSettlementに必要なConnectorをcanonical factsから組み立てる。Storeは選択済みConnectorをsource Attemptの確認・成果物publication・次Stepへのpromotionと同一transactionで適用し、遷移先を再判断しない。
- Result、Result 固有の Activity／artifact、Settlement effect、exact binding を含む durable receipt、target activation／Await／Failure は同一 Store transaction で保存する。target connection だけが durable connector receipt を持ち、完全一致 replay 以外は binding、Result kind、Settlement kind、target、publication の差を conflict とする。
- 直接 CLI 実行にも admission check を設け、最新の永続状態で definition layer が別の Action を選んでいる場合は worker 起動と状態変更の前に拒否する。

## 状態と証拠の同一性

- **MUST:** canonical store を唯一の状態 authority とする。singleton、process memory、呼出し元が保持する古いオブジェクトを、遷移判断の正としてはならない。
- command boundary と dispatcher の再検証では最新状態を再読込みする。読取り処理は状態、成果物、時刻を変更してはならない。
- 判断に使う成果物は current Attempt の ID と sequence、および catalog publication と一致しなければならない。source artifact、canonical artifact、repair evidence、finding は lineage または fingerprint で同じ revision に結び付ける。
- Action identity と fingerprint には永続化済みの安定値だけを使う。`now()` のように読取りごとに変わる fallback を含めてはならない。必要な値がない場合は、安定した unavailable 状態として扱うか、安全側で拒否する。
- transition plan の適用層は、definition layer が選んだ方針だけを適用する。適用時に別の遷移を再判断してはならない。
- Flow finding の canonical identity は `sourceArtifact + sourceStep + sourceFindingId + fingerprint` の4項目とする。Storeと全consumerはこの完全なidentityで解決し、`sourceFindingId`または`fingerprint`だけで代替検索してはならない。同じsource上で同じ`sourceFindingId`を持ちfingerprintが異なるfindingは別identityとして保持する。

## Spec Step Result 契約

`StepResult` の型は `completed`、`branch-required`、`loop-required`、`user-input-required`、`error` の5種だけとする。表は後続Stepの意味上の分岐と担当境界を示し、初期`spec`の具体kindのみaa84で確定する。後続Stepの具体kind/class、registry entry、effects、direct/dispatch/recovery consumer、readback testは、production callerを移行する所有タスクで確定・追加する。将来のResultを先行登録・空実装してはならない。

| Step | producer / canonical storage | semantic Result contract | Definition Settlement / effect | next・stop・recovery・readback | production owner |
| --- | --- | --- | --- | --- | --- |
| `spec` | sealed worker handoff / `spec.record`、Step Result、settlement receipt | `spec-created: completed`、`spec-error: error` | `SpecNextRoute`が`SpecReviewConnector`を選択。publication、source Attempt確認、receipt、`spec-review`へのrouteを単一Store transactionで適用 | 完全一致replayだけ同じreceiptを返す。revision、publication、Result、bindingの差は適用前にconflict。再読込み後もResultから同じSettlementを復元 | aa84 |
| `spec-review` | canonical review work unit / review artifactとStep Result | 実行要求:`loop-required`、PASS／ADVISORY／REJECTEDの受理済みReview:`completed`、失敗:`error` | 実行継続、受理済みReviewはすべて`spec-triage`へのnext、failureをResultだけから選択 | stale work unitを拒否し、欠損publicationは明示的recoveryだけで整理。retryは同一review identityに拘束 | 9219 |
| `spec-triage` | sealed triage handoff / triage artifactとStep Result | triage完了:`completed`、失敗:`error` | `spec-repair`へのnextまたはfailure | findingは4項目identityでreadbackし、別revision・別fingerprintへのfallbackを禁止 | e363 |
| `spec-repair` | sealed repair handoff / repair audit、更新済み`spec.record`、Step Result | 変更あり:`completed`、変更なし:`completed`、失敗:`error` | 変更あり・変更なしとも`spec-gate`へnext、失敗はfailure | optimistic baseline差はpublication前に拒否。replayは同一operationとpublicationに限定 | e363 |
| `spec-gate`（`task-spec`と共有するGate phase） | canonical gate evaluation / gate result artifactとStep Result | pass:`completed`、carry-forward:`completed`、repair要求:`loop-required`、ユーザー判断待ち:`user-input-required`、失敗:`error` | pass/carry-forward、repair loop、Await、FailureをResultだけから選択 | `spec`と`task-spec`のblocking stop、nonblocking decision、retry exhaustion、gate publication recoveryはDefinition-owned。復旧実行はService／Storeが担い、再開時は保存済みResult・receipt・evidence identityを再読込みしてGateを再判定しない。publication-only reconcileは正規経路としない | b645 |

初期`spec`の候補は、handoffが検証した`spec.json`から既存の`CanonicalWorkerSpecPublication`へ型付けされる。`SpecStep`はその候補を採用して`SpecCreatedResult`を確定するだけでよく、Spec内容の加工やファイル選択は行わない。Serviceは採用候補・Result・bindingを同じAttemptのStore入力へ渡す。StoreのreceiptがResultとpublicationを一体で識別し、正規writerがruntime-owned Tasksの統合とrevision snapshotを保存する。意味上のError Resultと、admission拒否・保存失敗は別経路で扱う。

### Production caller ledger

| migration | production caller | Result / Settlement authority | Store application |
| --- | --- | --- | --- |
| aa84 | initial Spec worker handoff | `SpecStep` / `settleSpecStepResult` | initial Spec publicationと`spec-review` routeを原子的にcommit |
| 9219 | Spec Review executionとpublication | Spec Review専用Step / Definition | review execution、pass、findingのreceiptとrouteをcommit |
| e363 | Spec Triage / Repair worker handoff | Triage・Repair専用Step / Definition | finding identityに結び付くtriage・repair publicationとrouteをcommit |
| b645 | Spec Gate evaluation | Spec Gate専用Step / Definition | pass、repair、stop、retryの選択結果をcommit |
| 5c91 | 残存production caller監査 | 各所有Taskの保存済みResult / Definition readback | 未移行callerや重複判断を検出し、所有Taskへ差し戻す。Gate／recovery／nonblockingの実装を引き取らない |
| 6065 | end-to-end caller convergence | 全Spec Stepの保存済みResult / Definition readback | 旧caller判断を除去し、全経路の再開・回帰検証を完成 |

各行の移行までは既存production callerを維持するが、別のResult registry、別名のError Result、呼出し側独自のSettlement判断を追加してはならない。移行済みStepは単一の`STEP_RESULT_REGISTRY`、`StepErrorResult`、`StepBinding`、settlement receipt経路を共有し、後続Stepも所有タスクで同じ経路へ登録する。

### Historical Flow continuation

- historical import は `history.execution: "dormant"` として未承認の worker 実行・後続選択の継続権限を持たない。読取り、metric、note、dispatcher はその権限を与えてはならない。Definition が認可した新しい Attempt だけが、永続化された continuation boundary を伴う `"resumed"` にする。
- resumed Flow は boundary より後を通常の lifecycle、frontier、Attempt、outbox、finalization 不変条件で検証する。boundary 前の明示的な imported prefix に限り、`skipped`、Attempt sequence `0`、result なしの未実行 migration skip を保持できる。artifact 本文、Attempt、PASS 結果を補作してはならない。
- boundary や prefix が削除、再配置、変更され、または未認可の cursor が boundary 前へ戻る場合は fail closed とする。allowlist に記録した prefix leaf を正規 Attempt で再実行した後は通常の lifecycle 証拠で検証する。部分 journal は provenance として保存し、継続 authority の代替にしてはならない。

## `get-next-action` の責務

`get-next-action` は次の順序だけを担う。

1. 最新の canonical state と必要な canonical artifacts を読む。
2. definition layer に facts を渡して transition plan を得る。
3. 選択済み route 固有の前提条件を検証する。
4. transition plan を CLI の Action directive に投影する。

成果物の PASS、REJECTED、retry count、repair evidence などを独自に解釈し、definition layer と競合する遷移を選んではならない。

## 必須の検証

### 欠損した Task Review 証拠の明示的な整理

- `reconcile-task-review` は、baseline を欠いた未公表の復旧済み Task Review が tooling/provider failure で停止した場合だけ、Definition が許可する明示的な経路である。通常の retry や旧フォーマット互換処理として使用しない。
- 過去の baseline やゼロ副作用の主張を補作せず、現在の入力を未レビューとして採用する。旧 Activity と未完了 work unit を保持し、入力の記録・新 Attempt の baseline・一回限りの再評価を同一 canonical transaction で保存する。Review の成功や Gate への進行を代行しない。
- 対象 binding、preview digest、理由、既存 Review lease を適用前に検証し、catalog lock 内で状態・入力を再検証する。再開側は保存された採用入力と work unit の同一性を確認する。変更済み入力や別 Attempt への権限流用を認めない。

状態遷移を追加または移行する変更では、影響する範囲に応じて次を検証する。

- facts と disposition の状態表、および各 disposition から transition plan への対応
- stale context、旧 Attempt、Attempt sequence 不一致、source/canonical lineage 不一致
- semantic retry、tooling failure、retry exhaustion、部分完了、復旧、再ロード、冪等な再取得
- definition layer が別の route を選んだ状態で直接コマンドを呼び、worker、Activity、状態に副作用がないこと
- canonical state と artifacts の局所的な fixture から definition layer の判断、transition plan、Action 投影、適用結果を決定論的に検証すること。検証のために Flow、dispatcher、worker、agent を起動しない

既存テストが表す正当なシナリオを弱めて変更を通してはならない。

この責務境界から外れる必要がある場合は、例外をコード内だけに作らず、設計上の理由と維持する不変条件を同じ変更でこの文書に反映する。
