# Flow Artifact migration（ボード 2bfc）

作業ブランチは `codex/2bfc`、開始 commit は `main` の
`63896e778d11fba9b94cdb07a6479e589663e78a`。その後、ユーザーの指示で最新 main の
`84ae3c0571b616d6922f2a6e39599535c9bd8950`、続いて
`8df7f754224c8ac8c94489985a36eb19bf1a35ff`、さらに
`874b47dfe187a85e0524bd9a52be334343329519`、
`3e8427ff20868b3ffb04de6433db42dabe397294`、最後に
`173b85d295eb849f5540409a0dcea827b471bef5` を取り込んだ。作業場所は
`.sennel/worktree/2bfc`。実装・検証中は作業ブランチへのコミット、merge、push、公開、
ボード更新を行わず、独立した検証用 Git fixture のみにテスト用 snapshot commit を作った。
その後のユーザー指示により、今回の差分のコミットとmainへのマージ、確認後の作業
worktree・ディレクトリ・ブランチ削除を行う。pushとボード更新は指示されていない。

## 利用経路

通常 Flow が `FLOW_MIGRATION_REQUIRED` を返したら、その応答の
`dryRunCommand` を実行し、確認後に対応する `applyCommand` を実行する。

```sh
sennel migrate specs --to 2 --spec <specId> --dry-run
sennel migrate specs --to 2 --spec <specId>
```

revision 2 は旧 Artifact layout を移行する。Flow Version `001`、state の
`schemaRevision`、Review document の `version` とは別の番号である。
後続の既存 migration が必要なら、応答の `migrations` 順に、同じ `--spec`
で preview と apply を行う。適用済み revision と残工程の inspection は
CLI 出力の `appliedMigrationRevision` / `remaining` で区別する。
`remaining.canonicalChanged: false` は残工程の読取り判定に関する値である。
revision 2 の完了だけを、現行 runtime で継続可能とは扱わない。

`specs` は既存 container の `mainRoot` と設定済み `flow.specDir` を使う。
worktree から実行しても通常 Flow と同じ canonical Spec を移行し、worktree
内のコピーを変更しない。`layout` は従来の実行 root を使う。

`--spec` を省略した全件 migration は維持する。不正・不存在の selector は
全件へ切り替えず拒否する。中断後は同じ対象限定コマンドを再実行して復旧する。
通常 command は migration を自動実行せず、未対応形式の
`FLOW_FORMAT_UNSUPPORTED` と証明不能・改変された authority の整合性エラーを
区別する。

## 共通契約と変更箇所

- `MigrationSpecSelection` が literal identity、discovery、journal identity と
  recovery の対象限定を所有する。既存 revision 3/4 も同じ selector を使う。
- migration 専用の `LegacyFlowActivityDocument` / `LegacyFlowActivityLedger` が
  当時の必須項目を検証し、当時存在しなかった空の payload だけを投影する。
  Attempt、成功結果、receipt、権限を補作しない。
- `LegacyCanonicalVersionPreflight` が元 bytes、catalog 全体と各 descriptor の
  hash/size、path、provenance を検証する。state/journal の証明は既存の
  revision 3 検証と `CurrentFlowStateStore.validateActivities` を再利用する。
- `MigrationFlowAuthorityPreflight` が既存 identity・registry・binding reader と
  worktree resolver を再利用し、対象の authority と identity 衝突を確認する。
  他 Spec は identity 参照だけを読む。無関係な成果物・journal の全件検証はしない。
  永続 state の `version` と物理 Version directory を区別する。
  collision の共通判断は、全件 migration では該当する全 blocker を報告し、
  個別の authority 検証では最初の blocker で拒否する。従来の collision code を保持する。
  対象の registry と identity が片側だけ残る場合、または両方が現行 `001` を
  指すのにその Version が欠ける場合は拒否する。未登録の正当な履歴だけの root は
  引き続き許容する。
  `FlowTargetIdentity.assertState` に実際の Spec root を渡す既存 API の拡張を加え、
  claim 内の path を actual path として再利用しない。設定済み root と claim の
  root が異なる場合も、既存の location/revision 比較で拒否する。
  read-only static API は確定済みの `mainRoot` を受け取り、通常 owner の各読取りで
  Git による root 解決を繰り返さない。worktree の解決は既存 constructor と
  CLI container の境界に残す。
  runner の事前検査では repository authority と全 identity 参照を一度だけ読み、
  `MigrationFlowIdentityIndex` の索引と Spec 別 grouping を使う。各索引は先頭・次・
  別 Spec の代表だけで self / Spec 除外を判定し、重複群の全組合せを展開しない。
  active entry の不変な投影も一度だけ作成し、検査結果間で共有する。
  これは事前検査専用の読取り結果で、公開権限ではない。native canonical revision
  transaction の公開直前・recovery、および runtime 診断の
  `assertMigrationFlowAuthority` は毎回最新の入力を読む。source hash の再検証と
  公開後の strict reload も維持する。全 writer を覆わない repository lock を
  新規に必須化せず、全件 apply 全体の線形化は主張しない。
