<!-- {{data("base.docs.langSwitcher", {labels: "relative"})}} -->
**日本語** | [English](../cli_commands.md)
<!-- {{/data}} -->

# CLI コマンドリファレンス

## 説明

<!-- {{text({prompt: "この章の概要を1〜2文で記述してください。コマンド総数・サブコマンド体系を踏まえること。"})}} -->

`sennel` は `docs`・`flow` の 2 つの名前空間ディスパッチャーと `setup`・`upgrade`・`presets`・`help` の独立コマンドを合わせた 40 以上のサブコマンドを提供します。コマンド体系は `sennel <group> <subcommand> [options]` の最大 3 階層構造で構成されており、ドキュメント自動生成パイプラインと Spec-Driven Development フローを統合的に操作できます。
<!-- {{/text}} -->

## 内容

### コマンド一覧

<!-- {{text({prompt: "全コマンドの一覧を表形式で記述してください。コマンド名・説明・主なオプションを含めること。ソースコードのコマンド定義・ルーティングから網羅的に抽出すること。", mode: "deep"})}} -->

| コマンド | 説明 | 主なオプション |
| --- | --- | --- |
| `sennel help` | 利用可能なコマンド一覧を表示 | なし |
| `sennel setup` | プロジェクト初期設定ウィザードを対話形式で実行 | `--name`, `--type`, `--lang`, `--agent`, `--dry-run` |
| `sennel upgrade` | スキルファイルと設定を最新版に更新 | `--dry-run` |
| `sennel presets list` | 利用可能なプリセット一覧をツリー形式で表示 | なし |
| `sennel docs build` | scan → enrich → init → data → text → readme → agents → translate の全パイプラインを実行 | `--force`, `--dry-run`, `--verbose`, `--regenerate` |
| `sennel docs scan` | ソースコードを解析して `.sennel/output/analysis.json` を生成 | なし |
| `sennel docs enrich` | AI を用いて解析結果に役割・概要・章分類を付与 | なし |
| `sennel docs init` | プリセットテンプレートから `docs/` 配下の章ファイルを生成 | `--force`, `--dry-run`, `--type` |
| `sennel docs data` | `{{data}}` ディレクティブを解析データで展開 | `--dry-run` |
| `sennel docs text` | `{{text}}` ディレクティブを AI で埋めてドキュメントを生成 | `--dry-run`, `--force` |
| `sennel docs readme` | プリセットテンプレートから README.md を生成・更新 | `--dry-run`, `--output`, `--lang` |
| `sennel docs forge` | AI 駆動の多ラウンドドキュメント生成ループを実行 | `--prompt`, `--spec`, `--max-runs`, `--mode`, `--dry-run` |
| `sennel docs review` | ドキュメントの整合性・品質・未埋めディレクティブを検証 | なし |
| `sennel docs changelog` | `specs/` ディレクトリから Markdown 変更履歴を生成 | `--dry-run` |
| `sennel docs agents` | AGENTS.md を生成・更新 | `--dry-run` |
| `sennel docs translate` | ドキュメント章ファイルと README を対象言語に AI 翻訳 | `--lang`, `--force`, `--dry-run` |
| `sennel flow prepare` | スペックディレクトリ・ブランチ・worktree を初期化 | `--title`, `--base`, `--worktree`, `--no-branch`, `--issue`, `--request`, `--dry-run` |
| `sennel flow get check` | 指定ターゲットの事前条件を検証 | ターゲット: `impl`, `finalize`, `dirty`, `gh` |
| `sennel flow get context` | ファイル読み込み・解析検索・キーワード収集によるコンテキスト取得 | `--search <query>`, `--raw` |
| `sennel flow get guardrail` | フェーズ別ガードレールルールを取得 | フェーズ: `draft`, `spec`, `impl`, `lint` |
| `sennel flow get issue` | 指定した GitHub Issue の内容を取得 | Issue 番号 |
| `sennel flow get prompt` | フロー用プロンプトテキストを言語・種別で取得 | 言語コード・プロンプト種別 |
| `sennel flow get qa-count` | 現在のフロー状態から QA 件数を取得 | なし |
| `sennel flow get resolve-context` | worktree・ブランチ・スペック・フロー状態を含むコンテキストスナップショットを取得 | なし |
| `sennel flow get status` | 現在のフェーズ・ステップ状態・要件進捗を取得 | なし |
| `sennel flow set auto` | autoApprove フラグを有効化・無効化 | `on` または `off` |
| `sennel flow set issue` | GitHub Issue 番号をフロー状態に記録 | Issue 番号（正の整数） |
| `sennel flow set metric` | フェーズ別カウンター（question, redo, docsRead, srcRead）をインクリメント | フェーズ名・カウンター名 |
| `sennel flow set note` | メモをフロー状態の notes 配列に追記 | テキスト |
| `sennel flow set redo` | redo ログにエントリを追加 | `--step`, `--reason`, `--resolution`, `--trigger` |
| `sennel flow set req` | インデックス指定で要件のステータスを更新 | インデックス・ステータス |
| `sennel flow set request` | ユーザーリクエストテキストをフロー状態に保存 | テキスト |
| `sennel flow set step` | 指定ステップのステータスを更新 | ステップ ID・ステータス |
| `sennel flow set summary` | 要件配列（JSON）をフロー状態に保存 | JSON 配列文字列 |
| `sennel flow run finalize` | コミット・マージ/PR 作成・ドキュメント同期・後片付けを実行 | `--mode`, `--steps`, `--merge-strategy`, `--message`, `--dry-run` |
| `sennel flow run gate` | スペックの構造・ガードレール準拠を検証するゲートチェック | `--spec`, `--phase`, `--skip-guardrail`, `--agent-work-dir`, `--log-file` |
| `sennel flow run impl-confirm` | 要件の完了状況を確認して実装の準備状態を評価 | `--mode` |
| `sennel flow run lint` | ガードレールルールに基づき変更ファイルの lint チェックを実行 | `--base` |
| `sennel flow run report` | フロー実行レポート（report.json）を生成 | `--dry-run` |
| `sennel flow run retro` | AI によるスペック精度の振り返り（retro.json）を実行 | `--force`, `--dry-run` |
| `sennel flow run review` | コードレビューワークフローを実行し改善提案を生成・適用 | `--phase`, `--dry-run`, `--skip-confirm`, `--agent-work-dir`, `--log-file` |
| `sennel flow run test-execute` | spec-local テストと必要な project regression を実行し、version `"2"` の `test-execute-result.json` と raw output を保存 | `.sennel/config.json` の `test.command`, `test.projectPaths`, `test.timeout` |
| `sennel flow run test-result-review` | `test-execute-result.json` v2、raw output、project regression evidence を機械的に検証し `test-result-review.json` を保存 | なし |
| `sennel flow run sync` | ドキュメントのビルド・レビュー・コミットまでを一括実行 | `--dry-run` |
<!-- {{/text}} -->

