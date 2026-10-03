# fc21 共通検査契約の受け入れ証跡

対象: board `fc21`、親 `67fd`、各工程 `f72f` / `8e30` / `3a50` / `6af5` / `5ab3`。
基点 HEAD: `c6a8bb26d18e0034f62e6a523fdda562ff6f7876`。
作業 branch: `test/fc21-phase-contracts`。
作業 worktree: `.sennel/worktree/fc21-phase-contracts`。

以下は共通契約の導入時点の証跡である。再レビュー後の修正・測定・現行ファイルhashは末尾の追補に記録する。導入時の「重大findingなし」という判定とhashを、修正後の候補に対する判定として再利用しない。

## 実装方針と責務

既存の StructureScope、StructureChecker、ProductionRegistrations、SourceModule / SourceOriginUsage、ServiceBoundaryCoverage を拡張した。判定 callback、class allowlist、実行用の第2 registry、違反 baseline、runner skip は追加していない。`src/`、依存、Flow 状態、共有 main worktree の既存変更は変更していない。

固定 manifest は検査対象の責任集合であり、実行登録・状態正本ではない。runtime 登録は本番 composition の StepRegistration を使う。全 registry の型・重複・依存検査は `ProductionRegistrations.inspect()` に集約し、loader は例外へ、checker は規則・位置・trace 付き診断へ変換する。entry との対応検査は静的 source と runtime identity の照合を担う。

新 fixture は既存 SyntheticStructureSeed を使い、reader / rules を複製しない。構造 suite は live Service を生成しない。integration の canonical fixture から各登録の create() を呼び、PreparedStep、実 Service、constructor 引数を検査する。

## 固定 scope と導入状況

`tests/support/structure/phase-manifest.js` と実 Definition の collectFlowLeafIds / collectTaskLeafIds を照合する。現行44 leaf = Draft10 + Spec6 + 未来28。03は同一受け入れフェーズの Flow7 / Task5 という2 entryであり、別Specに分割しない。Task nodeId は TaskStepIdentity の canonical 変換を使う。

| 工程 | board | entry / composition / export | 固定責任 leaf | 現時点 |
| --- | --- | --- | --- | --- |
| Draft | 既存 | steps/draft / composition/draft.js / draftStepRegistrations | draft, draft-questions-review, draft-questions-triage, draft-questions-repair, draft-refine, draft-gate-repair, draft-coverage-review, draft-coverage-triage, draft-coverage-repair, draft-gate | 全10登録・実DI・構造対象 |
| Spec | 既存 | steps/spec / composition/spec.js / specStepRegistrations | spec, spec-review, spec-triage, spec-repair, spec-gate, spec-gate-repair | 全6登録・実DI・構造対象 |
| 01 | f72f | steps/prepare / composition/prepare.js / prepareStepRegistrations | branch, prepare-spec | 2登録未導入 |
| 02 | 8e30 | steps/test / composition/test.js / requirementTestStepRegistrations | approval, test-generate, test-review, test-repair, test-gate | 5登録とResult拡張未導入 |
| 03 Flow | 3a50 | steps/impl / composition/impl.js / implStepRegistrations | implement, test-execute, test-result-review, impl-review, impl-triage, impl-repair, impl-gate | 7登録未導入 |
| 03 Task | 3a50 | steps/task / composition/task.js / taskStepRegistrations | task-impl, task-review, task-triage, task-repair, task-gate | 5登録未導入 |
| 04 | 6af5 | steps/acceptance / composition/acceptance.js / acceptanceStepRegistrations | retro, acceptance-review, acceptance-decision, final-regression, report | 5登録未導入 |
| 05 | 5ab3 | steps/finalize / composition/finalization.js / finalizationStepRegistrations | finalize-commit, finalize-merge, finalize-sync, finalize-cleanup | 4登録未導入 |

パスの省略 prefix は `src/flow/`（composition は engine/composition）。03のexport名はboardに明示されていないため、既存の命名規則に合わせて本契約で固定した。01/02/04/05の名前と配置は各boardの明示内容に従う。

未来 scope は現時点の実 source / 本番登録から責任欠損の A01 を leaf ごとに検出する。これは欠損検出テストの合格であり、未来工程の構造・DI・シナリオ合格ではない。導入時にはこの初期検出を所有工程の正規 production scope に更新し、Draft / Spec と先行導入済み工程の全 scope を必須にする。未来 scope を現在の Draft / Spec 合格から除外する runner 制御は加えていない。

## caller・保存・再開の対応台帳

| 対象 | 現在の実経路・正本 | fc21 の検査 / 後続所有者 |
| --- | --- | --- |
| Draft / Spec worker | engine/composition/{draft,spec,registered-step-execution}.js → lib/get-next-action.js / lib/run-dispatch.js → worker-execution-admission.js → worker-artifact-handoff | lookup全Step coverage、named select/project/execute、選択の保持、単独Step除外・早期実行拒否。全16登録のcreate()実DI。既存完全入力・receipt回帰 |
| Draft / Spec Review / Gate | get-next-action / run-review / run-gate / registry.js post、execution-admission.js、Definition → SettlementWriter → canonical Store | 正規表示・直接実行・post・loader・admissionの既存具体shape。Service/input/helper/getter/aliasのIO、manager読取・member escape、許可外saveをA08/A12拒否 |
| 01 準備 | lib/set-init.js / registry.prepare / lib/run-prepare-spec.js、PreparingFlowStore → createFresh → canonical Version、claim / display / dispatch / recovery | branch/prepare-spec固定欠損検出。準備runId・journal由来idのStepBinding偽装拒否を実canonical生成・reloadで検証。実績採用、Git/worktree中断・rollback、Draft接続シナリオはf72f |
| 02 承認・テスト | lib/set-approval.js / requirement-test lifecycle・ArtifactStore / worker handoff / run-review・registry post / run-requirement-test-gate.js | approvalを含む全5固定責務。Result初期赤は下記専用契約。Plan→候補→Review→bounded repair→Gate・promotion・resume・exact receiptは8e30 |
| 03 実装 | Task loop / worker handoff / run-test-execute.js / run-test-result-review.js / run-review・repair・Gate、canonical Test Store | Flow7+Task5全責務、固定roleとmaterialized nodeId。typed Task Resultとexact receipt、producer→保存→reload→consumer、統合テスト・修復・Gateは3a50。同じResult codecを再利用 |
| 04 受け入れ・報告 | lib/run-retro.js / run-acceptance-review.js / set-acceptance-decision.js / run-final-regression.js / run-report.js、canonical Test / Acceptance / Report Store、outbox | Retroは04所属。集約・判断・回帰・reportの5固定責務。未移行callerを正規経路へ戻す検査を使い、外部effect停止・安定Action・回復は6af5 |
| 05 最終化 | lib/run-finalize*.js / recover-interrupted-finalize-sync.js、Git transaction、finalize-cleanup状態・正本 | 4固定責務。commit/merge/sync/cleanup・失敗後再開・outbox identity・後続接続は5ab3 |

NamedExecutionShape / ExecutionCaller / ExecutionLoader は worker、command、user-decision、prepare-adoption、host-one-shot、deterministic、aggregate を名前で宣言し、Step suffix から形態を決めない。fixture の display/direct/dispatch/post/recovery は同じ registration と selection を使う。post/recovery は渡された selection を消費し、明示receipt replayだけが選択前のreturnを持つ。宣言の欠損、違うadapter、未登録loader・namespace・alias・export capability escapeは拒否する。この共通宣言への本番移行は01以降の所有工程であり、未来callerの移行合格は主張しない。

保存許可操作は既存Draft/Specの共通save-operation検査の列挙を維持する。新save APIは導入していない。所有工程が拡張する際も操作名と責務を共通検査へ登録し、prefix許可には変更しない。Store内の整合性確認はServiceからのIO許可と区別する。

## 修正前後の問題検出

| 同一条件 | 修正前の測定 | 修正後の保証 |
| --- | --- | --- |
| spec-triageを準備しspec-repairを省略（同一Service） | 元ServiceBoundaryCoverageは例外を出さず回帰assert失敗 | A07が未準備registrationを示す。spec-repairを実create()後、全準備合格 |
| 全registryのnull / {} member | nullで意図しないTypeError、{}はA01 | 同一共通検査で型違反のA01。registry snapshotはfreeze |
| lookup Map元をregistrations[0]だけにする | 独立probeでok=true | A10、完全登録集合への対応を検査、元へ復旧すると合格 |
| 未登録namespace lookup / local alias lookup | 独立probe各ok=true | A11、SourceOriginUsageで元importからalias/member/escapeを追跡、復旧合格 |
| constructor(a,b)内で別のinput/writerをnewして型guard | 独立probeでok=true | A12、constructor実引数の位置とguardを対応、合法renameは合格 |
| guard前の配列/オブジェクト分割代入で実引数を置換 | 同じ負例でA12診断がなくassert失敗 | A12、未解決operand provenanceを受理せず、独立baseline→拒否→復旧合格 |
| 準備中runId / 偽journal Attempt identity | 正規準備stateにcanonical Version/Attemptがない | missing Version authorityでread拒否、canonical StepBinding偽装拒否、canonical生成・reload後は実Attemptだけ合格。拒否後stateは不変 |

準備中のcanonicalState()がnullを返すという初稿fixtureの期待は現実と違い、実APIはVersion authority欠損を先に拒否する。実コードに基づきこの厳しい拒否をassertするようfixtureを訂正した。製品の拒否を緩めていない。初稿shared 91/92は完了証拠に使わず、最終candidateを再実行する。

導入時の独立検証担当が上記lookup・invariantの漏れを再現し、その候補で解消を確認した。導入時の独立判定はfc21範囲で重大findingなしだったが、後の再レビューで下記追補の2件が見つかったため、現行候補の判定は追補の検証結果による。管理者も主要差分、共通API集約、主要試験・保存回帰を直接確認した。

## Result 初期検出と所有工程への引き継ぎ

`tests/unit/structured-step-result-contract.test.js` は実在するengine/Definitionをnamespace importし、missing APIをAssertionErrorで検出する。syntax/import失敗、future module import、synthetic Result、skipで赤を作っていない。17ケースのうち現在2 pass / 15 expected fail / 0 skip。

未導入engine export: RequirementTestResultBinding、RequirementTestResultFrontier、RequirementTestRetryState、TestGenerateCandidateSavedResult、TestGenerateStructuralRejectedResult。未導入Definition export: settleRequirementTestStepResult(stepId, result)。02の生成2 concrete kindから共通codec拡張を固定する。

| 契約 | 固定したassert | 現時点の証明限界 |
| --- | --- | --- |
| Binding | run/spec/leaf/Attempt、plan publication、R、SpecRevision、status、candidate lineageを専用値codecで保存・復元 | export欠損を検出。実拡張のroundtripは02で初めて検証可能 |
| Frontier / Retry | 残staged/pending Rの順序・identity・statusのみ、既存Budget3counter・auto/manual・計上済finding | whole plan/expectationや任意factsの持込を禁止。現段階では必須値class欠損 |
| Candidate Result | candidate-saved:completed / structural-rejected:branch-required、単一registryのclass/kind/type/stepId厳密一致 | 2 concrete classがないため詳細assertはまだ実行到達しない |
| 保存codec拒否 | identity、kind/type/stepId/class/schema改変、欠損/余分/untyped operand、target/ctx/manager/connector/effect/payload拒否 | redが示すのは前提API欠損。各拒否ケースの製品実装合格を意味しない |
| digest / Settlement | frontier順、lineage/bytes hash、mode/counterをdigestへ反映。保存Resultだけから同じtest-review Settlementへ、追加factsなし | 将来assert固定。exact durable receipt / 不一致replay / Task operandsは02・03のシナリオが所有 |
| 既存codec | kind/typeだけの普通ResultとError code/data保持、payload拒否、既存candidate manifestはbytesを保存しない | 実APIで現在pass |

この初期赤は02導入までは01の必須scopeへ混ぜない。既存のデフォルトunit discoveryも変更していないため、全体npm testではこの意図した赤が残る。02はapprovalを含む全5 leafと本Result契約を同じ工程で緑にし、既存Draft/Spec digest/receipt回帰を実行する。

## 検証コマンド

共有checker（boardの7ファイルに固定manifestのintegrationを追加）:

```sh
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/integration/structure-phase-manifest.test.js
```

別集計のResult初期検出:

```sh
node --test tests/unit/structured-step-result-contract.test.js
```

現在scope・実DI・既存回帰:

```sh
npm run test:structure
node --test tests/integration/flow/service-boundary-coverage.test.js tests/integration/flow/spec-service-boundary-coverage.test.js
node --test tests/integration/structure-phase-manifest.test.js tests/unit/structure-rules.test.js
node --test tests/unit/flow-engine-step-result.test.js tests/unit/draft-step-binding.test.js
node --test tests/integration/flow/review-whole-file-input.test.js tests/integration/flow/run-review-execution-admission.test.js
node --test --test-name-pattern='references complete large worker inputs|runs the bound Draft Step through the existing handoff|reads back the exact initial Spec receipt|rolls back changed Spec Repair Result and Review' tests/integration/flow/worker-artifact-handoff.test.js
git diff --check
```

全repository / 実AIは本項目の要件ではない。対象製品コードを変更していないためDraft/Specの製品変更時に要求される全工程シナリオ・agent試験は追加実行していない。既存handoffは上記4契約だけの選択実行であり、ファイル全体合格とは扱わない。構造aggregateと直接sharedに重なるケースはboard指定の別集計であり、合格数を合算しない。

docs freshnessはstale。docs buildを提案済みで、本変更では生成docsを再生成していない。仕様の照合はsourceとboardを根拠にした。

## 検証の限界と最終判定

静的検査は認識できる閉じたsource形を検査し、未知形をfail closedにする。任意JavaScript全動作、Git/OS transaction成功、実provider品質、cleanup中断や外部effect途中停止の全producer→Store→reload→consumerを証明しない。未来28登録・具体実行宣言・専用Result製品実装とその工程シナリオは上の所有boardへ引き継ぐ。

fc21の完了は共通checkerと未達検出契約の完成であり、未来工程の実装受け入れではない。最終試験結果・ケース別結果・固定ファイルhashを以下に保存し、生テストログはユーザーの完了条件に従い削除する。

## 導入時候補の測定結果