- `CanonicalRevisionRootTransaction` が全 Version を stage し、適切な段階の
  厳格検証が成功してから root を切り替える。recovery も同じ対象・所有権・
  hash・厳格検証を使う。完了済み Step を巻き戻し・再実行しない。
- `inspectFlowMigrationRequirements` が形式判定を所有する。runtime の厳格読取り
  失敗をこの共通 preflight で診断し、dispatcher と target resolver は構造化された
  案内を保持する。runtime に旧形式の読取り fallback を追加しない。
  state の欠落と、正常な optional projection の `null` を区別する。後者に
  移行診断を適用せず、正常な Prepare adoption の途中の authority を誤拒否しない。
  Flow のない Spec の snapshot は従来どおり `null`、旧 Flow のある root は
  移行案内または未対応形式の拒否になる。
- migration の container/Logger は既存 `FlowAttributionPolicy("none")` を使う。
  runtime package bootstrap と worktree 再実行を通しても ambient Flow を読まない。
  単独 query 入口の既存 bootstrap 不備は今回の修正対象に含めない。

## 入力 fixture と検証の境界

`tests/fixtures/legacy-activity-v1/` は、Git commit
`374aecf787ca813e56d93a4bd7e23575b59b5c61` の変更していない旧 writer が
出力した immutable fixture であり、生成手順、注入した Definition、SHA-256 を
記録している。現行 serializer で形を旧式へ書き換えたものではない。
互換な Definition を旧 writer の公開 injection API に渡している。
古い既定 Definition 全般を移行できるという証拠ではない。

この native source では実際の Branch Attempt と完了を保持し、明示的な
revision 2 → 3 の後に新しい manager で読み戻し、Definition が選ぶ
`prepare-spec` の正規の次 Attempt、再読込み、Spec Review 入力の利用を確認する。
既存 review 変換シナリオでは、保存された移行済み Review を新しい manager の
Spec Gate consumer が digest・finding・disposition と共に読み取る。
current Spec の生成から registered downstream 利用までは、工程専用の
`spec-artifact-scenario.test.js` で確認する。dormant historical import の worker
実行を許可して成功経路に見せることはしない。

既存の synthetic legacy fixture helper は descriptor の追加・更新後に catalog
全体の hash を更新していなかったため、当時の writer と同じ並び順・hash 計算へ
訂正した。正常な変換や provenance 拒否の期待値は維持している。元 writer の
fixture と、catalog 全体の改変を拒否する独立ケースでもこの契約を確認する。

2bfc が導入した診断の回帰では、現行 Store の整合性エラーを包み直すことで
既存の Error 型と command 所有の拒否経路が変わっていた。strict read の元の
cause を保ち、共通 CLI context 境界だけで同じ migration assessment を表示へ使う。
既存 target recovery の分類と identity は維持する。改ざん拒否の既存テストの
期待値を変更して対処しない。

pre-Version root を `null` として無視していた既存テストは、受入条件14の
`FLOW_FORMAT_UNSUPPORTED` 拒否へ更新する。元ファイルの bytes が変わらない
assertion は保持する。通常 runtime に旧形式の silent fallback を復活させない。