### グローバルオプション

<!-- {{text({prompt: "全コマンドに共通するグローバルオプションを表形式で記述してください。ソースコードの引数パース処理から抽出すること。", mode: "deep"})}} -->

| オプション | 説明 | 適用範囲 |
| --- | --- | --- |
| `-h`, `--help` | コマンドのヘルプメッセージを表示して終了（終了コード 0） | 全コマンド |
| `-v`, `-V`, `--version` | sennel のバージョン番号を表示して終了 | トップレベルのみ |
| `--dry-run` | 実際のファイル書き込みや副作用を行わずに動作を確認 | docs・flow の多くのコマンド |
| `--verbose` | 詳細な進捗ログを出力（`docs forge` では `-v` エイリアスも有効） | `docs build`, `docs forge` |
| `--lang <lang>` | 出力言語コードを指定（デフォルトは config.json の設定値） | docs 系の一部コマンド |
<!-- {{/text}} -->

### 各コマンドの詳細

<!-- {{text({prompt: "各コマンドの使用方法・オプション・実行例を詳しく記述してください。コマンドごとに #### サブセクションを立てること。ソースコードの引数定義・ヘルプメッセージから情報を抽出すること。", mode: "deep"})}} -->

#### `sennel help`

利用可能なコマンド一覧とバージョン情報を表示します。引数なしで `sennel` を実行した場合も同様に表示されます。

```
sennel help
sennel --help
```

#### `sennel setup`

対話形式でプロジェクトの初期設定を行います。プロジェクト名・言語・プリセット種別・ドキュメントの目的とトーン・エージェント設定を収集し、`.sennel/config.json` の生成・スキルファイルの配置・`AGENTS.md` へのディレクティブ追記を実行します。

```
sennel setup [options]
```