| 検証 | tests | pass | fail | skip | exit | 生ログSHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 共有checker + 固定manifest | 92 | 92 | 0 | 0 | 0 | bf7e2645e595cb275d157af4eace9e523df106a1a6e8e3888e230ec9910ac8ae |
| 構造aggregate（Draft / Spec含む） | 75 | 75 | 0 | 0 | 0 | 77cecb0bd839877f5d1b90889190fcb519bd3cf533723db5567a39b34d5075fa |
| Draft / Spec 全登録実DI | 9 | 9 | 0 | 0 | 0 | bf82a0603e61309d095cb362d2c72401d627c59078cadfd28cae662e89a7b1ff |
| manifest / identity + 既存structure unit | 9 | 9 | 0 | 0 | 0 | f695713961fbf25d7e12d87d592a6bb05f712df14ea9821303a7dff29233feb0 |
| 既存Result / Binding | 8 | 8 | 0 | 0 | 0 | b053056462bfd805b83c3db1ee0ef08d6b8b2b7dffb9309f4ef1e216ef9b35b3 |
| 既存whole-file Review / admission | 13 | 13 | 0 | 0 | 0 | 75418375b7cd3506adff8aaa5e0056b926c01ab42a4c9539910bdba4a6e7b210 |
| 既存handoff選択4契約 | 4 | 4 | 0 | 0 | 0 | 4cbd86d78afce67a94ba27ed07c6b5745c5efa2e6fa8d1ba970513c23fa4e290 |
| 02 Result初期検出（expected red） | 17 | 2 | 15 | 0 | 1 | 9e624c6a97afbe6f361cf5abe0d257eb8078524f65ed752a43caf3482e39f1f1 |

Resultの15 failureはすべて必須class / Definition API欠損のAssertionError。syntax / import errorは0。共有checkerとaggregateは重複を含むため合算しない。関連ファイルを修正した検証は最終候補で再実行し、同じhashの未変更DI / 既存回帰は再利用した。

### ケース別結果

#### 共有checker + 固定manifest

| 結果 | ケース |
| --- | --- |
| pass | fixed five-phase manifest partitions every actual Definition leaf without changing runtime identities |
| pass | current production scopes retain all sixteen leaves while the entire existing registration set is checked |
| pass | future production responsibility deficits are real-source violations separate from accepted Draft and Spec scopes |
| pass | preparing run and journal identities cannot replace a canonical Step Attempt across reload |
| pass | copied production Draft rejects a broad Service argument and recovers after removal |
| pass | copied production worker entry rejects discarding its registered selection |
| pass | copied production Gate rejects a public canonical bypass of admission |
| pass | copied production Gate display rejects discarding only its registered projection |
| pass | copied production rejects excluding one registered worker from shared display judgment |
| pass | copied production rejects a single worker execution branch before shared judgment |
| pass | copied production rejects hiding a registered worker in its lookup |
| pass | copied production rejects an additional public entry to the private worker |
| pass | copied production rejects Service reads through an instantiated helper |
| pass | copied production rejects Writer reads whose names lack a read prefix |
| pass | draft production registrations load without importing spec composition |
| pass | spec production registrations load without importing draft composition |
| pass | production registration source rejects missing, unreadable, and invalid exports |
| pass | valid loaded registration reaches the shared checker and rejects a violation |
| pass | production registration loading rejects duplicate identity, duplicate class and dependency mismatch |
| pass | registered Gate, Review, and display routes reject Step-specific bypasses |
| pass | display prose can change without changing registered delegation |
| pass | all declared execution forms use named adapters rather than Step suffix inference |
| pass | named execution routes reject selection discard and accept restoration |
| pass | named execution routes reject selection overwrite and accept restoration |
| pass | named execution routes reject a single Step exclusion and accept restoration |
| pass | named execution routes reject early execution branch and accept restoration |
| pass | named execution routes reject post judgment recomputation and accept restoration |
| pass | named execution routes reject recovery selection discard and accept restoration |
| pass | explicit receipt replay is accepted while an arbitrary early return is rejected |
| pass | receipt replay helper cannot hide fresh judgment or execution |
| pass | registration lookup cannot filter an individual Step from its full selection |
| pass | registration lookup cannot build its map from a subset alias |
| pass | unregistered direct loader caller fails closed |
| pass | unregistered alias loader caller fails closed |
| pass | unregistered namespace lookup use is rejected and restoration succeeds |
| pass | unregistered optional namespace lookup use is rejected and restoration succeeds |
| pass | unregistered local alias lookup use is rejected and restoration succeeds |
| pass | unregistered alias chain lookup use is rejected and restoration succeeds |
| pass | unregistered namespace member escape lookup use is rejected and restoration succeeds |
| pass | unregistered destructured namespace lookup use is rejected and restoration succeeds |
| pass | unknown command loader cannot import a declared execution entry |
| pass | named command loader rejects a computed or exchanged module |
| pass | a direct named adapter alias cannot bypass production registration |
| pass | an exported lookup alias is a capability escape even without a local call |
| pass | named contract adapters cannot be silently exchanged |
| pass | typed-input subclass preparation preserves A12 ancestry and rejects unrelated types and broad inputs |
| pass | A12 requires constructor rejection and cannot use a sibling method's type checks as its invariant |
| pass | A12 ties renamed constructor guards to argument positions |
| pass | a missing declared caller source is an incomplete check rather than an accepted future route |
| pass | registered Service and its imported input closure reject IO and broad dependencies |
| pass | Service helper and writer read routes fail, then pass after removal |
| pass | Service instance helper methods cannot hide an IO read |
| pass | settlement writer cannot hide manager reads behind a private field or alias |
| pass | settlement writer passes manager origins through local and imported helpers |
| pass | reverse index rejects direct registered Service construction through a reexport |
| pass | typed input cannot hide a broad source or a conditional constructor |
| pass | typed input getter and static method cannot read global state |
| pass | imported helper initialization cannot hide IO outside its selected export |
| pass | execution entry cannot discard, overwrite, or replace a registered selection |
| pass | direct execution adapter bypass is found through the full source index |
| pass | registration must reference the named shared execution contract |
| pass | shared adapter must consume the exact registered selection |
| pass | two registered Services exported from one module are both inspected |
| pass | targeted execution route must cover its Definition endpoint and fail closed |
| pass | Flow command registry must preserve one named display and execution route |
| pass | settlement writer rejects computed manager access, including aliases and optional access |
| pass | settlement manager members share one save-only contract across access forms |
| pass | settlement manager rejects unclassified use: destructured method |
| pass | settlement manager rejects unclassified use: renamed destructuring |
| pass | settlement manager rejects unclassified use: return |
| pass | settlement manager rejects unclassified use: object capture |
| pass | settlement manager rejects unclassified use: array capture |
| pass | settlement manager rejects unclassified use: spread |
| pass | settlement manager rejects unclassified use: assignment |
| pass | settlement manager rejects unclassified use: public field |
| pass | settlement manager rejects unclassified use: method argument |
| pass | settlement manager rejects unclassified use: optional helper |
| pass | settlement manager rejects unclassified use: save argument |
| pass | settlement manager rejects unclassified use: wrapped helper argument |
| pass | settlement manager rejects unclassified use: parenthesized alias |
| pass | manager delegation must inspect the callee even behind a Store filename |
| pass | fixed responsibility leaves accept a renamed second phase and another phase's official registrations |
| pass | missing responsibility leaf is rejected even when its Step source is removed |
| pass | an individual Step cannot be excluded from the selected phase |
| pass | entry Step without production registration fails independently of fixed leaf completeness |
| pass | single registry duplicates and phase selection identity are separate violations |
| pass | shared registry inspection returns concrete issues for both diagnostic and load boundaries |
| pass | a foreign single-registry member is rejected as a registry type violation |
| pass | the fixed registry is an immutable snapshot of the supplied selection source |
| pass | Task scope fixes roles and reuses canonical TaskStepIdentity for materialized nodes |
| pass | one selection is passed unchanged to projection and execution |
| pass | execution contract rejects anonymous adapters |

#### Draft / Spec 全登録実DI

| 結果 | ケース |
| --- | --- |
| pass | every registered Draft Step Service has a real instance inspected for A07 |
| pass | every registered Spec Step Service has a prepared instance inspected for A07 |
| pass | canonical Spec preparation passes declared typed arguments into every Service |
| pass | A07 inspects every prepared Service and accepts healthy registrations |
| pass | A07 rejects a violating Service in a later registered Step |
| pass | A07 rejects an unprepared registration even when another Step uses the same Service |
| pass | A07 records registration and constructor argument evidence for wrong prepared arguments |
| pass | A07 records the production registration for hidden and Symbol Service properties |
| pass | A07 type boundary inspection cannot substitute for production Step preparation |

#### manifest / identity + 既存structure unit

| 結果 | ケース |
| --- | --- |
| pass | fixed five-phase manifest partitions every actual Definition leaf without changing runtime identities |
| pass | current production scopes retain all sixteen leaves while the entire existing registration set is checked |
| pass | future production responsibility deficits are real-source violations separate from accepted Draft and Spec scopes |
| pass | preparing run and journal identities cannot replace a canonical Step Attempt across reload |
| pass | Flow rules classify module roles and normalize allowed builtins |
| pass | Service boundary rejects hidden and Symbol own data but allows private fields |
| pass | A07 coverage finds a newly declared Service without an inspected instance |
| pass | A07 coverage rejects a wrong instance under a declared Service key |
| pass | A07 coverage credits only an instance that passes the public data boundary |

#### 既存Result / Binding

| 結果 | ケース |
| --- | --- |
| pass | DraftStepBinding cannot be constructed without a typed domain source |
| pass | DraftWorkerStepBinding requires the existing typed handoff request |
| pass | StepResult is abstract and every concrete Result has one unique fixed contract |
| pass | StepResult readback rejects unknown kind, mismatched type, and wrong Step |
| pass | stepResultDigest accepts only a concrete StepResult |
| pass | StepErrorResult preserves generic code/data and Flow error identity on readback |
| pass | Result.persist resolves only after the service returns its durable receipt |
| pass | Step.execute accepts only a concrete StepResult boundary |

#### 既存whole-file Review / admission

| 結果 | ケース |
| --- | --- |
| pass | large Unicode review input reaches one provider request as complete exact bytes |
| pass | final global synthesis receives the same complete immutable file authority |
| pass | rejects incomplete inline Draft coverage synthesis instead of dropping valid map findings |
| pass | rejects incomplete whole-file Draft coverage synthesis instead of dropping valid map findings |
| pass | rejects changed immutable input before provider execution |
| pass | rejects missing immutable input before provider execution |
| pass | stops file-read-failed without converting unread review input into success |
| pass | stops context-limit without converting unread review input into success |
| pass | rejects a complete-looking response after provider changes referenced input |
| pass | fitting Unicode characters use a full file when argv byte projection overflows |
| pass | file schema supports strict providers and rejects mixed success/unavailable outcomes |
| pass | materialization failure is a typed local stop before review execution |
| pass | admits one provider execution when direct and dispatcher review calls overlap |
| pass | RunReviewCommand execution admission |

#### 既存handoff選択4契約

| 結果 | ケース |
| --- | --- |
| pass | references complete large worker inputs without changing the handoff digest or input authority |
| pass | runs the bound Draft Step through the existing handoff and advances to questions review |
| pass | reads back the exact initial Spec receipt when Store reports an error after commit |
| pass | rolls back changed Spec Repair Result and Review when catalog publication fails mid-transaction |
| pass | worker artifact handoff |

#### 02 Result初期検出（expected red）

| 結果 | ケース |
| --- | --- |
| pass | generation seed uses existing canonical candidate classes and stores manifest metadata without bytes |
| 未達検出（02） | 02 operands project only source binding, remaining R identities/statuses and existing retry values |
| 未達検出（02） | 02 dedicated operand export: RequirementTestResultBinding |
| 未達検出（02） | 02 dedicated operand export: RequirementTestResultFrontier |
| 未達検出（02） | 02 dedicated operand export: RequirementTestRetryState |
| 未達検出（02） | TestGenerateCandidateSavedResult: single registry fixes concrete class, kind, type and leaf |
| 未達検出（02） | TestGenerateCandidateSavedResult: roundtrip retains next R frontier, adopted lineage and retry state |
| 未達検出（02） | TestGenerateCandidateSavedResult: constructor refuses missing, untyped and undeclared operands |
| 未達検出（02） | TestGenerateCandidateSavedResult: readback refuses identity, schema and forbidden payload tampering |
| 未達検出（02） | TestGenerateStructuralRejectedResult: single registry fixes concrete class, kind, type and leaf |
| 未達検出（02） | TestGenerateStructuralRejectedResult: roundtrip retains next R frontier, adopted lineage and retry state |
| 未達検出（02） | TestGenerateStructuralRejectedResult: constructor refuses missing, untyped and undeclared operands |
| 未達検出（02） | TestGenerateStructuralRejectedResult: readback refuses identity, schema and forbidden payload tampering |
| 未達検出（02） | 02 binding refuses another R, Spec, leaf, Attempt or candidate publication identity |
| 未達検出（02） | 02 digest includes R frontier order, candidate lineage/bytes, auto mode and each retry counter |
| 未達検出（02） | 02 Definition selects the same final-candidate Settlement from saved Result alone |
| pass | existing ordinary/Error codecs retain kind/type and code/data while refusing generic payload |

### 修正前・独立確認・初稿fixtureの記録