旧形式の無変更検証には、共通 assertion module の
`StoredFlowPersistenceSnapshot` と既存 `OfflineMigrationDirectorySnapshot` を
使う。現行 validator に旧形式を通さず、registry・identity・binding・journal
を含む元 bytes と物理 authority を確認する。現行形式になった後は既存の
`CanonicalPersistenceSnapshot` を使う。

## 受入条件と証拠

| 条件 | 結果 | 主な確認経路 |
| --- | --- | --- |
| 1: 対象限定 preview と無変更 | 対象検証済み | historical Activity source scenario、実 CLI selector scenario、物理 snapshot |
| 2: 正しい native V1 の移行と残工程 | 対象検証済み | native source の明示的 2 → 3、worktree 実 CLI の main canonical 移行と `remaining` |
| 3: run/lifecycle/完了/frontier/権限保持 | 対象検証済み | 元 Branch の全 serialized state と fresh manager、Definition の次 Action、registry/identity snapshot |
| 4: 当時の Activity shape | 対象検証済み | 旧 writer fixture の元 hash と実 Attempt、required-at-source 欠損の拒否 |
| 5: 通常 runtime は厳格 | 対象検証済み | revision 2 後の旧 schema を直接 Store が拒否、必要な後続 migration 後の strict load |
| 6: 完了を巻き戻さない | 対象検証済み | 完了 Branch の一致、active/parked の証明不能 Review を既存無変更拒否シナリオで確認 |
| 7: identity/path/hash/provenance の不整合拒否 | 対象検証済み | migration authority scenario、source corruption table、既存 path/ownership 拒否 |
| 8: discovery～recovery～3/4 の対象限定 | 対象検証済み | configured-root 実 CLI、無関係な malformed Spec/journal、3つの root swap interruption |
| 9: 全件/config/root/revision/help 維持 | 対象検証済み | 既存 migration suite、parser/help unit、rev4 実 CLI、layout 既存シナリオ |
| 10: 原子性と復旧 | 対象検証済み | journal-written/source-backed-up/stage-placed の fault injection、既存 foreign-owner 拒否 |
| 11: fresh strict read と consumer | 対象検証済み | native next Attempt の保存・再読込み、移行済み Spec Gate Review consumer、Spec 工程シナリオ |
| 12: 通常 read/mutation の移行案内 | 対象検証済み | indexed `next-action`/artifact/auto、実 CLI artifact、worktree guided chain |
| 13: bootstrap/worktree/ambient 分離 | 対象検証済み | 実 worktree CLI の Logger record が migration 時 null attribution、authority/copy 無変更 |
| 14: 未対応と整合性エラーの区別 | 対象検証済み | pre-Version と unknown schema、改変 Activity の通常 command 拒否 |
| 15: 手動変更データの拒否 | 対象検証済み | hash を更新していない Activity の手動 modernization fixture、無変更拒否 |
| 16: 回帰と工程と全体テスト | 未達・最終全件は途中停止 | 下記検証結果。skip は成功件数へ含めない |

主な検証入口は次のとおり。個別実行には `node tests/run.js --file <path>` を使う。

- `tests/integration/specs-migration.test.js`: native source、改変拒否、原子性・復旧、fresh consumer。
- `tests/integration/migrate-selector-cli.test.js`: 設定 root、literal selector、worktree、実 CLI と attribution。
- `tests/integration/migrate-flow-authority.test.js`: registry・identity・binding・実 root の一致と無変更拒否。
- `tests/integration/flow-migration-guidance.test.js`: 通常 command の移行案内、未対応形式と整合性エラー。
- `tests/integration/flow-cli/spec-artifact-scenario.test.js`: Spec の正規生成、保存・再読込みと後続利用。


## 検証結果と今回のスコープ

今回の修正対象は2bfcの受入条件と、2bfcが導入した回帰だけである。
独立した既存不具合、テストの一般的な producer 移行、単独 query の独自 bootstrap 修正は
差分から外した。後から main が提供した bootstrap は保持している。
期待値緩和・skip追加・timeout延長は行っていない。