| オプション | 説明 |
| --- | --- |
| `--name <name>` | プロジェクト名 |
| `--type <type>` | プリセット種別（例: `node-cli`, `laravel`） |
| `--lang <lang>` | プロジェクト言語コード（例: `ja`, `en`） |
| `--agent <name>` | デフォルトエージェント名 |
| `--purpose <purpose>` | ドキュメント目的（`developer-guide`, `user-guide` 等） |
| `--tone <tone>` | 文体（`polite`, `formal`, `casual`） |
| `--dry-run` | 設定ファイルを書き込まず確認のみ |

#### `sennel upgrade`

スキルファイル（`.claude/skills/`, `.agents/skills/`）をパッケージの最新テンプレートに更新します。変更があったファイルのみ上書きし、`config.json` の非推奨フィールドも自動マイグレーションします。

```
sennel upgrade [--dry-run]
```

#### `sennel presets list`

利用可能なプリセット一覧を `base` を頂点とするツリー形式で表示します。各プリセットのキー・エイリアス・テンプレートディレクトリの有無を確認できます。

```
sennel presets list
```

#### `sennel docs build`

ドキュメント生成パイプライン全体を順番に実行します。標準の実行順序は scan → enrich → init → data → text → readme → agents であり、多言語設定がある場合は最後に translate が追加されます。エージェント未設定の場合は enrich と text をスキップします。

```
sennel docs build [options]
```

| オプション | 説明 |
| --- | --- |
| `--force` | 既存の章ファイルを強制上書き |
| `--regenerate` | init をスキップし既存章ファイルを対象に text を再生成 |
| `--dry-run` | ファイル書き込みを行わず確認のみ |
| `--verbose` | 詳細なステップログを表示 |

#### `sennel docs scan`

ソースコードを解析し `.sennel/output/analysis.json` を生成します。プリセットの scan 定義に従いファイルを分類してキーワードを抽出します。

```
sennel docs scan
```

#### `sennel docs enrich`

AI を使用して `analysis.json` の各エントリに `role`・`summary`・`detail`・`chapter` フィールドを付与します。エージェント設定が必須です。

```
sennel docs enrich
```

#### `sennel docs init`

プリセットのテンプレートチェーンを解決し `docs/` 配下に章ファイルを生成します。既存ファイルとの競合は `--force` がない限りスキップします。エージェントが設定されている場合は AI による章フィルタリングも実行します。

```
sennel docs init [options]
```

| オプション | 説明 |
| --- | --- |
| `--type <type>` | プリセット種別を明示指定 |
| `--force` | 既存ファイルを上書き |
| `--dry-run` | 書き込みを行わず確認のみ |

#### `sennel docs data`

各章ファイルの `{{data(...)}}` ディレクティブをデータソースから解決して展開します。既存の手動記述はディレクティブの外に記述することで保持されます。

```
sennel docs data [--dry-run]
```

#### `sennel docs text`

各章ファイルの空の `{{text(...)}}` ディレクティブを AI で生成したテキストで埋めます。エージェント設定が必須です。`--force` を指定すると既にテキストが存在するディレクティブも再生成します。

```
sennel docs text [--dry-run] [--force]
```

#### `sennel docs readme`

プリセットの README テンプレートから `{{data}}` ディレクティブを展開し、未埋めの `{{text}}` ブロックを AI で補完して `README.md` を生成・更新します。内容に変更がない場合は書き込みをスキップします。

```
sennel docs readme [options]
```

| オプション | 説明 |
| --- | --- |
| `--output <path>` | 出力先パスを指定（言語別 README に使用） |
| `--lang <lang>` | 出力言語コード |
| `--dry-run` | 生成内容を stdout に出力するのみ |

#### `sennel docs forge`

AI 駆動の多ラウンドドキュメント生成ループを実行します。各ラウンドで対象章ファイルに対して AI を並行呼び出しし、`docs review` でパスするまでループします。`--mode local`（デフォルト）はファイルごとに個別 AI 呼び出し、`--mode assist` は全ファイルを単一プロンプト、`--mode agent` はサブエージェントに委譲します。

```
sennel docs forge --prompt "<指示>" [options]
```

| オプション | 説明 |
| --- | --- |
| `--prompt <text>` | 生成指示テキスト（必須） |
| `--prompt-file <path>` | 指示テキストをファイルから読み込み |
| `--spec <path>` | 関連スペックファイルのパス |
| `--max-runs <n>` | 最大ラウンド数（デフォルト: 3） |
| `--mode <mode>` | 実行モード: `local`, `assist`, `agent` |
| `--review-cmd <cmd>` | レビューコマンド（デフォルト: `sennel docs review`） |
| `--dry-run` | 対象ファイル一覧の表示のみ |

