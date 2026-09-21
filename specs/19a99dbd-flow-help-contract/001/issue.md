## Overview

Because the parser definitions (`args.flags` / `args.options` / `args.optionalOptions`) and help definitions for `sennel flow` are managed separately, the options actually accepted do not match the displayed content. In addition, incorrect group help, broken subcommand table layouts, and display order dependent on registration order also occur.

An audit of the current source covering all 67 leaves in `FLOW_COMMANDS` and `flow get/set/run/report --help` confirmed the following:

- For 41 of the 67 leaves, at least one declared flag/option is missing from help.
- The frequently omitted shared options are `--expect-binding` (35 commands), `--expect-no-issue` / `--expect-issue` / `--expect-spec` / `--expect-run-id` (31 commands each), and `--agent-work-dir` (23 commands).
- The implicit `-h, --help` is not displayed in the leaf help for any of the 67 leaves.
- The group help for `flow get` / `set` / `report` displays `--agent-work-dir <path>`, which is not accepted by the leaves under those groups.
- For subcommand names 14 characters or longer, there is no separator between the name and summary, causing the strings to run together. This affects 25 commands (`get` 1, `set` 3, `run` 21).
- The display order of subcommands depends on their declaration order in `FLOW_COMMANDS` and is not defined as a help ordering contract.

## Reproduction

`flow run abort` accepts the following options according to the parser, but help displays only `--force`.

```text
--force
--agent-work-dir <path>
--expect-binding <token>
--expect-issue <number>
--expect-no-issue
--expect-spec <spec>
--expect-run-id <runId>
```

```console
$ sennel flow run abort --help
Usage: sennel flow run abort [--force]

Remove only the selected flow worktree, feature branch, shared spec directory, and active entry.
--force permits removal of a dirty isolated worktree; unrelated base-checkout changes are never removed.
```

Also, due to the incorrect group help, the following input fails:

```console
$ sennel flow get qa-count --agent-work-dir /tmp/sennel-help-audit
Unknown option: --agent-work-dir
```

## Cause

- In `src/flow/registry.js`, the parser-authoritative `args` and display-oriented `help` are written separately by hand.
- When a leaf is invoked with `--help`, `src/lib/dispatcher.js` outputs `entry.help` as-is and does not validate or supplement it against `args`.
- `flowOptions()` in `src/lib/command-registry.js` reverse-parses hand-written help, while group options are managed in a separate fixed array.
- `CommandDefinition.renderHelp()` in `src/lib/command-registry.js` and `renderCommand()` in `src/help.js` duplicate the implementation of the subcommand table.
- Neither renderer guarantees a separator for command names exceeding the fixed width, and both display commands in registration order.
- Existing tests verify parser acceptance for some options, but do not verify complete agreement between the parser and help contracts, the common intersection of group options, long names, or display order.

## Fix direction

Extend the existing `CommandDefinition` so that the parser and help reference the same option authority. Do not add a separate command abstraction.

- Define a dedicated model representing the option name, value placeholder, description, and type: flag / required-value option / optional-value option.
- Compose target guards, run runtime options, and implicit help as shared option collections.
- Project `args.flags`, `args.options`, `args.optionalOptions`, leaf help, and group help from the model.
- Keep command-specific descriptions and examples in the existing help, but make the model authoritative for the Usage and Options listings.
- Derive group help options from the intersection of the option contracts of child leaves and eliminate the fixed array.
- Consolidate subcommand sorting and alignment in a shared renderer, and reuse it for `sennel flow <group> --help` and `sennel help flow <group>`.
- Sort subcommands by name in ascending order by default, overriding this only with explicit display-order metadata when semantic ordering is required.
- Use a table layout of `maxName + separator` or a multiline format, guaranteeing at least 1 character, preferably 2, of visible separation between the name and summary.

## Acceptance criteria

- For all 67 leaves in `FLOW_COMMANDS`, every flag/option accepted by the public parser, along with the implicit `-h, --help`, appears exactly once by name in the rendered leaf help.
- The option model distinguishes valueless flags, required-value options, and optional-value options, and provides a placeholder and description for options that take values.
- `sennel flow run abort --help` displays `--force`, `--agent-work-dir`, all 5 target guards, and `-h, --help`.
- `flow get --help`, `flow set --help`, and `flow report --help` do not display `--agent-work-dir`; only `flow run --help` displays it.
- The boundary between the command name and summary is always visible on every subcommand row in `flow get/set/run/report --help`.
- Subcommands in every group are displayed in ascending name order and do not depend on their declaration positions in `FLOW_COMMANDS`.
- `sennel flow <group> --help` and `sennel help flow <group>` use the same ordering and layout contract.
- Add registry/help contract tests covering all leaves and groups, including `flow resume` and `prepare`.
- Add focused E2E tests covering `abort`, `get` / `set` / `run` with target guards, long subcommand names, and name ordering.
- Do not change command execution semantics, target guard evaluation, or runtime directory behavior.

## Target files

- `src/flow/registry.js`
- `src/lib/dispatcher.js`
- `src/lib/command-registry.js`
- `src/help.js`
- `tests/integration/lib/command-registry.test.js`
- `tests/e2e/help.test.js`

## Audit basis

The parser definitions and help were compared by recursively traversing `FLOW_COMMANDS`, and representative leaf/group help and `sennel help flow <group>` were executed. The audit also confirmed that options displayed in group help but unsupported by the actual CLI result in `Unknown option`, and that existing related integration/E2E tests do not detect this issue even when they pass.

<details>
<summary>ja</summary>

Flow helpが実引数契約と不一致でオプションを欠落・誤表示する

## 概要