取り込んだ main は順に `84ae3c0571b616d6922f2a6e39599535c9bd8950`、
`8df7f754224c8ac8c94489985a36eb19bf1a35ff`、
`874b47dfe187a85e0524bd9a52be334343329519`、
`3e8427ff20868b3ffb04de6433db42dabe397294`、
`173b85d295eb849f5540409a0dcea827b471bef5`。
874 の統合では953ファイルの main 変更と62ファイルの当時の差分を比較し、
7重複・4競合を解消した。forest/changelog/A06 は main の修正へ統一済み。
main の未コミット50パスを取り込まず、前後の status 一致を確認した。
3e84 の統合は main の95パス（rename 元を含む）と今回の40パスを比較し、
5重複・3競合を整理した。元 checkout は読み取りだけを行い、未コミット変更を
取り込んでいない。他作業によって元 checkout の status は変化したため、
この統合前後の status 一致は主張しない。
173b の追加コミットは `specs/` の履歴・成果物67ファイルだけで、2bfcの差分との
重複はない。コミット済み bytes の一致を確認して取り込み、元 checkout の未コミット変更は
除外した。ソース・テスト・スクリプト・package の変更はないため、3e84での51件の
成功結果を再利用した。下記の全件実行は173bの最終入力で行った。
元 checkout の変更、reset・clean・stash、作業 commit、merge commit、push、
ボード更新は行っていない。

### 残した差分と分離した変更

| 分類 | 対象・扱い |
| --- | --- |
| 2bfc 本体 | literal selector、全 migration revision の対象限定、旧 Activity の真正な読み取り、authority 検証、原子性・復旧、strict runtime の移行案内 |
| 2bfc の回帰修正 | 現行 integrity error の元 cause を保持し、共通 CLI hook だけで既存 assessment を表示に利用。既存の拒否経路・Error 期待値は変更しない |
| 新しい main との接続 | 共通 dispatcher の例外処理・停止案内を再利用し、独自 catch を除去。Artifact 移行案内を main の新しい `flow-main.js` へ移す。移行エラーの所有者が既存 `SingleUserActionDirective` で具体的 preview を選び、表示と一致させる。CLI 実行・binding・自動継続の権限は与えない |
| 直接のテスト・fixture | migration 既存 suite、selector/authority/guidance、旧 writer fixture、物理 snapshot。pre-Version 拒否は条件14の意図的な変更 |
| main の変更 | 取り込んだコミットを保持。独自修正の除外時は main874 へファイル単位で戻し、その後の main3e84 の変更も保持。単独 Flow bootstrap は現在 main と完全一致 |
| 今回から除外 | 独立したテスト・support 19ファイルを main874 へ復元。独自 producer/metrics unit/参照 Spec fixture の4ファイルを退避。単独 query bootstrap の独自修正も除外。Draft provider/recovery の候補は未適用 |

分類と元 bytes は `.tmp/2bfc/scope-narrowing/manifest.json`、
`scope-narrowing/before/`、`excluded-tracked.patch` に保存した。
範囲外の再現条件・commit・ケース・log・2bfcとの関係は
`.tmp/2bfc/out-of-scope-handoff.md` に記録した。範囲外の調査・修正・追加検証は停止している。

### 検証の区別