#### `sennel docs review`

`docs/` 配下の章ファイルに対してドキュメント品質を検証します。未埋め `{{text}}`・`{{data}}` ディレクティブ、H1 見出し欠落、行数不足（15 行未満）、HTML コメントの不整合、残留ブロックタグを検出し、問題があれば終了コード 1 で終了します。

```
sennel docs review [<target-dir>]
```

#### `sennel docs changelog`

`specs/` ディレクトリ内のサブディレクトリを走査し、各 `spec.md` のタイトル・ステータス・作成日・サマリーを集約した Markdown 変更履歴を生成します。デフォルト出力先は `docs/change_log.md` です。

```
sennel docs changelog [--dry-run] [<output-path>]
```

#### `sennel docs agents`

プロジェクトのソースコード解析結果に基づき `AGENTS.md` の `{{data("agents.project")}}` セクションを生成・更新します。

```
sennel docs agents [--dry-run]
```

#### `sennel docs translate`

`docs/` 配下の章ファイルと `README.md` を対象言語に AI 翻訳し、`docs/<lang>/` ディレクトリに出力します。ソースファイルより翻訳済みファイルが新しい場合はスキップします（`--force` で強制再翻訳）。

```
sennel docs translate [--lang <lang>] [--force] [--dry-run]
```

#### `sennel flow prepare`

新しい SDD フローを開始するためにスペックディレクトリ・`spec.md`・`qa.md` を作成し、feature ブランチまたは git worktree をセットアップします。`flow.json` も初期化されます。

```
sennel flow prepare --title "<機能名>" [options]
```

| オプション | 説明 |
| --- | --- |
| `--title <name>` | 機能タイトル（必須） |
| `--base <branch>` | ベースブランチ（デフォルト: 現在の HEAD） |
| `--worktree` | git worktree モードで作業環境を分離 |
| `--no-branch` | ブランチを作成せずスペックのみ作成 |
| `--issue <number>` | 関連 GitHub Issue 番号 |
| `--request <text>` | ユーザーリクエストテキスト |
| `--dry-run` | 実行内容を表示するのみ |

#### `sennel flow get check`

指定ターゲットの事前条件を検証します。`impl`・`finalize` はステップ完了状態を、`dirty` は作業ツリーのクリーン状態を、`gh` は GitHub CLI の利用可否を確認します。

```
sennel flow get check <target>
# target: impl | finalize | dirty | gh
```

#### `sennel flow get context`

`analysis.json` からエントリを検索・取得します。引数なしでフィルター済み一覧を返し、ファイルパスを指定するとファイル内容を返します。`--search <query>` では ngram 類似度検索・AI キーワード検索・フォールバック文字列検索の順で処理します。

```
sennel flow get context [path] [--raw] [--search <query>]
```

#### `sennel flow get guardrail`

プリセットチェーンからガードレールルールを読み込み、指定フェーズに絞って返します。`--format json` を指定すると JSON 形式、省略時は Markdown 形式で出力します。

```
sennel flow get guardrail <phase> [--format json]
# phase: draft | spec | impl | lint
```

#### `sennel flow get issue`

GitHub CLI（`gh`）を使用して指定番号の Issue を取得し、タイトル・本文・ラベル・状態を JSON エンベロープで返します。

```
sennel flow get issue <number>
```

#### `sennel flow get prompt`

フロー各フェーズで使用するプロンプトテキストを言語・種別で取得します。選択肢・推奨値を含む構造化データとして返されます。

```
sennel flow get prompt <kind>
# 例: plan.approach, plan.approval, impl.review-mode, finalize.mode
```

#### `sennel flow get qa-count`

現在のフロー状態（`flow.json`）の `metrics.draft.question` を読み取り、QA 件数を返します。

```
sennel flow get qa-count
```

#### `sennel flow get resolve-context`

worktree パス・ブランチ情報・スペックの Goal/Scope・フロー進捗・git 状態（dirty ファイル数、差分コミット数）を含む包括的なコンテキストスナップショットを返します。スキルスクリプトが AI エージェントを呼び出す際の起点として使用されます。

```
sennel flow get resolve-context
```

#### `sennel flow get status`

現在のフェーズ（plan・impl・finalize）とステップの進捗・要件の完了状況を返します。

```
sennel flow get status
```

#### `sennel flow set auto`

フロー状態の `autoApprove` フラグを切り替えます。`on` で自動承認を有効化し、スキルスクリプトがユーザー確認なしに次のステップへ進みます。