| 生ログ | SHA-256 | 観測抜粋 |
| --- | --- | --- |
| fc21-service-before.log | 15ca61b50d7191535966d60321f3e2720ec7ad6fee94cf7b2cd926b8990ad38a | not ok 1 - A07 rejects an unprepared registration even when another Step uses the same Service; # tests 1; # pass 0; # fail 1; # skipped 0 |
| sennel-fc21-registry-before.log | 35e0185d05b5ac38938b16f73ab561710b337ceefe48573bab1f526cb34aa926 | not ok 1 - a foreign single-registry member is rejected as a registry type violation; not ok 2 - the fixed registry is an immutable snapshot of the supplied selection source; # tests 2; # pass 0; # fail 2; # skipped 0 |
| sennel-fc21-independent-probe.log | 4a0129289a25e0bd98f8fc8b04137aa5b45a2e85dca593d4f95aad89fb88539b | {"label":"baseline","ok":true,"diagnostics":[]}; {"label":"unregistered namespace lookup","ok":true,"diagnostics":[]}; {"label":"unregistered local lookup alias","ok":true,"diagnostics":[]} |
| sennel-fc21-independent-invariant-probe.log | ea80b3eb84cb766c5f25eaf508ddd96934e7a9229287ae3433e597e8f2f31bb2 | {"label":"baseline","ok":true,"diagnostics":[]}; {"label":"constructor validates locals and accepts untyped arguments","ok":true,"diagnostics":[]} |
| sennel-fc21-independent-probe-fixed.log | a7f089a1faaf6fe412668828cbc460b3a482b339c3818dafa0bdc430c8ddd8b8 | {"label":"baseline","ok":true,"diagnostics":[]}; {"label":"subset map drops second registered Step","ok":false,"diagnostics":["A10 src/flow/engine/composition/omega.js:12:14 lookup commandRegistration does not cover its full registration selection [src/flow/engine/composition/omega.js]"]}; {"label":"unregistered namespace lookup","ok":false,"diagnostics":["A11 src/flow/lib/command-unregistered.js:1:106 unregistered execution lookup caller or capability escape registry [src/flow/lib/command-unregistered.js -> src/flow/engine/c; {"label":"unregistered local lookup alias","ok":false,"diagnostics":["A11 src/flow/lib/command-unregistered.js:1:150 unregistered execution lookup caller or capability escape lookup [src/flow/lib/command-unregistered.js -> src/flow/engine/c; {"label":"constructor validates locals and accepts untyped arguments","ok":false,"diagnostics":["A12 src/flow/services/service.js:1:99 Service constructor must validate typed input and settlement writer [src/flow/services/service.js]","A12  |
| sennel-fc21-independent-destructure-probe.log | 9a65228d2920c971b45e1e67ba424fbd8d4f189dffb820855a25238441ecd5d6 | {"label":"constructor destructuring overwrites both raw arguments before guard","ok":true,"diagnostics":[]} |
| sennel-fc21-destructure-before.log | c98dc049e7d40b4ac57c027b6ba7b266d7aab0612db440141b3a407fe2c89b44 | # Subtest: A12 requires constructor rejection and cannot use a sibling method's type checks as its invariant; not ok 1 - A12 requires constructor rejection and cannot use a sibling method's type checks as its invariant; # tests 1; # pass 0; # fail 1; # skipped 0 |
| sennel-fc21-independent-destructure-final.log | c1521356a9f460c250a0dd05aef500e05f5d782e655c61398493f4a0b255d177 | {"label":"baseline","ok":true,"diagnostics":[]}; {"label":"constructor destructuring overwrites both raw arguments before guard","ok":false,"diagnostics":["A12 src/flow/services/service.js:1:99 Service constructor must validate typed input and settlement writer [src/flow/services/service. |
| sennel-fc21-shared-final.log | cd39591c88f390d0f60b66e96ae2573538e3f3bce0d10aa3ff1db7335d0754ce | not ok 4 - preparing run and journal identities cannot replace a canonical Step Attempt across reload; # Subtest: copied production rejects hiding a registered worker in its lookup; ok 11 - copied production rejects hiding a registered worker in its lookup; # Subtest: registration lookup cannot filter an individual Step from its full selection; ok 31 - registration lookup cannot filter an individual Step from its full selection; # Subtest: registration lookup cannot build its map from a subset alias; ok 32 - registration lookup cannot build its map from a subset alias; # Subtest: unregistered alias loader caller fails closed; ok 34 - unregistered alias loader caller fails closed |

## 関連差分・固定tests / fixture / assert snapshot

以下は導入時候補の関連変更と検証入力のSHA-256。M=変更、A=新規、固定=既存再利用。証跡自身は自己参照hashから除く。assertは各testの全bytesに含まれる。修正で更新したファイルの現行hashは追補に記録する。`src/`差分は0、`git diff --check`はpass。

| 状態 | ファイル | SHA-256 |
| --- | --- | --- |
| 固定 | tests/fixtures/structure/execution.js | d699a118bddfebf7c524c870a61caaa59a24a5967969f40d3963b766246a2088 |
| A | tests/fixtures/structure/staged-execution.js | e2529b6fa469a5ffd50cc70920148dbb45833372eb91874dbfe88fba412ab396 |
| 固定 | tests/fixtures/structure/synthetic.js | 7ae4030e33f1998078e98b6515aa1a54b99e580d81d665f3add781c5d9436590 |
| 固定 | tests/integration/flow/review-whole-file-input.test.js | d409f4e9f144e8e4202c9ee74030d4836953bac107777873eec49af2fb01949c |
| 固定 | tests/integration/flow/run-review-execution-admission.test.js | 383083d73c0c08e922e24271b7777fb0c45d1a31447ea4d1c72495c56a951ab5 |
| M | tests/integration/flow/service-boundary-coverage.test.js | 64e0e75705f65e2a8d24eceeaf47109328d74deac55c2a58f4f709e9cccd9ce9 |
| M | tests/integration/flow/spec-service-boundary-coverage.test.js | 66f65c09265b6cbc88ef1a64074898f04afa095af1194fc421d59e3db8028fc1 |
| 固定 | tests/integration/flow/worker-artifact-handoff.test.js | deb3faa95efab197c48f5522031eaa00b3cf82996eb4505ee958eeb49d78e19a |
| A | tests/integration/structure-phase-manifest.test.js | 79cb192f2afaf0a2e5a1037220063e7bec1bc625d49f24bccd31156f9a5ab6d7 |
| 固定 | tests/integration/structure-production-contract.test.js | 3938b7a195003d8d1641ed7749d65e507cfbd56bd5f29b1210ef67b420fd7903 |
| M | tests/integration/structure-registration-source.test.js | 8a9a34d488b88cbd1558552e197242310a2cb340386dcca366369b8f8e4f3a37 |
| M | tests/structure/draft.test.js | 7f2b78b1985c791786e699726c6cd6cac2626565f970eafe8c0ee6a609a5ce5b |
| 固定 | tests/structure/execution-routing.test.js | cb058ea4f48fb8d53f984d8ac7d20db86bdc5e86d4f000aceb1e165d7018127e |
| A | tests/structure/external-execution-contract.test.js | 00a5867e291f21a12049f1bb4494508b11447f863fd31d20f693c4eaddf37300 |
| 固定 | tests/structure/service-contract.test.js | 45a9dcc3f778d9d789e0d183da356611aa62132ef3e1a56ae481ec765282f4d5 |
| M | tests/structure/spec.test.js | 6847fe5aad46c6dad0e77a7acd2475efaff5f2985ad1b3b2c5821a8f245a0dd3 |
| A | tests/structure/staged-scope-contract.test.js | cc78133d9c5f1c968561a92930f55886ba2ae3ce4ce525d939b9f7d937fcdd76 |
| 固定 | tests/structure/step-execution-contract.test.js | 2b36af32dfe7d5eec6386443d43f95afa9fa1e3b23161a7ad8a74dc6d8dc1710 |
| 固定 | tests/support/infrastructure/flow-setup.js | ad8507c04b695d3e1a993aabaff9cbbb251404c0124568bfba11bd22920162e1 |
| 固定 | tests/support/infrastructure/spec-step-preparation.js | e9b71c1c3bdf8b10b1490c4d1bff29aaa2378cfef56b62df2970ca4a94c82107 |
| M | tests/support/structure/checker.js | 819113d0867182918e5344b95eed7ce23f3fe917c2b5ba017e8402cc07aa47cb |
| 固定 | tests/support/structure/flow-rules.js | ec5e12f5016b22820e992b5015e2c0f9a19d568c44e76b0ac1a5e2b76a2e2edb |
| A | tests/support/structure/phase-manifest.js | 7b7cbd9a65a4f185596967fee2e85fb62a27ff2769cc2a52e6bd78ea702c902a |
| M | tests/support/structure/production-registrations.js | a7f99b8aef6a2dfcfd338202094e740d1c59c7f31f314c79f5ca945746b202c9 |
| M | tests/support/structure/service-boundary.js | 5ab88866c4faaf98425bcd86594dfd3dde21881ce4631e865d4a25f2c8d79fbc |
| M | tests/support/structure/source-reader.js | ffaeca3bf8b2355d9432d74fa84ebc61bf3eb05ee9dd2a35357f24d1aceb5891 |
| 固定 | tests/support/structure/source-repository.js | 1e984e1f17395fadbe64874f209238a9a27d16bfbdfa19c56b16fb27b79a126b |
| 固定 | tests/unit/draft-step-binding.test.js | e39daac92a821f81053a0ae374008ea6d171b90ead0913a869cb18f34013bc61 |
| 固定 | tests/unit/flow-engine-step-result.test.js | 282b0b5bbf76e15c17050acaea4c9eb3bbf6a3ee4f326e1f98eec81583e0e120 |
| 固定 | tests/unit/structure-rules.test.js | 04ef374fe80d6cacc4bab8bb8b8552dea8c0168694df455a05965bd9bbbef3f9 |
| A | tests/unit/structured-step-result-contract.test.js | ca062071023e3eaa0e85158810c93cc2dbae16c9be4212c3021b017dcf8c9c8b |

導入時判定: fc21共通検査契約の受け入れ条件を満たすと判定した。未来工程の製品実装合格は未達として上の所有工程へ引き継いだ。この時点で生成した生テスト・作業ログをこの証跡への集約後に削除し、存在しないことを確認した。作業用の証跡生成scriptも削除した。変更は上記worktreeの未コミット差分として保存している。

## 再レビューの追補（2026-10-02）

基点HEAD・branch・worktreeは冒頭と同じ。今回の追加修正はchecker.js、source-reader.js、external-execution-contract.test.js、constructor-invariant-contract.test.js、structure-source-reader.test.jsと本証跡に限る。導入時の他の差分は保持した。src/、依存、runner、製品API、Flow状態、共有main worktreeは変更していない。

### 指摘の再評価と修正範囲

| 指摘 | 根拠と判断 |
| --- | --- |
| named project/execute adapterの選択破棄・再選択を見逃す | 修正前checkerで同じ負例が誤って合格。A10の閉じた消費形全体とbinding参照を検査する必要がある実欠陥として修正。 |
| 効かないconstructor guardを型invariantとして認める | 修正前readerでternaryによりthrowへ到達しない式が合格。条件全体・即時throw・元引数・型参照bindingを確認する必要がある実欠陥として修正。 |
| 未導入のproduction export検出まで現時点の完成条件にする | 現時点の未達検出の証明限界を明記する事項へ格下げ。未来の自動導入判定・製品APIは追加しない。 |
| Task専用Result試験の欠如をfc21の必須修正とする | ボードが求める共通codecと所有工程への引き継ぎを超えていたため撤回。今回の新規API・試験の追加対象にしない。 |

選択消費は元selectionのreturn、immutable const alias、同一moduleで静的に確認できるhelperへの同じ引数位置の委譲という対応形に限定する。任意call、再選択、上書き、未知条件、循環、role交換は証拠として受理しない。helperとadapterの参照は共通SourceOriginUsageのacceptBindings:falseを使い、確認済み関数群と契約構築だけを明示受理する。alias・private field・export・再代入を別scannerで複製していない。既存A08/A11の通常受理policyは保持した。

constructorは元引数に対する先頭の連続した拒否guardのみを認定する。括弧付きOR、直接parameterのnegated instanceof、現行製品のmember/equality追加条件、literal、即時throwという閉じた形を条件全体で確認する。平坦ORの各項を一度ずつ解析し、残り全体の再帰sliceで増える処理を除いた。literal内の記号を区切りと扱わない判断は既存readCommaSeparatedへ集約した。

型binding修正後の184件測定に続く管理者照合で、if(condition) "throw" + newline + new TypeError();という合法ASIのコードをthrow文と誤認する同じA12契約の修正漏れを再現した。実際に未型値を受理する一方、checkerはok=trueだった。guardのkeywordと構造記号はSourceToken.kindも照合し、同じ値のliteralを文法として認めない形に修正した。一般ASIモデルや別parserは追加していない。

管理者がhelperの再代入を独立probeで見つけてAstraへ差し戻し、Luna最終レビューと管理者probeがguard後のhoisted local型によるshadowを確認してSolへ差し戻した。後者は正しいmodule Input instanceもruntimeで拒否されるのに静的検査がok=trueだった。同名の未型値が必ず通るという主張はしない。型参照のSourceTokenを保持し、constructor全体を既存unboundGlobalsで一度だけ解析し、外側型を参照するguardだけ認定する。

合法nested classの正例は期待値を変更せず維持した。既存checkerがnested同名classをmodule-local型として優先していた過剰拒否は、既存import解決とtop-level declaration照合で修正し、argumentTypeKeysの判断も共通resolveLocalへ集約した。module.classesの収集とIO閉包の検査は変更していない。module-level named class expressionもimport bindingをshadowしない正規形として検証した。

担当はgpt-6-astra/high（選択消費・checker型解決）、gpt-6.1-sol/high（guard・source reader）、gpt-6-luna/medium（独立レビュー）。各担当は新ケースの選択実行と隔離before比較に限定し、管理者が実装差分・独立probe・最終共通検証を確認した。

### 修正前後と最終実行

beforeは修正を外した隔離コピーで同一入力・期待値を実行した。live worktree、canonical状態、元Flow証跡を変更していない。失敗はERR_ASSERTIONであり、Syntax/import failureやtimeoutを欠陥検出とは数えていない。型shadow8件のbeforeのうちfunction/let/const/destructuring6件はok=trueの誤受理、class2件は別のcomposition診断だけでconstructor位置の必須診断がなかった。

新規fixture初稿ではrename-positionケースの総診断数を1と想定していたが、実際には合法な追加composition診断があるため、必要なconstructor診断の位置・規則・traceを照合する形へ訂正した。既存の妥当な期待値を変更していない。hoisted修正後の初回13ケースではnested class2件の過剰拒否が残り、その後block lexicalの正例を1件追加した。前記checker修正後に最終候補で再検証した。途中の緑・赤を最終候補の結果と混同しない。

| 測定 | tests | pass | fail | skip | exit | 生ログSHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 選択消費・修正前の同一14ケース | 14 | 1 | 13 | 0 | 1 | a32aafff5a172ea841b232719795c97be18db3514958c8106e328fe731f66a1f |
| 選択消費・担当の修正後14ケース | 14 | 14 | 0 | 0 | 0 | e5fca2468fb31de40dc82dd3f6e2d9371b362f01cc1e88c1e8953a66af8fa91e |
| binding逃避・差し戻し前の同一7ケース | 7 | 1 | 6 | 0 | 1 | 635b1f52140b1553431a3e51b434088b66acdf9fae512a86a8e93f13d5337472 |
| binding逃避・担当の修正後7ケース | 7 | 7 | 0 | 0 | 0 | 14ebd5e83bb2ebbb354b22c5196e0475448669f9e14794a69f8332db2ae32269 |
| 条件式・修正前の同一ternaryケース | 1 | 0 | 1 | 0 | 1 | 2a1644fbb9c7f5de7705b405a453da8ceffa44cb877eeca4b87da0104899a85e |
| constructor guard・担当の38ケース | 38 | 38 | 0 | 0 | 0 | 3f116f088032b15b3b65197b66be15c9ab65a55e049ceff16efd27e817753d80 |
| origin受理policyの3ケース | 3 | 3 | 0 | 0 | 0 | cfe5170b5f6e3d60a5dd970b57ce59b6385c96d28182102385dc7b91683f69df |
| 追加binding修正前の管理者限定実行 | 169 | 169 | 0 | 0 | 0 | 6b3db6e9623b1faef74aad1916922c9300357c0107a37ede1cb1590dbf3a4444 |
| constructor型shadow・修正前の同一8負例 | 8 | 0 | 8 | 0 | 1 | efe30c4faeae1f0bb71c71ec3c95fbfc62fce9ffd8c84f189a4b0ee53e31de73 |
| 合法nested class・修正前の同一2ケース | 2 | 0 | 2 | 0 | 1 | dbf53e46dd135439ca31f2aa054ac6cf705aacecab7bd8fc2d5521b28f027d47 |
| 合法nested class・担当の修正後2ケース | 2 | 2 | 0 | 0 | 0 | 8719f75568406a056a047e3221114c210617dd66fd30b254a439035a17e6d86d |
| 合法module named expression・修正前の同一1ケース | 1 | 0 | 1 | 0 | 1 | a2e6191ded651f96faa60c765e0409dbfcd231dc699f6fa31b35f6d576e29765 |
| 合法module named expression・担当の修正後1ケース | 1 | 1 | 0 | 0 | 0 | 3d8ecd42195c63e2412ce36b38d96587135482663499fe9b5829ff0c1eb8bb8c |
| 管理者・型binding修正後の限定11ファイル | 184 | 184 | 0 | 0 | 0 | 2897392382c172264c7d514e6935135150885b58c27de18d1e302d5a0d5de1ca |
| literal keyword・修正前の同一負例 | 4 | 0 | 4 | 0 | 1 | a3897cbeb9d0257098a1de454dcaa4f4ac02c7049b1430771ce4e0773e11d01c |
| literal keyword・担当の修正後負例 | 4 | 4 | 0 | 0 | 0 | e9886b96bb7c6d656feeb806dcbfe1ce4bc3dd9330bf326151d1f6bcbea16c10 |
| 管理者・最新guard修正後の限定6ファイル | 160 | 160 | 0 | 0 | 0 | 1bdc4c898fb736b0654a725bdd1674ac7f36e7ddbb0b19577ff0354a97035d9b |

| 隔離修正前source | SHA-256 |
| --- | --- |
| 選択消費の修正前checker | 819113d0867182918e5344b95eed7ce23f3fe917c2b5ba017e8402cc07aa47cb |
| 条件式の修正前reader | ffaeca3bf8b2355d9432d74fa84ebc61bf3eb05ee9dd2a35357f24d1aceb5891 |
| binding逃避の差し戻し前checker | 2004ad3aa3a7e0ed36f321451faf6fdc43c88a5fb7dc281975a4f2b2a3c4e0c0 |
| 型shadowの差し戻し前reader | 6a2812d4faa85eec62c7a6452fa0de57634a032efbabbcb1b2c8ae563f7ea6e9 |
| nested型解決の修正前checker | b2c4ad95cbc7f79016aa4d696cf9f234fa16016f2f9d7d8cf7c80fba645c2098 |
| import優先解決の修正前checker | b2e3a1b41ecb66840b6bf1696c606e071daeedc64d3be44f4650dfd23f36344a |
| keyword識別の修正前reader | caf0c4b0c8d39e64531b143ca9071aef37fa203bb959f3017d87a2d43112c5f2 |

管理者の初回11ファイル169件は全件passだったが、追加binding修正後に同じ11ファイル184件を再測定した。最後のkeyword識別と共通referenceのdot token識別は、利用するDraft/Spec・Service契約・reader unit・named adapter・新負例を限定6ファイルで再測定し、変更のない実sourceのIO・登録検査は184件測定を再利用した。測定件数を合算しない。

```sh
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/constructor-invariant-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/unit/structure-source-reader.test.js > /tmp/fc21-fix-final-targeted-r2.log 2>&1
node --test tests/structure/constructor-invariant-contract.test.js tests/structure/service-contract.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/unit/structure-source-reader.test.js tests/structure/external-execution-contract.test.js > /tmp/fc21-fix-final-guard-targeted.log 2>&1
git diff --check
```

型binding修正後の11ファイル: 184 tests / 184 pass / 0 fail / 0 skip / 0 cancelled、exit 0、所要 288.981秒。最新guard修正後の6ファイル: 160 tests / 160 pass / 0 fail / 0 skip / 0 cancelled、exit 0、所要 21.990秒。全repository/full/実AI試験は実行していない。未変更の製品DI・保存・Result/Binding・handoff回帰は導入時の固定hashと測定を再利用し、今回の合格件数に加算しない。新しい性能ベンチマークを行ったとは主張しない。

管理者の独立probe（baseline→合法helper→helper再代入/selection破棄/再選択/ternary拒否→復旧合格）生ログSHA-256: e95c66a229bc2a89f2ef43423866b889dc9b844c6b68b0352f53b634fb03d6a0。hoisted型の静的誤受理とruntimeのmodule型拒否probe SHA-256: c6751f463224e22d995d16d8b3f82dec890444162ca145bcea8e7cd4f92a1f38。最終binding probe（hoisted Input/Writer拒否、合法nested/root type受理、復旧合格）SHA-256: 62760219b80e323149a0d65d8110369f389abc4273f61129f92be1492382413e。docs freshnessはstaleのまま、build提案済み。sourceを根拠に照合した。

literal throwの修正前静的誤受理とruntime未型値受理probe SHA-256: 9ed265b9fda8cdf5625d616c798509510215fbba2b1ce91da712b37597955d17。keyword識別修正後の管理者同一probe SHA-256: 343355f83f8741ba6a0b3ea6cfdcb24a4aa70585d9b23367809ee762182ff206。

### 限定実行のケース別結果（重複を除外）

| 結果 | ケース |
| --- | --- |
| pass（11ファイル測定） | copied production Draft rejects a broad Service argument and recovers after removal |
| pass（11ファイル測定） | copied production worker entry rejects discarding its registered selection |
| pass（11ファイル測定） | copied production Gate rejects a public canonical bypass of admission |
| pass（11ファイル測定） | copied production Gate display rejects discarding only its registered projection |
| pass（11ファイル測定） | copied production rejects excluding one registered worker from shared display judgment |
| pass（11ファイル測定） | copied production rejects a single worker execution branch before shared judgment |
| pass（11ファイル測定） | copied production rejects hiding a registered worker in its lookup |
| pass（11ファイル測定） | copied production rejects an additional public entry to the private worker |
| pass（11ファイル測定） | copied production rejects Service reads through an instantiated helper |
| pass（11ファイル測定） | copied production rejects Writer reads whose names lack a read prefix |
| pass（11ファイル測定） | draft production registrations load without importing spec composition |
| pass（11ファイル測定） | spec production registrations load without importing draft composition |
| pass（11ファイル測定） | production registration source rejects missing, unreadable, and invalid exports |
| pass（11ファイル測定） | valid loaded registration reaches the shared checker and rejects a violation |
| pass（11ファイル測定） | production registration loading rejects duplicate identity, duplicate class and dependency mismatch |
| pass（最新guard修正後） | A12 rejects ternary masking the whole disjunction and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects ternary masking one required operand and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects AND requiring both invalid operands and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects an AND branch disabling the writer rejection and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects an outer AND disabling both rejections and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects a comma discarding the type checks and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects equality changing the whole condition and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects an OR operand with an unresolved call and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects a parameter assignment in the condition and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects a type binding assignment in the condition and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects a member assignment before a required rejection and accepts restored constructor guards |
| pass（最新guard修正後） | A12 rejects a string resembling a type operand and accepts restored constructor guards |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through conditional throw and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through throw inside an uncalled function and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through caught rejection and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through guard inside an optional branch and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through early return and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through replaced input binding and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through compound binding replacement and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through destructured binding replacement and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through shadowed type binding and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through unresolved prefix invocation and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through binding replacement between separate guards and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through unknown condition between separate guards and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through unresolved throw expression and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through parameter replacement in the throw expression and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through type binding replacement in the throw expression and accepts restoration |
| pass（最新guard修正後） | A12 proves original parameter rejection with the existing unbraced OR guard |
| pass（最新guard修正後） | A12 proves original parameter rejection with the existing braced OR guard |
| pass（最新guard修正後） | A12 proves original parameter rejection with two separate unconditional guards |
| pass（最新guard修正後） | A12 proves original parameter rejection with parenthesized OR groups |
| pass（最新guard修正後） | A12 proves original parameter rejection with additional production member predicates |
| pass（最新guard修正後） | A12 proves original parameter rejection with production equality predicate |
| pass（最新guard修正後） | A12 proves original parameter rejection with a literal disjunct preserving rejection |
| pass（最新guard修正後） | A12 proves original parameter rejection with a return after both parameters have been rejected when invalid |
| pass（最新guard修正後） | A12 proves original parameter rejection with literal prose containing syntax |
| pass（最新guard修正後） | A12 proves original parameter rejection with literal error arguments containing separators |
| pass（最新guard修正後） | A12 preserves renamed argument positions across rejection and restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a hoisted input function after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a hoisted writer function after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from an input class after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a writer class after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from an input let binding after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a writer const binding after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a destructured input binding after the guard and accepts restoration |
| pass（最新guard修正後） | A12 rejects constructor-local type shadowing from a destructured writer binding after the guard and accepts restoration |
| pass（最新guard修正後） | A12 module-level named class expressions do not shadow imported guard types |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare block-local types |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare block-local lexical bindings |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare function parameters |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare arrow parameters |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare named function expressions |
| pass（最新guard修正後） | A12 keeps outer guard type bindings when unrelated nested scopes declare named class expressions |
| pass（最新guard修正後） | Draft source obeys shared Flow structure rules |
| pass（11ファイル測定） | registered Gate, Review, and display routes reject Step-specific bypasses |
| pass（11ファイル測定） | display prose can change without changing registered delegation |
| pass（最新guard修正後） | all declared execution forms use named adapters rather than Step suffix inference |
| pass（最新guard修正後） | named execution routes reject selection discard and accept restoration |
| pass（最新guard修正後） | named execution routes reject selection overwrite and accept restoration |
| pass（最新guard修正後） | named execution routes reject a single Step exclusion and accept restoration |
| pass（最新guard修正後） | named execution routes reject early execution branch and accept restoration |
| pass（最新guard修正後） | named execution routes reject post judgment recomputation and accept restoration |
| pass（最新guard修正後） | named execution routes reject recovery selection discard and accept restoration |
| pass（最新guard修正後） | explicit receipt replay is accepted while an arbitrary early return is rejected |
| pass（最新guard修正後） | receipt replay helper cannot hide fresh judgment or execution |
| pass（最新guard修正後） | registration lookup cannot filter an individual Step from its full selection |
| pass（最新guard修正後） | registration lookup cannot build its map from a subset alias |
| pass（最新guard修正後） | unregistered direct loader caller fails closed |
| pass（最新guard修正後） | unregistered alias loader caller fails closed |
| pass（最新guard修正後） | unregistered namespace lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unregistered optional namespace lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unregistered local alias lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unregistered alias chain lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unregistered namespace member escape lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unregistered destructured namespace lookup use is rejected and restoration succeeds |
| pass（最新guard修正後） | unknown command loader cannot import a declared execution entry |
| pass（最新guard修正後） | named command loader rejects a computed or exchanged module |
| pass（最新guard修正後） | a direct named adapter alias cannot bypass production registration |
| pass（最新guard修正後） | an exported lookup alias is a capability escape even without a local call |
| pass（最新guard修正後） | named contract adapters cannot be silently exchanged |
| pass（最新guard修正後） | named adapter consumer rejects selection discard and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects selection recomputation and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects selection overwrite and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects early bypass and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects unknown conditional shape and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects computed selection access and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects alias overwrite and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects delegate selection discard and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects delegate rejudgment and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects delegate argument replacement and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects opaque delegate and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects recursive delegate and accepts restoration |
| pass（最新guard修正後） | named adapter consumer rejects adapter role exchange and accepts restoration |
| pass（最新guard修正後） | named adapter consumers preserve immutable aliases and inspected local delegation across all execution forms |
| pass（最新guard修正後） | named adapter bindings reject helper reassignment and accept restoration |
| pass（最新guard修正後） | named adapter bindings reject helper alias escape and accept restoration |
| pass（最新guard修正後） | named adapter bindings reject helper private field escape and accept restoration |
| pass（最新guard修正後） | named adapter bindings reject helper export escape and accept restoration |
| pass（最新guard修正後） | named adapter bindings reject replacement before contract capture and accept restoration |
| pass（最新guard修正後） | named adapter bindings reject direct helper exports and accept restoration |
| pass（最新guard修正後） | named adapter bindings accept one inspected helper shared by project and execute |
| pass（最新guard修正後） | typed-input subclass preparation preserves A12 ancestry and rejects unrelated types and broad inputs |
| pass（最新guard修正後） | A12 requires constructor rejection and cannot use a sibling method's type checks as its invariant |
| pass（最新guard修正後） | A12 ties renamed constructor guards to argument positions |
| pass（最新guard修正後） | a missing declared caller source is an incomplete check rather than an accepted future route |
| pass（最新guard修正後） | registered Service and its imported input closure reject IO and broad dependencies |
| pass（最新guard修正後） | Service helper and writer read routes fail, then pass after removal |
| pass（最新guard修正後） | Service instance helper methods cannot hide an IO read |
| pass（最新guard修正後） | settlement writer cannot hide manager reads behind a private field or alias |
| pass（最新guard修正後） | settlement writer passes manager origins through local and imported helpers |
| pass（最新guard修正後） | reverse index rejects direct registered Service construction through a reexport |
| pass（最新guard修正後） | typed input cannot hide a broad source or a conditional constructor |
| pass（最新guard修正後） | typed input getter and static method cannot read global state |
| pass（最新guard修正後） | imported helper initialization cannot hide IO outside its selected export |
| pass（最新guard修正後） | execution entry cannot discard, overwrite, or replace a registered selection |
| pass（最新guard修正後） | direct execution adapter bypass is found through the full source index |
| pass（最新guard修正後） | registration must reference the named shared execution contract |
| pass（最新guard修正後） | shared adapter must consume the exact registered selection |
| pass（最新guard修正後） | two registered Services exported from one module are both inspected |
| pass（最新guard修正後） | targeted execution route must cover its Definition endpoint and fail closed |
| pass（最新guard修正後） | Flow command registry must preserve one named display and execution route |
| pass（最新guard修正後） | settlement writer rejects computed manager access, including aliases and optional access |
| pass（最新guard修正後） | settlement manager members share one save-only contract across access forms |
| pass（最新guard修正後） | settlement manager rejects unclassified use: destructured method |
| pass（最新guard修正後） | settlement manager rejects unclassified use: renamed destructuring |
| pass（最新guard修正後） | settlement manager rejects unclassified use: return |
| pass（最新guard修正後） | settlement manager rejects unclassified use: object capture |
| pass（最新guard修正後） | settlement manager rejects unclassified use: array capture |
| pass（最新guard修正後） | settlement manager rejects unclassified use: spread |
| pass（最新guard修正後） | settlement manager rejects unclassified use: assignment |
| pass（最新guard修正後） | settlement manager rejects unclassified use: public field |
| pass（最新guard修正後） | settlement manager rejects unclassified use: method argument |
| pass（最新guard修正後） | settlement manager rejects unclassified use: optional helper |
| pass（最新guard修正後） | settlement manager rejects unclassified use: save argument |
| pass（最新guard修正後） | settlement manager rejects unclassified use: wrapped helper argument |
| pass（最新guard修正後） | settlement manager rejects unclassified use: parenthesized alias |
| pass（最新guard修正後） | manager delegation must inspect the callee even behind a Store filename |
| pass（最新guard修正後） | Spec source obeys shared Flow structure rules through production registration |
| pass（11ファイル測定） | fixed responsibility leaves accept a renamed second phase and another phase's official registrations |
| pass（11ファイル測定） | missing responsibility leaf is rejected even when its Step source is removed |
| pass（11ファイル測定） | an individual Step cannot be excluded from the selected phase |
| pass（11ファイル測定） | entry Step without production registration fails independently of fixed leaf completeness |
| pass（11ファイル測定） | single registry duplicates and phase selection identity are separate violations |
| pass（11ファイル測定） | shared registry inspection returns concrete issues for both diagnostic and load boundaries |
| pass（11ファイル測定） | a foreign single-registry member is rejected as a registry type violation |
| pass（11ファイル測定） | the fixed registry is an immutable snapshot of the supplied selection source |
| pass（11ファイル測定） | Task scope fixes roles and reuses canonical TaskStepIdentity for materialized nodes |
| pass（11ファイル測定） | one selection is passed unchanged to projection and execution |
| pass（11ファイル測定） | execution contract rejects anonymous adapters |
| pass（最新guard修正後） | route initializers must be unconditional declarations in the enclosing function |
| pass（最新guard修正後） | closed route matching distinguishes identifiers from equal literal text |
| pass（最新guard修正後） | source reader distinguishes imports from comments, strings, regexes, and template text |
| pass（最新guard修正後） | source reader finds dynamic imports in template interpolations and ignores import methods |
| pass（最新guard修正後） | source reader fails on unterminated lexical forms |
| pass（最新guard修正後） | source reader keeps nested dependencies out of the enclosing class |
| pass（最新guard修正後） | source reader accepts an anonymous class expression with simple heritage |
| pass（最新guard修正後） | lexical bindings shadow prohibited globals only within their own scope |
| pass（最新guard修正後） | binding collection excludes initializer references |
| pass（最新guard修正後） | scope analysis rejects var declarations instead of treating them as block bindings |
| pass（最新guard修正後） | var rejection leaves block bindings and lexical reference indexing intact |
| pass（最新guard修正後） | regex after a control block does not create a false global reference |
| pass（最新guard修正後） | division after an object or expression still exposes real globals |
| pass（最新guard修正後） | route prose placeholders accept only string literals and preserve surrounding contracts |
| pass（最新guard修正後） | member extraction normalizes access and call syntax without granting permission |
| pass（最新guard修正後） | origin accounting leaves escapes unclassified after tracking private and local bindings |
| pass（最新guard修正後） | origin accounting never treats destructuring, captures, or defaults as checked transfers |
| pass（最新guard修正後） | explicit origin binding acceptance retains private-field and chained alias provenance |
| pass（最新guard修正後） | explicit origin binding acceptance leaves destructured parameter bindings unchecked |
| pass（最新guard修正後） | explicit origin binding acceptance is forwarded by the module reader |
| pass（最新guard修正後） | A12 rejects a literal negation operator and accepts restored constructor guards |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through a literal throw keyword followed by a new expression and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through literal throw and new keywords separated by ASI and accepts restoration |
| pass（最新guard修正後） | A12 refuses to prove constructor invariants through a literal semicolon prefix and accepts restoration |

### 再レビュー時点の固定source / test / fixture

以下は再レビュー時点のhashである。最新のlookup修正候補は末尾の追補を正とし、この表と導入時の表は履歴として保持する。assertはtest全bytesに含む。証跡自身は自己参照hashから除く。

| 状態 | ファイル | SHA-256 |
| --- | --- | --- |
| 固定 | tests/fixtures/structure/execution.js | d699a118bddfebf7c524c870a61caaa59a24a5967969f40d3963b766246a2088 |
| A | tests/fixtures/structure/staged-execution.js | e2529b6fa469a5ffd50cc70920148dbb45833372eb91874dbfe88fba412ab396 |
| 固定 | tests/fixtures/structure/synthetic.js | 7ae4030e33f1998078e98b6515aa1a54b99e580d81d665f3add781c5d9436590 |
| 固定 | tests/integration/flow/review-whole-file-input.test.js | d409f4e9f144e8e4202c9ee74030d4836953bac107777873eec49af2fb01949c |
| 固定 | tests/integration/flow/run-review-execution-admission.test.js | 383083d73c0c08e922e24271b7777fb0c45d1a31447ea4d1c72495c56a951ab5 |
| M | tests/integration/flow/service-boundary-coverage.test.js | 64e0e75705f65e2a8d24eceeaf47109328d74deac55c2a58f4f709e9cccd9ce9 |
| M | tests/integration/flow/spec-service-boundary-coverage.test.js | 66f65c09265b6cbc88ef1a64074898f04afa095af1194fc421d59e3db8028fc1 |
| 固定 | tests/integration/flow/worker-artifact-handoff.test.js | deb3faa95efab197c48f5522031eaa00b3cf82996eb4505ee958eeb49d78e19a |
| A | tests/integration/structure-phase-manifest.test.js | 79cb192f2afaf0a2e5a1037220063e7bec1bc625d49f24bccd31156f9a5ab6d7 |
| 固定 | tests/integration/structure-production-contract.test.js | 3938b7a195003d8d1641ed7749d65e507cfbd56bd5f29b1210ef67b420fd7903 |
| M | tests/integration/structure-registration-source.test.js | 8a9a34d488b88cbd1558552e197242310a2cb340386dcca366369b8f8e4f3a37 |
| A | tests/structure/constructor-invariant-contract.test.js | 93fb32abf4ac207c5f305d940a880720a9ab5b1ad0d470d8ee0bb3442d23b3a8 |
| M | tests/structure/draft.test.js | 7f2b78b1985c791786e699726c6cd6cac2626565f970eafe8c0ee6a609a5ce5b |
| 固定 | tests/structure/execution-routing.test.js | cb058ea4f48fb8d53f984d8ac7d20db86bdc5e86d4f000aceb1e165d7018127e |
| A | tests/structure/external-execution-contract.test.js | 219ecb0572d9371ee098a8e9a909c40694f9a1765ba96044c2e12c1d7c1d072d |
| 固定 | tests/structure/service-contract.test.js | 45a9dcc3f778d9d789e0d183da356611aa62132ef3e1a56ae481ec765282f4d5 |
| M | tests/structure/spec.test.js | 6847fe5aad46c6dad0e77a7acd2475efaff5f2985ad1b3b2c5821a8f245a0dd3 |
| A | tests/structure/staged-scope-contract.test.js | cc78133d9c5f1c968561a92930f55886ba2ae3ce4ce525d939b9f7d937fcdd76 |
| 固定 | tests/structure/step-execution-contract.test.js | 2b36af32dfe7d5eec6386443d43f95afa9fa1e3b23161a7ad8a74dc6d8dc1710 |
| 固定 | tests/support/infrastructure/flow-setup.js | ad8507c04b695d3e1a993aabaff9cbbb251404c0124568bfba11bd22920162e1 |
| 固定 | tests/support/infrastructure/spec-step-preparation.js | e9b71c1c3bdf8b10b1490c4d1bff29aaa2378cfef56b62df2970ca4a94c82107 |
| M | tests/support/structure/checker.js | 2265cd3fd6b0dd1f904f693a2f006bbf0862cd64d4726e0e9515df93833b6bfd |
| 固定 | tests/support/structure/flow-rules.js | ec5e12f5016b22820e992b5015e2c0f9a19d568c44e76b0ac1a5e2b76a2e2edb |
| A | tests/support/structure/phase-manifest.js | 7b7cbd9a65a4f185596967fee2e85fb62a27ff2769cc2a52e6bd78ea702c902a |
| M | tests/support/structure/production-registrations.js | a7f99b8aef6a2dfcfd338202094e740d1c59c7f31f314c79f5ca945746b202c9 |
| M | tests/support/structure/service-boundary.js | 5ab88866c4faaf98425bcd86594dfd3dde21881ce4631e865d4a25f2c8d79fbc |
| M | tests/support/structure/source-reader.js | 9499f5b613f3d28a0e237bb2267109857cd648f2d71423d306c950cad8e685a8 |
| 固定 | tests/support/structure/source-repository.js | 1e984e1f17395fadbe64874f209238a9a27d16bfbdfa19c56b16fb27b79a126b |
| 固定 | tests/unit/draft-step-binding.test.js | e39daac92a821f81053a0ae374008ea6d171b90ead0913a869cb18f34013bc61 |
| 固定 | tests/unit/flow-engine-step-result.test.js | 282b0b5bbf76e15c17050acaea4c9eb3bbf6a3ee4f326e1f98eec81583e0e120 |
| 固定 | tests/unit/structure-rules.test.js | 04ef374fe80d6cacc4bab8bb8b8552dea8c0168694df455a05965bd9bbbef3f9 |
| M | tests/unit/structure-source-reader.test.js | d74178f0108bd0983df0dc48976bc89542bb3f19b1dc7d28f0de76207452dc06 |
| A | tests/unit/structured-step-result-contract.test.js | ca062071023e3eaa0e85158810c93cc2dbae16c9be4212c3021b017dcf8c9c8b |

再レビュー後の判定: 妥当とした2件の既知欠陥と関連bindingの見逃し・過剰拒否を修正し、上記の限定検証を満たした。静的に対応する閉じた形の保証であり、任意JavaScriptの全動作証明ではない。named generic adapterの外部実行terminalは将来工程が具体契約を宣言して追加する責務で、今はforwarding/helper形だけを認定する。Draft/Specの本番具体経路は既存検査を保持して検証した。未来production登録、Task専用Result実装、実effect・Git/OS transactionの工程受け入れ完了は主張しない。

変更は上記worktreeの未コミット差分として保存した。生ログ・隔離コピー・作業scriptはこの追補への集約後、今回所有する/tmp/fc21-fix-*だけを削除し、不在を確認した。検証記録と実装・test差分は保持している。

## lookup参照会計の修正・最終検証（2026-10-02）

この追補を最新候補の判定とする。基点は同じmanual worktree、branch `test/fc21-phase-contracts`、HEAD `c6a8bb26d18e0034f62e6a523fdda562ff6f7876`。追加変更はchecker、source reader、external execution contract、reader unitと本証跡の5ファイルに限る。以前のfc21差分は保持した。製品src、依存、runner、Flow状態、ボード、commitは変更していない。docs freshnessはstaleで、build提案済み。

### 要求・責務・保証範囲

正常な全登録Mapの初期化後に `byId.delete('second')` またはlookup関数の差し替えを追加すると、runtimeでStepが検索できなくなる一方、修正前checkerは合格した。これはA10の個別Step除外・閉じたlookup契約の不足であり、現行Draft/Specでその製品障害が発生したという主張ではない。

既存のSourceOriginUsageとlexical scope解析を再利用する。lookup名を全execution shapeから重複排除し、宣言全体、直接の全登録配列、Map初期化を確認した上で、lookup・Map・配列・そのaliasの未確認参照をまとめて拒否する。adapter側の同じ参照会計も共通化した。初稿の名前だけの会計が合法property keyとlocal parameterを拒否したため、管理者が差し戻した。SourceLexicalBindingsで既存scope解析を共通化し、moduleBindings opt-inではbinding identityを使う。非参照keyとlocal shadowは除外し、実際のouter capture、export alias、conditional armの参照は追跡する。未知sourceは実位置とtraceを持つA10 incomplete reportで拒否する。

既存A08/直接SourceOriginUsageおよびA11の既定追跡は保持し、global判定の既定結果も維持した。新たなparser、mutator名denylist、本番防御処理は追加していない。SourceModuleはlexical indexをキャッシュし、isUnbound/global抽出とmodule binding会計に再利用する。管理者probeで5 callersに対するcomposition origin scanが1回、複数origin/global利用でindexが同一であることを確認した。時間短縮率や任意JavaScriptの全動作証明は主張しない。

担当はgpt-6-astra/high（実装）、gpt-6.1-sol/high（新規回帰）、gpt-6-luna/medium（read-only独立レビュー）。Lunaはcollaboration thread制限のため別Codex CLIで実行し、最終の固定checker/readerを静的レビューした。最初のレビューは実装途中だったため最終候補判定に使っていない。管理者が差分、runtime再現、合法正例、拒否位置、解析再利用、限定統合検証を独立に確認した。

### 同一入力の比較と最終結果

比較はGit metadataを含まない隔離コピーで行った。新testだけをbeforeコピーへ配置し、元checker/reader/fixtureは保持した。live worktree、canonical状態、mainを修正前へ戻していない。既存期待値の変更、skip、syntax/import failureを検出成功に数える処理はない。

| 測定 | tests | pass | fail | skip | 生ログSHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| lookup修正前（同一新規11ケース） | 11 | 1 | 10 | 0 | 86026b658f2aacdae2654b5ae202a2c2f4859b6bee4f343aea544562effbf308 |
| lookup初稿修正後（同一11ケース） | 11 | 11 | 0 | 0 | da68ed22aa5667ad6407b0eac1080277369214d7d8be8ae17508e3f210f6c2ce |
| 過剰拒否修正前（新scope/reader4ケース） | 4 | 1 | 3 | 0 | 0c6eaf517690e5c1264daaeaf29befb88e8c340db9677773efd28e6289f80b3d |
| 過剰拒否修正後（同一4ケース） | 4 | 4 | 0 | 0 | 31e5381b2248ba056df666d85e8fea9961afe96c6f73024e57bc40eee414f3f0 |
| 追加boundary修正前（同一2ケース） | 2 | 1 | 1 | 0 | 4d830859d1879094218d3f139a1e02f89afaeb10c5bde8e854b19393c587dded |
| 追加boundary修正後（同一2ケース） | 2 | 2 | 0 | 0 | efaf544cec137f4aafae753b836cdc771630cc8b9f6f2828954561436fceda35 |
| 管理者・最終候補11ファイル | 205 | 205 | 0 | 0 | e3ac65fd8f884e43b84183bdebcf9d7766c690b0e094332ffae004a222c4d75c |

初回10負例は修正前の診断欠落をAssertionErrorで検出した。scope比較の3失敗は合法property key/local parameterの過剰拒否と未導入reader opt-inのAssertionError。boundary比較ではternary captureが以前のname-based修正でも拒否されたため、そのbefore passを既知欠陥検出と数えない。varケースのbeforeはreportにA10が欠けるAssertionErrorで、parser throwではない。afterは実var位置13:4、report型、trace、復旧成功を確認した。件数を合算しない。

比較の同一test hash: 初回external `fd26d747ad1756f6e2cec69336e365ed01f2320bff8b1600e20e50944d908067`、scope比較external `a83229c8d3f1bbc93955df5fd7677087e504f8c68a5eae49bd307c4a9a178b13`、boundary比較externalは次表の最終値。reader unitはscope比較・最終候補で同一。初期external hash `219ecb0572d9371ee098a8e9a909c40694f9a1765ba96044c2e12c1d7c1d072d`とは区別する。初稿checker hash `b49bb631242d2954fba772d3b8daa13947c9d1fa9e03499520bf8c6d0a3f44b7`と元readerをscope比較で固定した。

```sh
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/constructor-invariant-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/unit/structure-source-reader.test.js > /tmp/fc21-lookup-fix-final-targeted.log 2>&1
git diff --check
```

最終検証は205 tests / 205 pass / 0 fail / 0 skip / 0 cancelled、exit 0、292.939秒。全repository/full/実AI試験は実行していない。変更のない既存実DI・Result/Binding・保存/handoffの測定は前回の証跡を再利用し、この件数に加算しない。最終テスト開始時と終了後に4ファイルのhashが同じことを確認した。前回の33対象中、追加変更は以下4ファイルのみで、他の29ファイルは前回hashと一致する。

### 最新候補の固定ファイル

| ファイル | SHA-256 |
| --- | --- |
| tests/support/structure/checker.js | 1a47770340ba8a4ddc11c0bd14d5b6fddfe76f4e75a154f7e521fc7ca7458a1a |
| tests/support/structure/source-reader.js | 8cfcfa577ae486363b0382b7054c1f13a16ca7d42ed101c2778ce9aa0db97472 |
| tests/structure/external-execution-contract.test.js | a7667be9b6613d627757a67d372660ee720d835fa95306171679865f795e159a |
| tests/unit/structure-source-reader.test.js | 326472b7eb5c9b6e4decf6e3214cc35061d8e7854e0921ef329a85d3452e61ef |

管理者の最終独立probe生ログSHA-256: 35eaa11f84ecdcbde2a2ed52b1497d9df8018d80bb18ecb06020298135b52337。Map削除とlookup差し替えのruntime検索欠落を確認しつつ静的に拒否、property key/local parameter/member名の合法正例、outer capture、export、未知source拒否、変数名変更、復旧、走査とindex再利用を確認した。runtime評価は管理者の隔離probeのみで、structure suiteにsource評価は加えていない。

Luna最終read-only report SHA-256: 7ee60b6fa09b8dc64df15d2d193a0947c6aff216544e40f1321d732ea4801b83。同じ固定checker/readerについて必須修正なしという静的レビューであり、実テスト保証の代替にはしていない。

### 追加した17ケース（最終測定ですべてpass）

- named lookup binding integrity rejects map deletion and accepts restoration
- named lookup binding integrity rejects map reassignment and accepts restoration
- named lookup binding integrity rejects map mutation through an alias and accepts restoration
- named lookup binding integrity rejects map capability escape and accepts restoration
- named lookup binding integrity rejects lookup reassignment and accepts restoration
- named lookup binding integrity rejects lookup capability escape through an alias and accepts restoration
- named lookup binding integrity rejects registration selection mutation before map capture and accepts restoration
- named lookup binding integrity rejects registration selection alias mutation before map capture and accepts restoration
- named lookup binding integrity rejects an unknown conditional registration selection and accepts restoration
- named lookup binding integrity rejects a lookup parameter default and accepts restoration
- named lookup binding integrity accepts a renamed phase with unrelated map and function uses
- named lookup lexical identity accepts object property keys without treating them as outer bindings
- named lookup lexical identity accepts independent function parameters without treating them as outer bindings
- named lookup lexical identity rejects a helper that captures the outer map and accepts restoration
- named lookup inspection boundary rejects an outer map captured in a ternary arm and accepts restoration
- named lookup inspection boundary returns an incomplete report at unsupported source position and accepts restoration
- module binding origin accounting distinguishes lexical identity while preserving default behavior

完成判定: 明示したlookup参照会計の欠陥と修正で生じた過剰拒否を解消し、既存の構造/型/IO/登録/実行経路への影響を上記の限定検証で確認した。未来28工程の本番実装、Task専用Result、任意JSや実effect/Git/OS transactionの完全保証はこの判定に含めない。

検証後のcleanup: 生ログのhash・ケース結果・実行コマンドを本証跡へ記録した後、今回所有の隔離コピー、probe/CLI作業ファイル、生ログなど25 entriesを削除した。実装候補、元worktree、canonical状態は保持した。

## 正規entry・公開bindingの修正・最終検証（2026-10-03）

この追補を最新候補の判定とする。以前の候補hash・測定は履歴である。manual worktree `/home/nakano/workspace/sennel/.sennel/worktree/fc21-phase-contracts`、branch `test/fc21-phase-contracts`、HEAD `c6a8bb26d18e0034f62e6a523fdda562ff6f7876` は同じ。追加変更はchecker、source reader、external execution contract、reader unit、本証跡の5ファイル。以前の33対象のうち残る29ファイルは前回hashと一致する。製品src、依存、runner、Flow状態、ボード、commitを変更していない。docs freshnessはstaleで、build提案済み。sourceを根拠とする。

### 要求・実装・管理者確認

- 正しい宣言の後にcaller `direct = () => null`、receipt helper `replayReceipt = () => null`、loader `loadCommand = () => null` を置いても旧checkerが合格した。管理者のnative Node ESMでは、directの検索/select/executeが省略され、receiptの返却とloaderのmodule取得も差し替わる。A10の正規経路・selection・receipt消費を維持する共通契約の不足として修正した。
- 既存SourceOriginUsage、module binding identity、cached lexical index、`#declaredBindings`を再利用。ExecutionEntryBindingsに検証済みcaller/receipt/loaderのorigin、承認token、public名をmodule単位で集約し、複数shapeを確認した後に1回検査する。A11の承認caller/loader tokenも全shape分を集約してから既存reverse scanへ渡す。lookup/adapterの責務とは別に保つ。
- SourceDeclarationに宣言prefixと完全なplain function照合を所属させ、既存lookupのasync位置探索とadapterのexport位置探索を共通APIへ置換。現在の固定caller(input)/receipt(receipt)/loader()以外のdefault/extra parameters、async、generatorを対応済み形として受理しない。SourceExportはlocal tokenを保持し、既存name/local/referenceの利用を維持。同名asのexport走査skipも既存解析内で訂正した。新parser、scanner、mutator denylist、依存、個別class除外は追加していない。
- 正規の同名local public exportを受理し、再代入、alias escape、private helper公開、別local/reexportへの公開slot差し替えを共通会計で拒否する。管理者が仮候補のlookupとnamed contract公開slotにも同じ漏れを実測したため差し戻し、静的に確認したlookup・登録配列・named contractまで同じpolicyを適用した。正規登録配列のinline/local exportは受理し、lookup Mapはprivateとして扱う。
- 225件合格後、管理者がlocal directを残したままforeign `export *`で公開slotを置換できることをnative ESMで再現した。共通policyを再修正し、canonical explicit exportが確認できないtracked public名へのwildcard公開は未解決として拒否する。explicit named exportはESMの優先順位でforeign wildcardの同名exportに優先するため、inline/localとも受理する。export順序に依存せず、wildcard一般の禁止やpublic export存在の新必須化は行わない。
- 管理者は差分を読み、3roleのnative ESM動作、違反の実位置/trace、正常export、private公開、復旧、共有module/shape、解析再利用を独立確認した。2 forms・5 callers・1 receipt helper・1 loaderを同一moduleに置くprobeでentry origin scanは1回、origin/global利用でlexical indexは同一であった。最後のwildcard差分はこの集約・cacheを変更しない。時間短縮率は主張しない。

担当はgpt-6-astra/high（実装）、gpt-6.1-sol/high（新規回帰）、gpt-6-luna/medium（read-onlyレビュー）。Astra/Solは既存sub-agentを再利用。thread上限によりLunaは別Codex CLIで実行し、最終4ファイルhashの一致を確認した。最初のLuna判定と225件測定だけで完成とせず、管理者の追加反例を差し戻した後の再レビューを最終候補へ適用した。Lunaはテストを実行していない。最終レビューで必須の追加指摘なし。

### 比較と検証scope

beforeはGit metadataなしの隔離コピー。元worktree、canonical状態、mainを過去状態へ戻していない。各比較群の同じシナリオ入力・assertをbefore/afterへ置き、新規/未確認caseのみ選択実行した。新caseの追加で完全test fileのhashが変わる段階と、各群の比較を区別する。既存期待値変更・skip・syntax/import失敗による見せかけの検出はない。

| 比較群 | before | after | 判定 |
| --- | --- | --- | --- |
| entry保全/default等10＋shared forms/public entry3 | 2 pass / 11 fail（10と3を別実行） | 13 pass / 0 fail（まとめて選択実行） | missing diagnosticとshared formsの過剰拒否はAssertionError |
| lookup/public contract5 | 1 pass / 4 fail | 5 pass / 0 fail | slot欠落3件とcanonical lookup/array exportの過剰拒否1件 |
| reader新API2 | API欠落で2 fail | 2 pass / 0 fail | TypeError/AssertionError。既知runtime欠陥検出へ加算しない |
| wildcard3 | 2 pass / 1 fail | 3 pass / 0 fail | 未確定slotのA10欠落をAssertionErrorで検出 |

新規はstructure21＋reader2。負例はrule、source position、traceと違反除去後の成功を確認する。正常な同名export、property key、local parameter、複数caller/loader、複数formの共有moduleも受理する。全測定でskipは0。structure suiteへのsource評価は追加せず、runtime評価は管理者の隔離probeに限る。

初期before sourceはchecker `1a47770340ba8a4ddc11c0bd14d5b6fddfe76f4e75a154f7e521fc7ca7458a1a`、reader `8cfcfa577ae486363b0382b7054c1f13a16ca7d42ed101c2778ce9aa0db97472`。公開lookup/contract比較の仮候補checkerは `6f923e54c50c5284124c2c8df52366fc3c64440cfa7ae7957a0e9cd81064f600`。wildcard比較beforeは `7d2b7c81a7f0e8a694c5cd0f8c7cf3968fd67bc948ad9219f28067768bbe4bd9`。この2仮候補readerは次表の最終readerと同一。初回10case時external全bytesは `68b8a8f44a415f404a89e924ad53cc3dece4674d5467e7bdc3c0627a54e1bfe0`、13case時は `863b12aca3bc79a306c8de4a38a1cd4db66805fec1b1df844a3105c5277c0e99`、公開5比較時は `ee08f67afa930daf2005fbbff12cf2f4ae5c2f7e5060ad0c9740cb1380643dce`、wildcard比較は次表の最終external。reader新API比較は次表の最終unit。

```sh
node --test --test-name-pattern='declared route binding' tests/structure/external-execution-contract.test.js
node --test --test-name-pattern='declared route reader' tests/unit/structure-source-reader.test.js
node --test --test-name-pattern='declared route binding public' tests/structure/external-execution-contract.test.js
node --test --test-name-pattern='declared route binding wildcard' tests/structure/external-execution-contract.test.js
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/constructor-invariant-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/unit/structure-source-reader.test.js > /tmp/fc21-caller-final-targeted.log 2>&1
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js > /tmp/fc21-caller-final-named-scopes.log 2>&1
git diff --check
```

選択コマンドも実測では先に各logへredirectし、beforeは隔離コピーの対象fileを指定した。追加3のbefore選択は `declared route binding preserves callers from two|declared route binding rejects .* replacement of a canonical`。担当は既存全fileを再実行せず、管理者だけが限定11ファイルを実行した。

管理者11ファイル: 225 tests / 225 pass / 0 fail / 0 skip / 0 cancelled、exit 0、283.517秒。この測定sourceはchecker `7d2b7c...`、readerは最終と同一、externalは公開5比較時のhash、unitは最終と同一。その後の差分はNamedExecutionShapeがある場合だけ呼ばれる共通binding検査のwildcard branchと新3cases。利用箇所を検索し、影響するstaged scope/external executionの2ファイルを最終sourceで再検証: 95 tests / 95 pass / 0 fail / 0 skip / 0 cancelled、exit 0、3.415秒。reader、legacy Draft/Spec routing、型/IO、production integrationの検証入力と実行経路は最後の差分で変わらないため11ファイル測定を再利用する。両測定を足した320件とは数えず、228件を最終codeで一括実行したとも扱わない。最後の4対象hashはNamed scope再実行後も同一。

### 最新候補hashとログ

| ファイル | SHA-256 |
| --- | --- |
| tests/support/structure/checker.js | 61250b149e1ee3e33cf4df08e73431d8fe438313893728ddd066acc68f370739 |
| tests/support/structure/source-reader.js | 005b07c3e365e39a360bae8adb7ea34763d09fb7a1142de9527c4c68e2a82375 |
| tests/structure/external-execution-contract.test.js | 23dba79b0d1fe99e928fa1bcb0b776aa66377d1cb9df52d77aeb87d8981c102b |
| tests/unit/structure-source-reader.test.js | 9f462f5e88b097e705716b25debf0bf97bd24da2c3f2894c34aa0a6960105aa0 |

| 生ログ | SHA-256 |
| --- | --- |
| fc21-caller-tests-before.log（10） | 503711917146c3cbed8b7893ca932def39f5194869156bf946b572e21519c11f |
| fc21-caller-extra-tests-before.log（3） | 9a733d0d5517a68ece2ebb2c8fb7b056ca26bfc154eea25d93a6b844c5c10ef4 |
| fc21-caller-tests-after.log（13） | c09fdeef39c2f67767a25489785fa4976ceece74cfd571feb8891a6a47cb5a4a |
| fc21-caller-reader-tests-before.log | 4cfb4804eb561b182e6734ce1779f88d9c51ec9c505ba3f3e5b3f4174e222803 |
| fc21-caller-reader-tests-after.log | 6553b4512f07595781e983eee9faa1470dcc5c2ff4fc9963df5bf945d5a03a48 |
| fc21-caller-public-tests-before.log | bacedfc37fbe25f4434822815ff679de20272d6f4aae245cf31fd0b20df30098 |
| fc21-caller-public-tests-after.log | 7e56527a697bccd3256e9499f3fea7728671ce11af9e62a43b61385c5300e1fa |
| fc21-wildcard-tests-before.log | 031c0f72b00a77d83cce0bb26aa3b7571804fd3fa462001d574a11c334deab90 |
| fc21-wildcard-tests-after.log | ec8a45ee83819326062cab394120ffccf733ed2ecedde5a7a153337051ae833a |
| fc21-caller-final-targeted.log（225） | f0b86db3056955ea272c01428dec6004444c170513c7fbb432c0fe1e116b30a3 |
| fc21-caller-final-named-scopes.log（95） | ff48247c70127de20dffa7d13eb3514ee3eb1209745ecb720864067f0a9fb287 |
| 管理者native ESM/binding/集約/cache probe | 087059bc33a07385a6d4b606bd838fc01201e4b1053d19037815683b1f81f9c1 |
| 管理者最終wildcard3境界/native precedence probe | cd13fac6d7ffaf99612065fd772c072b5c60ecedf78e099430c7e84bded0b509 |
| Luna最終read-only report | ff8d2bb46118730a2b8f2e1f0f40922609e6723c73edd0e0d0a79c44642782b7 |

完成判定: 指摘したentry binding保全と、管理者が同じproducer→公開lookup→caller契約で見つけた公開slotの見逃しを修正した。共通API再利用、正規形の保持、負例/復旧、実行経路、解析再利用を上記の限定検証で確認した。全repository/full/実AI試験は実行していない。未来28工程の製品実装、Task専用Result、任意JavaScriptの全動作や実effect/Git/OS transactionの完全保証はこの完了の範囲へ追加しない。以前の未達契約の所有フェーズは維持する。

### 新規case別の最終結果

| case | before | 最終対応scope |
| --- | --- | --- |
| declared route binding rejects caller reassignment and accepts restoration | fail | pass |
| declared route binding rejects caller alias escape and accepts restoration | fail | pass |
| declared route binding rejects receipt helper reassignment and accepts restoration | fail | pass |
| declared route binding rejects receipt helper alias escape and accepts restoration | fail | pass |
| declared route binding rejects loader reassignment and accepts restoration | fail | pass |
| declared route binding rejects loader alias escape and accepts restoration | fail | pass |
| declared route binding accepts canonical named exports, property keys, and independent parameters | pass | pass |
| declared route binding rejects an unverified caller parameter default and accepts restoration | fail | pass |
| declared route binding rejects an unverified loader parameter default and accepts restoration | fail | pass |
| declared route binding preserves multiple callers and loaders sharing their modules | pass | pass |
| declared route binding preserves callers from two registered execution forms in one module | fail | pass |
| declared route binding rejects local alias replacement of a canonical public caller export and accepts restoration | fail | pass |
| declared route binding rejects reexport replacement of a canonical public caller export and accepts restoration | fail | pass |
| declared route binding public lookup rejects local alias slot replacement and accepts restoration | fail | pass |
| declared route binding public lookup rejects reexport slot replacement and accepts restoration | fail | pass |
| declared route binding public lookup accepts canonical local lookup and registration array exports | fail | pass |
| declared route binding public adapter contract rejects slot replacement and accepts restoration | fail | pass |
| declared route binding public adapter contract accepts a canonical local contract export | pass | pass |
| declared route binding wildcard rejects an unresolved public caller slot | fail | pass |
| declared route binding wildcard accepts an explicit inline export over a foreign implementation | pass | pass |
| declared route binding wildcard accepts an explicit local export over a foreign implementation | pass | pass |
| declared route reader distinguishes complete function shapes and declaration prefixes | 新API欠落 | pass |
| declared route reader keeps local export tokens distinct from aliases and reexports | 新API欠落 | pass |

検証後のcleanup: source/test/log hash、case別結果、コマンド、管理者probe、最終reviewを上記へ記録し検証した後、今回所有の隔離コピー・作業script/prompt・生ログなど29 entriesを削除して不在を確認した。実装候補、元worktree、canonical状態は保持し、commitは作成していない。

## IO境界・間接公開経路の再監査（2026-10-03）

この追補と末尾の最終測定を今回の修正判定とする。以前の候補hash・測定は履歴である。manual worktree、branch、HEADは前節と同じ。今回の変更はchecker、source reader、external execution contract、Service contract、reader unit、本証跡の6ファイル。開始時に固定した33入力の残る28ファイルは同じhashである。製品src、依存、runner、Flow状態、ボード、commitを変更していない。docs freshnessはstaleで、build提案済み。コードを判定根拠とする。

### 妥当性の根拠と修正範囲

ボードの「実行経路契約」「IO境界と保存操作」「必須検証」の具体的な不足に限定した。任意JavaScript全体の動作証明や後続28 leafの製品実装を追加要求していない。

| 契約 | 独立に確認した不足 | 修正の責務 |
| --- | --- | --- |
| A11: 正規lookup callerの閉じた集合とselection消費 | wildcard/multi-hopのbarrelからlookupまたはexecution adapterを取得し、未登録callerがselectionを捨てて実行できる | 既存export resolverとreverse reference検査で公開bindingの由来を照合 |
| A08: helper/getter/optional access/aliasのIO境界 | 呼ばれるhelperのoptional member、生成直後のmember、instance alias、親member、明示super、field初期化のIOが到達検査から落ちる | 共通member読取りと既存Service到達検査を接続し、生成時と呼出時の処理を区別 |
| A08: 検査したhelper bindingの実体 | 純粋な宣言後の再代入、destructuring、alias capture、live委譲、親binding差し替えによって実行時だけIOとなる | 既存lexical identityに書込みindexを追加し、到達bindingの安定性を検査 |

管理者の隔離native ESM probeは実StepRegistrationのcreate()から実Serviceを準備して呼び出す。helperの実IOはsentinelへのfs.existsSync呼出回数で区別し、pureは0、負例は1である。wildcard経路は実StepExecutionContract.execute(null,input)が呼ばれ、selectionを捨てた結果がnullであることを確認した。structure suiteへlive Service生成やsource評価は加えていない。

### 既存APIの再利用と性能上の確認

- class専用export resolverをcanonical SourceDeclarationHeaderを持つResolvedSourceBindingへ共通化し、class解決をその射影として維持した。明示export、local alias、named/star再export、ambiguity、cycleの既存責務内で追跡する。cycle途中の不完全なexport集合をcacheへ固定しない。
- wildcardではSourceReference.bindingsが空であることを踏まえ、既存SourceExportで公開名を列挙する。正規の明示safe exportの優先順位と、純粋なdiamond/cycleを受理する。wildcard全般を禁止しない。
- module declaration headerを一度だけindex化し、実際に選択した宣言の本文だけ既存readDeclarationで読む。scope外の合法なvarやsemicolonless value exportはlexical-onlyのまま扱う。
- SourceBindingWriteはcached lexical indexを共有する。直接/複合代入、update、destructuring/rest、forの書込みをbinding identityで数え、property keyや独立parameter、for(let...)のlocal shadowをouter bindingへ誤帰属させない。到達bindingをmodule単位に集約して検査する。
- readInvocationsとreadMemberAccessを共有し、生成receiver、optional access、alias、継承、this/superをService到達検査へ接続した。class member、instance field、static field/block、計算キーのbalanced抽出はSourceClassMembersへ集約し、既存readClassMemberも同APIを利用する。純粋なfieldと未呼出methodを受理し、直接arrow/function fieldの本文は呼出時に検査する。
- 同名static/instance memberを区別する修正は同じindexの責務内で行う。ServiceClassReceiverはclass identityとreceiver kindを保持し、this/super/継承とvisited keyへ引き継ぐ。汎用readClassMemberのkind未指定時のsource順選択は維持する。

管理者の計測では24 source filesを各1回readし、成功した19 relative edgesを各1回resolveした。失敗resolveは診断contextのためcacheしない。到達helper moduleのbinding-write検査は1回だった。wall time短縮率は主張しない。

### 指摘・修正自体の過剰さの確認

- Lunaのnamespace reexport、multi-declarator bypassの2指摘は管理者の反例で既存A11/A10拒否を確認し、撤回された。対応コードを追加しなかった。
- Lunaのtop-level純粋newが未呼出methodのIOを誤検出するという例も、同じ提示条件で現在・前候補とも合格しnative IO0だった。指摘を取り込まなかった。
- 一方、同名static/instance memberの取り違えは管理者が実IO1の見逃しと、実IO0の過剰拒否を確認した。修正前のclass indexとreceiver解決に根拠があるA08の不足として差し戻した。static継承→super→thisの接続にも同じ漏れを再現した。
- 仮修正がscope外のsemicolonless exportを本文解析してthrowする回帰を管理者が検出し、header/bodyの共通API境界を修正した。純粋なliteral計算fieldまで未解決として拒否する仮修正も差し戻した。
- reader追加caseのrest位置期待値45は文字列の実位置47と不一致だったため根拠付きで訂正した。入力と書込み集合は変えていない。cache probeの初稿は失敗resolveを成功cacheと同列に数えていたため計測対象を訂正した。どちらも実装の失敗を期待値変更で隠す操作ではない。

未知の到達computed accessや置換可能なbindingの拒否は「実IOを証明した」と扱わず、静的に正当性を確認できないshapeのfail-closedとして区別する。prototype改変や任意JS全体の解釈を追加していない。

### 比較方法と既知障害の検出

元worktreeをresetせず、Git metadataなしの隔離コピーへ同じ新シナリオ入力とassertを置いて比較した。比較用コピーのtest bytesは新caseに合わせて更新するため、開始時33入力の不変確認には別途保存したpreflight hashを使う。コピーから除外された既存fixture内.sennel/config.jsonはGit HEADとの一致も確認した。

| 比較群 | beforeの結果 | afterの根拠 |
| --- | --- | --- |
| 間接公開route 7 | 3 pass / 4 A11欠落fail | 7 passと同名safe export/diamond/cycle維持 |
| helper到達/binding 12 | 2 pass / 10 A08欠落fail | 12 pass、pure復旧、optional/alias/影響しないshadow |
| destructuring/reexport/computed this 3 | 1 pass / 2 A08欠落fail | 3 pass。public helper reexportは以前から拒否できた |
| reader新API 3 | API欠落で3 fail | API/metadata契約。runtime欠陥検出には数えない |
| scope外semicolonless export 1 | 元候補pass、仮修正throw | 本文を選択しない共通header APIでpass |
| inherited member/implicit constructor 2 | 2 A08欠落fail | 2 pass、own override優先とpure復旧 |
| ancestor binding 1 | 1 A08欠落fail | 親class実位置3:1、binding診断、trace、復旧 |
| class初期化/super/callable field 4 | 4 A08欠落fail（2群で実行） | 生成時IOと呼出時IO、pure/未呼出、復旧 |
| static/instance identity 3 | 別途末尾に記録 | direct receiverの両順序とstatic this/super接続 |

継承のloop caseはbeforeの最初のoptional methodで停止したため、getter/通常method各formを個別にbefore検出したとは主張しない。class evaluationのbeforeは最初のstatic field、callable fieldのbeforeは最初のarrow呼出で停止した。static block/計算key/function expressionはafterの分岐coverageであり、独立したbefore検出と混同しない。unknown computed member負例の一部はpure入力であり、未解決shapeの拒否契約である。

開始時before sourceはchecker `61250b149e1ee3e33cf4df08e73431d8fe438313893728ddd066acc68f370739`、reader `005b07c3e365e39a360bae8adb7ea34763d09fb7a1142de9527c4c68e2a82375`。static/instance比較beforeはchecker `55cb7e381463bd1b6c9ebb1e6ca7950a9e02356d42950d541cbce3f2a57f0290`、reader `14408f07d227d3fccdddf768634efee0825e5e014235c5e8fb268472de777513`。

### テスト実行と所有フェーズ

担当はgpt-6-astra/high（checker/reader）、gpt-6.1-sol/high（限定回帰）、gpt-6-luna/high（read-onlyレビュー）。Astra/Solは既存sub-agentを再利用し、thread上限のためLunaは別Codex CLIで実行した。担当の結果を管理者がそのまま採用せず、差分とnative実行で指摘を反証/確認し、複数回差し戻した。担当は新caseだけ、管理者は共有APIの影響範囲を検証する。

中間候補の関連15ファイルは298 pass、その後の到達修正で305 tests / 305 pass / 0 fail / 0 skip / 0 cancelled、exit 0、175.629秒。最後のstatic/instance変更はこの305件測定後なので、305件を最終hashで一括実行したとは扱わない。最終差分の影響測定と再利用の根拠は末尾に記録する。全repository/full/実AI試験は実行していない。

```sh
node --test tests/structure/staged-scope-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/constructor-invariant-contract.test.js tests/structure/service-contract.test.js tests/structure/step-execution-contract.test.js tests/structure/execution-routing.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/integration/structure-production-contract.test.js tests/integration/structure-registration-source.test.js tests/integration/structure-checker.test.js tests/integration/structure-phase-manifest.test.js tests/unit/structure-source-reader.test.js tests/unit/structure-graph.test.js tests/unit/structure-rules.test.js > /tmp/fc21-io-route-final-initialization-targeted.log 2>&1
git diff --check
```

Result拡張の初期検出は別scope: 17 tests / 2 pass / 15 intended contract fail / 0 skip / 0 cancelled。具体class/Definition APIの未達をAssertionErrorで検出し、syntax/import失敗ではない。test hash `ca062071023e3eaa0e85158810c93cc2dbae16c9be4212c3021b017dcf8c9c8b` と製品srcが不変なので測定を再利用する。02フェーズの実装所有を維持し、今回の合格scopeへ混ぜない。実DI/receipt/handoffの不変入力は以前の測定を再利用し、今回の件数に加算しない。


### 同名member修正後の最終測定

修正前の新3caseは3 fail。static IO欠落、pure instanceの過剰A08、static super→thisのIO欠落をAssertionErrorで検出した。同じtest bytesの修正後は3 pass。loopの後続宣言順序とinstance delegationはafterの分岐coverageで、beforeの先頭失敗と区別する。

管理者の最終測定は次の7ファイルに限定した。最終checker/reader/test hashで194 tests / 194 pass / 0 fail / 0 skip / 0 cancelled、exit 0、122.553秒。今回追加した36caseはこの測定にすべて含まれる。

```sh
node --test tests/structure/service-contract.test.js tests/structure/external-execution-contract.test.js tests/structure/draft.test.js tests/structure/spec.test.js tests/unit/structure-source-reader.test.js tests/integration/structure-registration-source.test.js tests/integration/structure-production-contract.test.js > /tmp/fc21-io-route-final-member-kind-targeted.log 2>&1
```

最後の変更はA08の明示receiver kindとclass member indexのkind選択に限定される。generic kind未指定の既存読取りはsource順を維持し、A10/A11の実行shape、scope/manifest、constructor invariant、graph/rulesの判断を変更していない。影響するService/helper、legacy Draft/SpecのA08、public route、production registration、共通readerを最終7ファイルで再検証し、それ以外は前候補305件測定を再利用する。両測定を合算した件数や、全caseを最終hashで一括実行した結果として扱わない。

管理者は最終hashでnative22caseを再実行し、pure受理、実IO拒否、binding置換、class初期化、継承、selection破棄の診断を確認した。さらに同名static/instanceとstatic super→this、pure top-level constructionのnative4caseを確認した。Lunaのpure-new指摘は最終レビューでも撤回され、最終static/instance差分に追加の必須指摘なし。レビューは実テストの代替にしていない。

| 最終ファイル | SHA-256 |
| --- | --- |
| tests/support/structure/checker.js | f1403195608730ce5032bc8724adcf5b40eacb296b9fcec40e84f3dd2c88445b |
| tests/support/structure/source-reader.js | 5a576eaa679a4b1f1b6571cb811afe3e2976fa8a413620839e8356ca9ee9bbad |
| tests/structure/external-execution-contract.test.js | dec08b43413d8a481a649fa73f0d9b44e6675752b74f8eac64e2ce6d99f344d1 |
| tests/structure/service-contract.test.js | f211baacad8b7fd945623a224d3a3481ffb842098ccbe3b964bb28f1ba403f56 |
| tests/unit/structure-source-reader.test.js | 2c87f4d859b4d36732e9c93762c4444ae42e7d9325a19f1c388273ecfad00e2e |

テスト開始時、完了後、最終read-onlyレビュー後に上記hashの一致を確認した。33入力のうち変更は上記5ファイルだけで28入力は不変。本証跡を含めた6ファイルが今回の所有差分である。git diff --checkもpass。

| 生ログ（/tmp/以下） | SHA-256 |
| --- | --- |
| fc21-reaudit-route-before.log | dd93438143cd4e0f4008a20e2ccecfb608582abcfffd21bbdc268306e8369283 |
| fc21-reaudit-service-before.log | 56a8b6ab5d13cfdccddbee77a538d6f35c19d4acf473f9e1f2fe20f9765ab4b3 |
| fc21-reaudit-service-extra-before.log | e5beb677ad6f96df5b5245fe8b7f0096f8dcb527f2b9e9ee294302e8b44403a9 |
| fc21-reaudit-reader-before.log | f9cd7f4902da0df09b8483291bea7c9a468e37487cc422f9d57c175d936f35d6 |
| fc21-reaudit-semicolon-candidate.log | 99ec458d8d04dd174ddce35f8342ae3cec9916fe8d97d6e165f2fd026396b6ad |
| fc21-reaudit-inherited-before.log | e41998e3b2c000ff511da49f17d720e172a877f0dc06877bab3d5827777e7b63 |
| fc21-reaudit-ancestor-binding-before.log | 5c2271c3599d18375b64aff2bf232d3eb041afc0834edbde843d76ef97bc9e22 |
| fc21-reaudit-initialization-before.log | 6eb87254961cd86dcbad22efc3929965444fe01500588d85961625d6867b72c5 |
| fc21-reaudit-initialization-extra-before.log | de73574dc9be4c3393a2768c3d9df914edf33ae0fef4c0f9a82d2bcede8b2f1b |
| fc21-reaudit-member-kind-before.log | c93ae52551daf87d9202e96654d829a7deffbcaaf4382162a156fb525261e44e |
| fc21-reaudit-member-kind-after.log | 4245c6c472b6c6f86acef7df4e51dc77e1e06ac4f3eeba799db51473ad700888 |
| fc21-io-route-final-initialization-targeted.log（305） | f5f4e7d7c32f49d79e5fd91969ef269bf9ec9f3cf48e0bf05eea78d3328d623d |
| fc21-io-route-final-member-kind-targeted.log（194） | 94970d0611e1fcdffa2078c1dd3f0915db5dac67884c87a263f711ae75ecc89a |
| fc21-io-route-manager-member-kind-final.log（native22） | e4d70923de6ab5924886fc0e006d2b4a64148384da347eea941cab290612b88f |
| fc21-io-route-review-extra-static-before.log | 061b4cca6e1f1a1a311ccf379e3989e1a85d79a4ef89059307ac76daf4aec18e |
| fc21-io-route-review-extra-static-after.log（native4） | df2858a41fc1d9db78128030367f24c82aec6cec6b21163c1e0d2919b8df2a7a |
| fc21-io-route-manager-cache-member-final.log | 6e055aca6b803d4e033c356e97fe07d8c60b96c6a4b657cc9271ae6a38214a1a |
| fc21-io-route-luna-member-final-report.txt | 75341a3b75ad30d0bf84d1c1886892df609a0524dd2b0e7ecb44f13a963f0fda |
| fc21-reaudit-result.log（別scope） | b5885911ed8eac81efd2c4e0ef35da8cbb372072918fcdc41dbc754d47d51011 |

### 新36caseの最終結果

| case | 最終7ファイル測定 |
| --- | --- |
| reaudit indirect route rejects a wildcard lookup capability escape and accepts restoration | pass |
| reaudit indirect route rejects a wildcard adapter capability escape and accepts restoration | pass |
| reaudit indirect route rejects a multi-hop lookup bypass that discards selection and accepts restoration | pass |
| reaudit indirect route rejects a multi-hop adapter bypass that discards selection and accepts restoration | pass |
| reaudit indirect route accepts unrelated names, another phase, and lexical-only outside var | pass |
| reaudit indirect route accepts a semicolonless unrelated value export without parsing its body | pass |
| reaudit indirect route accepts an explicit safe lookup export over a watched wildcard | pass |
| reaudit indirect route accepts a pure same-binding diamond with a wildcard cycle | pass |
| reaudit Service member follows ordinary method into IO and accepts a pure restoration | pass |
| reaudit Service member follows optional method into IO and accepts a pure restoration | pass |
| reaudit Service member follows optional getter into IO and accepts a pure restoration | pass |
| reaudit Service member follows optional static method into IO and accepts a pure restoration | pass |
| reaudit Service member follows optional constructed method into IO and accepts a pure restoration | pass |
| reaudit Service member follows optional instance alias into IO and accepts a pure restoration | pass |
| reaudit Service member refuses an unresolved optional computed member and accepts a named pure member | pass |
| reaudit Service binding rejects direct function reaching a replaced IO function and accepts restoration | pass |
| reaudit Service binding rejects alias captured after replacement reaching a replaced IO function and accepts restoration | pass |
| reaudit Service binding rejects live delegation after replacement reaching a replaced IO function and accepts restoration | pass |
| reaudit Service binding rejects replacement of the alias binding reaching a replaced IO function and accepts restoration | pass |
| reaudit Service binding accepts pure helpers with unrelated reassignment and distinct local shadows | pass |
| reaudit Service binding destructuring rejects a reached IO replacement and accepts restoration | pass |
| reaudit Service reexport follows the public helper instead of a private same-name declaration | pass |
| reaudit Service member delegation refuses computed this access and restores named pure calls | pass |
| reaudit Service inherited members follow parent IO and preserve own override priority | pass |
| reaudit Service inherited constructor follows implicit parent initialization and accepts pure restoration | pass |
| reaudit Service ancestor binding rejects replacement reached through an inherited member | pass |
| reaudit Service initialization inspects instance fields while leaving uncalled methods outside the closure | pass |
| reaudit Service initialization follows explicit super calls while leaving uncalled parent methods outside the closure | pass |
| reaudit Service initialization inspects class evaluation fragments while preserving uncalled methods | pass |
| reaudit Service initialization keeps function field bodies deferred until the field is called | pass |
| reaudit Service member kind rejects static IO after inspecting an instance member in either declaration order | pass |
| reaudit Service member kind keeps uncalled static IO outside an instance call in either declaration order | pass |
| reaudit Service member kind preserves receiver kind through inherited super and this delegation | pass |
| reaudit reader identifies binding assignments and updates without treating RHS reads as writes | pass |
| reaudit reader resolves pattern and loop writes by lexical identity and preserves its cached index | pass |
| reaudit reader exposes inline public bindings without changing lexical-only reference parsing | pass |

完成判定: ボードの実行経路・IO境界で実測した検出漏れと、修正で生じた過剰拒否を解消した。共通API、正例/負例/復旧、既存利用への影響、実行時の動作、解析再利用を限定測定で確認した。後続フェーズの製品実装、Result拡張の未達契約、任意JavaScriptやeffect/Git/OS transactionの完全保証は以前の所有範囲を維持する。今回の隔離比較・生ログは再監査用に/tmpへ保持し、元worktree/canonical状態を戻していない。commitは作成していない。

## 未導入Result契約の通常テストからの分離（2026-10-03）

この追補をResult検査の現行配置・実行方法とする。以前のファイル名とコマンドは当時の測定履歴である。mainへマージした場合の確認で、今回新設した `tests/unit/structured-step-result-contract.test.js` が通常 `npm test` のunit選択に含まれ、02フェーズの未実装APIを検出する15失敗が通常回帰へ混入すると判明した。既存製品や既存テストの新たな故障ではなく、未導入契約を今回追加した配置の問題である。

### 修正と所有範囲

- 同じ本文を `tests/unit/structured-step-result.contract.js` へ移した。移動前後、専用実行後のSHA-256は `ca062071023e3eaa0e85158810c93cc2dbae16c9be4212c3021b017dcf8c9c8b` で一致する。
- package script `test:contract:result` を `node tests/run.js --file tests/unit/structured-step-result.contract.js` とした。通常の `*.test.js` discoveryと既存の明示file選択を再利用し、runner、suite定義、個別除外、skip、環境分岐、アサーションを変更していない。
- unit AGENTSとボードfc21の対象ファイル・専用コマンドを合わせた。02フェーズで実装した時点で同じ契約を通常 `.test.js` へ移し、通常unitと02受け入れscopeで実行する。導入済み機能の失敗を通常テストから外す規則にはしない。
- 今回の追加変更はpackage.json、Result契約の配置、tests/unit/AGENTS.md、本証跡、ボードの該当記載のみ。製品src、共通checker/reader、Flow、mainの作業差分、commitを変更していない。

担当は既存Astra（最小実装）とSol（選択・専用実行のreadonly検証）。管理者は差分、本文一致、実選択集合、失敗種別、ボード差分を独立に照合した。変更のない194件の構造/reader測定は再利用し、再実行や合算をしていない。

### 限定検証

```sh
node tests/run.js --list --json
node tests/run.js --scope unit --list --json
node tests/run.js --scope structure --list --json
node tests/run.js --all --list --json
npm run test:contract:result -- --list --json
npm run test:contract:result
node --test --test-name-pattern='runner manifest' tests/unit/runner-manifest.test.js
```

各コマンドは生ログへredirectしてから確認した。listは実行対象の読取りであり、フルテストは実行していない。

| 検証 | 結果 |
| --- | --- |
| 通常default選択 | 497から496へ。旧Result契約1ファイルだけが除かれ、他の全filesはdeepEqualで不変 |
| 通常unit選択 | 110 files。通常defaultのunitと同集合、未導入契約の新旧pathを含まない |
| structure選択 | 8 files。通常defaultのstructureと同集合、既存scope不変 |
| all選択 | 505 files = 同じnon-agent 496 + 現agent 9。未導入契約は含まない |
| 専用Result選択 | 新contractファイル1件だけ、list exit 0 |
| 専用Result実行 | 17 tests / 2 pass / 15 intended fail / 0 skip / 0 cancelled、exit 1 |
| 既存runner manifest | 2 tests / 2 pass / 0 fail / 0 skip、exit 0 |

専用検査の15失敗はすべて未導入engine export/SettlementのAssertionError。child execution recordはcompleted=true、kind=assertion-failure、exitCode=1。syntax/import/setup失敗やskipで未達を置き換えていない。今回の原因が通常選択から分離されたことを確認した結果であり、通常497/496ファイル全部の成功を測定した結果ではない。

| 生ログ（/tmp/以下） | SHA-256 |
| --- | --- |
| fc21-result-selection-default.json | 74031c06308a5de128347a56eff53822c314e8b0ab9ffa54fe9ac6b52d87a8a3 |
| fc21-result-selection-dedicated.log | 4301fa8d5e8b5e5cb7bfd02c79eddfc44799d766777089e44eb6bb7be57d765a |
| fc21-result-selection-compare.log | 3ea0a8f1bc6fd7217666d088015a9c12d958ea0694931a62175618a34c171cef |
| fc21-result-contract.log | 639d8f6e252c0fb32de633b7ff3f2d0596e2538718d41cdc237eab32e7a67f47 |
| fc21-result-runner-manifest.log | 3e493843f6b08eeff2ba93c8f496a640b746b50e789d44b497b7112509b7ef9b |

package.jsonの修正後SHA-256: `e302d28e8802805bc0fcaad90a34bb882300d3f2e8d613d3c05d41bffba1d0b2`。以前のchecker `f1403195608730ce5032bc8724adcf5b40eacb296b9fcec40e84f3dd2c88445b`、reader `5a576eaa679a4b1f1b6571cb811afe3e2976fa8a413620839e8356ca9ee9bbad` は不変。

管理者の最終照合は `/tmp/fc21-result-root-verify.log` に記録した。ボード更新後の読み戻し本文は更新用body-fileと完全一致し、id/status/title/category/issue参照は保存された。通常選択の差分1件、専用選択、アサーション本文、runner不変、上記8件のSHA-256も独立照合で一致した。`git diff --check` は成功した。

## 現在のmainと組み合わせた限定マージ確認（2026-10-03）

main `088c16c9cfb4c1fff0feb96ba566530a9014dbe6` と今回の21ファイルの変更を、Git共有状態を持たない `/tmp/fc21-merge-recheck-main-OwiFTb` に組み合わせた。作業HEAD `c6a8bb26d18e0034f62e6a523fdda562ff6f7876` からmainへの変更と今回の変更に、同じファイルへの変更の重なりはなかった。製品srcの変更は今回の差分に含まれない。

合成コピーで `node tests/run.js --scope structure` を実行し、8ファイル、223 tests / 223 pass / 0 fail / 0 skip、completed=true、exit 0を確認した。生ログ `/tmp/fc21-merge-recheck-structure.log` のSHA-256は `41c195d1d3f687174203b94012d9085697658ddf8eb8c5b583c9650cae3810f4`。以前の194件と重なるため合算しない。

同じコピーで `node tests/run.js --list --json` を読み、現在のmainを含む通常選択499ファイルに未導入Result契約の新旧pathが含まれないことを確認した。この499件は選択数であり、全件実行の結果ではない。選択ログ `/tmp/fc21-merge-recheck-default.json` のSHA-256は `ae67ed43923e708c5a832223821da4e6419548a40645646977103517f92c5775`。前節の497→496は作業worktreeでのResult分離の測定であり、このmain合成コピーの件数とは区別する。

確認終了時もmainの参照は同じで、`git diff --check` は成功した。今回のfc21テスト基盤変更について、確認した範囲でマージを止める問題はないと判断する。フルテスト、commit、実際のmergeは行っていない。変更はまだ未コミットである。docsはstaleのためソースを正として確認し、docs buildは実行していない。