| 対象 | 結果・証拠 |
| --- | --- |
| main3e84 接続後の対象6ファイル | **48成功・失敗/skipなし、exit0**。unit30、integration18、concurrency1。migration CLI/help/selector/worktree bootstrap、通常 Flow の移行・unsupported・integrity 拒否、target binding、共通停止案内。`scoped-main3e84-cli-final.log` と `scoped-main3e84-cli-final-results.json` |
| main3e84 接続後の今回の回帰3ケース | **3成功・失敗/skipなし、exit0**。変更していない既存の saved refine contract / raw journal prefix / typed Activity prefix の拒否。`scoped-main3e84-own-regressions-results.json`。独立した失敗2件は再実行していない |
| main874 時点の直接7ファイル（再利用） | **101成功・失敗/skipなし、exit0**。unit8、integration93、concurrency1。`.tmp/2bfc/scope-2bfc-direct-final.log` と `scope-2bfc-direct-final-results.json`。migration engine/authority のコードは3e84でも同一。高コストの移行全マトリクスは再実行せず、影響した CLI 接続は上行で再確認。現在の全件成功とは扱わない |
| main874 時点の integrity 影響確認5ケース | **3成功・2失敗・skipなし、exit1**。元の同じ期待値で検出した Error 包み直し3件は解消。残る2件は下行の既存問題。`post-main-874b-targeted.log`、`scope-2bfc-integrity-regression-results.json` |
| 残る2件の最小比較 | 2bfc を含まない clean な main874 detached worktree でも **0成功・2失敗、exit1**。同じ test SHA・ケース名・TypeError を確認。`scope-regression-attribution.json`、`scope-main874-attribution-01.log`。原因の追加調査・修正は停止 |
| 統合済み874の工程確認 | 中断前に Draft の専用工程・後続利用は成功。Spec は9件中7件まで成功し、保存・再読込・Approval/Test/Acceptance利用、正規 recovery、Draft 再生成後の Gate を確認。全9件成功とは扱わない |
| 以前の有効な直接確認 | 84ae 統合後の9ファイル123成功・失敗/skipなし。現在から除外した既存 fixture の修正後成功を、最終差分の成功へ合算しない |
| 最終入力の全件テスト | **未達・途中停止、exit143**。`npm test -- --jobs 1`。unitは1,465件中1,463成功・2失敗・skipなし、unit processはexit1。統合は途中であり最終件数不明。e2e/acceptance/structureは未実行。2bfcの直接検証と既知回帰確認後、scope限定指示に従い残る長時間の全件実行を停止した。`npm-test-main173b-final-scope.log`、`full-main173b-final-results.json` |
| 同じ最終全件実行での成功 | Task231の実CLI全工程、changelog CLIの4ケース、Acceptanceのtokenless Await、guarded Spec correctionのA03成功を保存。A03は約17分半で成功し、旧question/risk decision/report identity拒否とRequirement再公開を確認。高コストの成功済みケースは再実行しない |
| 過去の全件実行 | 8df7入力c5はunit1,399成功、統合で失敗を収集後にmain統合のためexit143。874の14ファイル確認もscope限定指示でexit143。現在の全件成功には合算しない |
| 実 agent | c5実行は11成功・2失敗・既存 MODE skip1、exit1。同じ失敗2件の再確認は2成功。全 agent 成功へ読み替えず、未確定原因の追加調査は範囲外へ分離 |

停止は起動 identity・cwd を照合した今回所有の各6プロセスだけに行い、
exit143・残存0・専用一時領域削除を確認した。他タスクのプロセスは停止していない。
証拠は `stopped-c5b787f6-processes.json` と
`stopped-post-main-874b-targeted-processes.json`。停止前後の log を保持した。

最終173bの実行も、起動時のPID・start time・process groupとcwdを照合した所有6プロセスだけを
停止した。exit143・残存0・専用一時領域削除を確認し、停止前logも保存した。
`stopped-main173b-final-scope-processes.json` に記録している。
保存できた失敗明細はunitのResult registry閉集合2件、skill配置3件、Acceptanceの
`scenario` 初期化前参照2件の計7件である。これらのtest bytesはmain173bと同じだが、
2bfcとの因果関係は確定していない。既存障害と断定せず、追加の原因調査・修正はしていない。
Acceptance工程suiteの集計は2件失敗を示す一方、対応するleafの明細は1件しか保存出力に
見えていない。統合の最終集計もないため、明細7件を全失敗数と報告しない。
再現入力・確認commit・ケース名・logとこの制限は範囲外引継ぎに残した。

874 時点の source/tests/scripts/package 1,872ファイルは当時の検証前後で一致した。
3e84 の最終入力は1,894ファイルで、対象検証後も byte 一致する。
main の rename 元が残った18ファイルは、旧 main と同一で独自変更がないことを確認して
保存後に個別除去した。実行した test、product、fixture、package の bytes は変更していない。
証拠は `main3e84-rename-source-cleanup.json`。main が移動した現行参照ファイルは保持した。
残る差分40ファイル（src21、tests/fixture16、docs3）の分類、mainへ戻した19ファイルの
byte一致、独自4ファイルの不在、`git diff --check` 成功を確認した。
最終の証拠は `.tmp/2bfc/scoped-main173b-audit.json` と `scoped-main173b-remaining-diff.json`。
3e84の検証入力・audit・logも保持し、173bで同じ1,894入力が一致することを確認した。
173bの全件実行前後では、ソース・テスト・必要な参照ファイルを含む19,538入力と
Git index、HEAD、branchが一致した。証拠は `full-main173b-final-input-verification.json`。
その確認後に変更したのは、このREADMEの検証結果・引継ぎ記述だけである。
プロダクト・テスト・fixture・参照入力は変更せず、文書更新のために全件を再開始しない。
main874 時点の audit / 入力 / 分類は `historical-main874/` に保存した。
比較用 detached worktree は clean を確認して削除し、2bfc の worktree は残す。