```
sennel flow set auto on|off
```

#### `sennel flow set issue`

GitHub Issue 番号をフロー状態（`flow.json`）に記録します。`flow run finalize` 時の PR 本文に `fixes #N` として使用されます。

```
sennel flow set issue <number>
```

#### `sennel flow set metric`

フェーズ別メトリクスカウンターをインクリメントします。有効なフェーズは `draft`・`spec`・`gate`・`test`・`impl`、カウンターは `question`・`redo`・`docsRead`・`srcRead` です。

```
sennel flow set metric <phase> <counter>
```

#### `sennel flow set note`

任意のメモをフロー状態の `notes` 配列に追記します。記録されたメモは `flow get status` や `flow get resolve-context` で参照できます。

```
sennel flow set note "<テキスト>"
```

#### `sennel flow set redo`

作業の手戻り記録をスペックディレクトリ内の `redolog.json` に追記します。`--step` と `--reason` は必須です。

```
sennel flow set redo --step <id> --reason "<理由>" [--resolution "<解決策>"] [--trigger "<トリガー>"]
```

#### `sennel flow set req`

フロー状態の `requirements` 配列の指定インデックスのステータスを更新します。

```
sennel flow set req <index> <status>
# status: pending | in_progress | done
```

#### `sennel flow set request`

フローを起動したユーザーリクエストテキストを `flow.json` に保存します。スキルスクリプトがフロー全体を通じてコンテキストを保持するために使用します。

```
sennel flow set request "<テキスト>"
```

#### `sennel flow set step`

フロー状態内の指定ステップのステータスを更新します。有効なステータスは `pending`・`in_progress`・`done`・`skipped` です。

```
sennel flow set step <id> <status>
```

#### `sennel flow set summary`

要件を JSON 配列形式でフロー状態の `requirements` に一括保存します。各要素は `desc`（説明）と `status` を持つオブジェクトです。

```
sennel flow set summary '[{"desc":"要件1","status":"pending"}]'
```

#### `sennel flow run finalize`

コミット・retro 生成・レポート生成・マージまたは PR 作成・ドキュメント同期・ブランチ削除を順番に実行します。`--mode all` で全ステップを、`--mode select --steps 1,2` で任意のステップを実行します。

```
sennel flow run finalize --mode <all|select> [options]
```

| オプション | 説明 |
| --- | --- |
| `--mode <all または select>` | 実行モード（必須） |
| `--steps <1,2,3,4>` | select モード時の実行ステップ（1=commit, 2=merge, 3=sync, 4=cleanup） |
| `--merge-strategy <strategy>` | `squash` または `pr`（デフォルト: auto） |
| `--message <msg>` | カスタムコミットメッセージ |
| `--dry-run` | 実行内容を表示するのみ |

#### `sennel flow run gate`

スペックファイルの構造チェック（未解決トークン・必須セクション・ユーザー確認状態）と AI によるガードレール準拠チェックを実行します。`--phase post` を指定すると `## User Confirmation` のチェック状態も検証します。

```
sennel flow run gate [--spec <path>] [--phase <pre|post>] [--skip-guardrail] [--agent-work-dir <path>] [--log-file <path>]
```

#### `sennel flow run impl-confirm`

フロー状態の要件配列を参照し、実装の完了状況（done・in_progress・pending 件数）を評価して次のアクション（`review` または `fix`）を提案します。`--mode detail` を指定するとベースブランチからの変更ファイル一覧も取得します。

```
sennel flow run impl-confirm [--mode <overview|detail>]
```

#### `sennel flow run lint`

ガードレールの lint パターンに基づき、ベースブランチからの差分ファイルを検査します。違反があれば `fail` エンベロープを返し終了コード 1 で終了します。

```
sennel flow run lint [--base <branch>]
```

#### `sennel flow run report`

ベースブランチとの git diff 統計・コミット一覧・redo ログ・フェーズメトリクスを集約した `report.json` をスペックディレクトリに保存します。

```
sennel flow run report [--dry-run]
```

#### `sennel flow run retro`

実装差分とスペック要件を AI に比較させ、各要件の達成状況（done/partial/not_done）と未計画変更を `retro.json` に保存します。エージェント設定が必須です。

```
sennel flow run retro [--force] [--dry-run]
```

#### `sennel flow run review`

実装差分に対してコードレビューを実行し、改善提案の生成・評価・適用を行います。`--phase test` を指定するとテストカバレッジのギャップ分析（最大 3 ラウンド）を実行します。