`sennel flow` の parser 定義（`args.flags` / `args.options` / `args.optionalOptions`）と help 定義が別々に管理されているため、実際に受理できる option と表示内容が一致していない。さらに、group help の誤表示、subcommand 表のレイアウト崩れ、登録順に依存した表示順も発生している。

現行ソースを `FLOW_COMMANDS` の全 67 leaf と `flow get/set/run/report --help` について監査した結果、次を確認した。

- 67 leaf 中 41 leaf で、宣言済み flag/option が少なくとも 1 個 help から欠落している。
- 欠落頻度が高い共有 option は `--expect-binding`（35 command）、`--expect-no-issue` / `--expect-issue` / `--expect-spec` / `--expect-run-id`（各 31 command）、`--agent-work-dir`（23 command）。
- implicit な `-h, --help` が全 67 leaf の leaf help に表示されない。
- `flow get` / `set` / `report` の group help が、配下の leaf で受理されない `--agent-work-dir <path>` を表示する。
- 14 文字以上の subcommand 名で、名前と summary の間に区切りがなく文字列が連結する。対象は 25 command（`get` 1、`set` 3、`run` 21）。
- subcommand の表示順が `FLOW_COMMANDS` の宣言順に依存し、help の順序契約として定義されていない。

## 再現例

`flow run abort` は parser 上では次を受理するが、help には `--force` しか表示されない。

```text
--force
--agent-work-dir <path>
--expect-binding <token>
--expect-issue <number>
--expect-no-issue
--expect-spec <spec>
--expect-run-id <runId>
```

```console
$ sennel flow run abort --help
Usage: sennel flow run abort [--force]

Remove only the selected flow worktree, feature branch, shared spec directory, and active entry.
--force permits removal of a dirty isolated worktree; unrelated base-checkout changes are never removed.
```

また、group help の誤表示により、次のような入力が失敗する。

```console
$ sennel flow get qa-count --agent-work-dir /tmp/sennel-help-audit
Unknown option: --agent-work-dir
```

## 原因

- `src/flow/registry.js` で parser authority の `args` と表示用 `help` を個別に手書きしている。
- `src/lib/dispatcher.js` は leaf の `--help` 時に `entry.help` をそのまま出力し、`args` との整合を検証・補完しない。
- `src/lib/command-registry.js` の `flowOptions()` が手書き help を逆解析し、group option は別の固定配列で管理している。
- `src/lib/command-registry.js` の `CommandDefinition.renderHelp()` と `src/help.js` の `renderCommand()` が subcommand 表を重複実装している。
- 両 renderer が固定幅を超える command 名の区切りを保証せず、登録順をそのまま表示している。
- 既存テストは一部 option の parser 受理を確認するが、parser contract と help contract の完全一致、group option の共通部分、長い名前、表示順を検証していない。

## 修正方針

既存の `CommandDefinition` を拡張し、parser と help が同じ option authority を参照する構造にする。別系統の command abstraction は追加しない。

- option 名、value placeholder、説明、flag／必須値 option／任意値 option の種別を表す専用 model を定義する。
- target guard、run runtime option、implicit help を共有 option collection として構成する。
- model から `args.flags`、`args.options`、`args.optionalOptions`、leaf help、group help を投影する。
- command 固有の説明と例は既存 help に保持するが、Usage と Options の列挙は model を authority とする。
- group help の option は子 leaf の option 契約の共通部分から導出し、固定配列を廃止する。
- subcommand 表のソートと整列を共通 renderer に集約し、`sennel flow <group> --help` と `sennel help flow <group>` で再利用する。
- subcommand は既定で名前昇順とし、意味的な順序が必要な場合のみ明示的な表示順 metadata で上書きする。
- 表レイアウトは `maxName + separator` または複数行形式とし、名前と summary の間に最低 1 文字、推奨 2 文字の可視区切りを保証する。

## 受け入れ条件

- `FLOW_COMMANDS` の全 67 leaf について、公開 parser が受理する全 flag/option と implicit `-h, --help` が rendered leaf help に名前付きで一度ずつ表示される。
- option model が値なし flag、必須値 option、任意値 optionを区別し、値を取る option に placeholder と説明を提供する。
- `sennel flow run abort --help` に `--force`、`--agent-work-dir`、5 種の target guard、`-h, --help` が表示される。
- `flow get --help`、`flow set --help`、`flow report --help` は `--agent-work-dir` を表示せず、`flow run --help` のみが表示する。
- `flow get/set/run/report --help` の全 subcommand 行で、command 名と summary の境界が常に可視である。
- 全 group の subcommand が名前昇順で表示され、`FLOW_COMMANDS` の宣言位置に依存しない。
- `sennel flow <group> --help` と `sennel help flow <group>` が同じ順序・レイアウト契約を使う。
- `flow resume`、`prepare` を含む全 leaf と group を対象に registry/help contract test を追加する。
- focused E2E で `abort`、target guard を持つ `get` / `set` / `run`、長い subcommand 名、名前順を検証する。
- command 実行 semantics、target guard の判定、runtime directory の挙動を変更しない。

## 対象箇所

- `src/flow/registry.js`
- `src/lib/dispatcher.js`
- `src/lib/command-registry.js`
- `src/help.js`
- `tests/integration/lib/command-registry.test.js`
- `tests/e2e/help.test.js`

## 監査根拠

`FLOW_COMMANDS` を再帰走査して parser 定義と help を照合し、代表的な leaf/group help と `sennel help flow <group>` を実行した。group help に表示される未対応 option が実 CLI で `Unknown option` になること、既存の関連 integration/E2E テストが成功しても本不具合を検出しないことも確認している。

</details>