旧 writer fixture、同じ期待値による修正前後の比較、authority/collision の比較は
`.tmp/2bfc/*comparison.json` と対応 log に保存している。
既知障害の検出は未知障害の網羅とは区別し、不要な長時間比較は繰り返さない。

旧writerが保存したActivityを互換Definitionの条件下で移行し、strict reloadと実CLIの
後続処理まで確認した。任意の歴史的Definitionや実ユーザーデータ全般の検証とは扱わない。
このDefinitionの限定だけを理由に、受入条件へ新しい普遍的要件を追加しない。
docs freshness は当初 stale であり build を提案済み、生成全体が最新とは扱わない。
受入条件1〜15の対象確認と、条件16の全件未達・未完走を分ける。
従来の全件成功という完了条件は満たしておらず、総合判定は未完了である。
レビューと引継ぎのため worktree と証拠を残す。

### 後続の性能設計レビューと限定検証

ユーザーの追加指示により2名が設計と実装をレビューした。全 run に古い snapshot を
持ち越す案は取り下げ、再利用範囲を事前検査へ限定した。実装レビューで見つかった
active registry 全件の繰り返しコピーも、一度の不変化と共有へ修正した。
変更は上記 authority / identity 検査と runner の処理量に限定し、独立した既存障害の
修正や全件テスト再実行は行っていない。過去の入力一致記録はこの追加修正前の証拠である。

登録済み active Flow を正規の Store / registry / target authority で生成し、
8・16・32件の同じ検証を修正前の隔離コピーと修正後に実行した。revision 2 の
`flow.json` 読取り回数は修正前 **80 / 288 / 1,088**、修正後 **32 / 64 / 128**。
registry entry の参照回数は **100 / 392 / 1,552 → 8 / 16 / 32**。
revision 3 と4も修正後の読取りが件数に比例することを確認し、各 dry-run 前後の
永続入力の一致を検証した。時間値は同一環境の参考計測であり、速度の一律保証には使わない。

限定した37ケースが成功した（unit4、integration33、新規skipなし）。衝突各種、
同一Flowの多数Version、全件重複、実worktreeの対象限定移行、通常runtimeの拒否、
native旧writer移行、公開中断後の復旧、公開直前に発生した衝突の拒否を確認した。
最後の追加ケースは初回、復旧APIの例外を戻り値と扱ったテスト側の誤りで失敗した。
実際の `RUN_ID_COLLISION` 例外とsource無変更をassertするよう訂正し、その1件だけ
再実行して成功した。他の成功済みケースは再実行していない。

証拠は `.tmp/2bfc/performance-review/` の `report.json`、`followup-only.patch`、
`final-inputs/manifest.json` と各 log に保存した。全件成功という条件16は引き続き未達である。

### mainへの統合と作業領域の整理

ユーザーの明示指示で差分をコミットし、進んだmainの実行履歴・来歴管理と統合する。
確認対象のmainは `cfa6dc31b465f2c8240659476d7e8dc5d779d196`。mainの未コミット
AGENTSとprocess-management prototypeは今回のコミットへ含めず保持する。
統合後の対象検証、mainの到達commit、作業commitの祖先確認、削除結果は
`.tmp/2bfc-finalization-20261016/finalization.json` に保存する。
従来の `.tmp/2bfc/` のログ・比較パッチ・入力manifestは同じ保存先の
`evidence.tar.gz` に退避し、保全確認後に元の作業領域を削除する。全件テストの
成功条件が未達という報告は維持し、マージを全件成功の証拠として扱わない。