```
sennel flow run review [--phase <test>] [--dry-run] [--skip-confirm] [--agent-work-dir <path>] [--log-file <path>]
```

#### `sennel flow run test-execute`

impl フェーズのテスト実行を集約します。spec-local テスト結果は `summary[]` に、project-level regression は version `"2"` の `test-execute-result.json` の `regression` に保存します。root regression command は top-level `test.command`、`package.json`、`composer.json`、`Makefile` の順に解決し、`test.projectPaths` と `test.timeout` を使用します。`commands.test` は task prompt 用の別設定です。

#### `sennel flow run test-result-review`

`test-execute-result.json` v2、`tests/.raw/test-execution.log`、`test-result-review.json` の整合性を機械的に検証します。flow-level `gate-impl`、report、finalize はこの v2 artifact を読み、旧来の flow-state test summary は正としません。

#### `sennel flow run sync`

`sennel docs build` を実行してドキュメントを最新化し、`docs review` で品質を確認した後、変更があれば `git add` して `docs: sync documentation` コミットを作成します。

```
sennel flow run sync [--dry-run]
```
<!-- {{/text}} -->

### 終了コードと出力

<!-- {{text({prompt: "終了コードの定義と stdout/stderr の使い分けルールを表形式で記述してください。ソースコードの process.exit() 呼び出しや出力パターンから抽出すること。", mode: "deep"})}} -->

| 終了コード | 定数 | 意味 |
| --- | --- | --- |
| `0` | — | 正常終了 |
| `1` | `EXIT_ERROR` | エラー終了（不正なオプション・ファイル未発見・コマンド失敗・設定不正など） |

stdout と stderr の使い分けルールは以下の通りです。

| 出力先 | 用途 | 主な対象コマンド |
| --- | --- | --- |
| `stdout` | `flow` コマンドの JSON エンベロープ（`ok` / `fail` 形式） | `flow get *`, `flow set *`, `flow run *` |
| `stdout` | `--dry-run` 時のファイル内容プレビュー | `docs *` および `flow *` の `--dry-run` |
| `stdout` | ヘルプメッセージ | 全コマンドの `-h` / `--help` |
| `stdout` | バージョン文字列 | `sennel --version` |
| `stdout` / `console.log` | 通常の処理結果メッセージ（生成ファイルパス等） | `docs scan`, `docs init`, `docs changelog` 等 |
| `stderr` / `console.error` | 進捗ログ・警告メッセージ | `docs build`, `docs forge` 等のパイプライン系 |
| ファイル | 生成ドキュメント（`docs/*.md`, `README.md`, `analysis.json` 等） | `docs build`, `docs text`, `docs init` 等 |

`flow` グループのコマンドはすべて `output(ok(...))` または `output(fail(...))` の JSON エンベロープ形式で stdout に出力し、スキルスクリプトが機械的に解析できる構造を保ちます。不正な引数・設定不備・ファイル未発見など回復不能なエラーは `EXIT_ERROR`（値: 1）で終了します。認識不能なサブコマンドを渡した場合も同様に `EXIT_ERROR` で終了します。
<!-- {{/text}} -->

---

### 保存済み Flow の migration

`sennel migrate specs --to <revision> --spec <specId> --dry-run` は、設定済み
`flow.specDir` の単一 Spec をプレビューします。`--spec` を省略すると全件を
処理します。不正・不存在の指定を全件処理へ切り替えることはありません。
プレビューは Spec、identity authority、registry、worktree binding、journal を
変更しません。

通常の Flow command が `FLOW_MIGRATION_REQUIRED` を返した場合は、案内された
対象限定の dry-run を確認し、同じコマンドから `--dry-run` を外して適用します。
必要な migration は応答の順序に従い、各段階のプレビュー・適用・復旧で同じ
`--spec` を保持してください。revision 2 は旧 Artifact layout、既存 revision
3/4 は後続の保存契約を移行します。後続 migration が必要な場合、revision 2
の完了だけでは継続できません。

証明できる完了済み Step、run identity、進行位置を維持し、欠損・改変された
証跡は拒否します。完了結果を再生成しません。中断後は同じ対象限定コマンドを
再実行して復旧します。通常の Flow command は自動 migration を行いません。
未対応形式の `FLOW_FORMAT_UNSUPPORTED` と authority の整合性エラーを区別します。

<!-- {{data("base.docs.nav")}} -->
[← プロジェクト構成](project_structure.md) | [設定とカスタマイズ →](configuration.md)
<!-- {{/data}} -->
