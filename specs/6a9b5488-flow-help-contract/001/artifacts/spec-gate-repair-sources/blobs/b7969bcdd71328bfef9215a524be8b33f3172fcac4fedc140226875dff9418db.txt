/**
 * src/flow/lib/get-prompt.js
 *
 * Return structured prompt for a flow step.
 * Static kinds return full choices. Hybrid kinds return layout data only.
 * Responds in the language configured in .sennel/config.json (lang field).
 *
 * ctx.kind — prompt kind (e.g. "plan.work-environment", "impl.review-mode")
 */

import { FlowCommand } from "./base-command.js";
import { ApprovalDecisionPrompt } from "./flow-decision-prompt.js";

/**
 * @typedef {{ id: number, label: string, description: string, recommended: boolean }} Choice
 * @typedef {{ phase: string, step: string, current: number|null, total: number|null, prompt: string, description: string, recommendation: string|null, choices: Choice[] }} PromptData
 */

/** Prompt definitions keyed by language then by kind. */
const PROMPTS_BY_LANG = {
  ja: {
    "plan.work-environment": {
      phase: "plan", step: "work-environment",
      description: "作業環境を選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "Git worktree（隔離した環境で作業）", description: "", recommended: false },
        { id: 2, label: "Branch（feature ブランチを作成）", description: "", recommended: false },
        { id: 3, label: "ブランチを作成しない", description: "", recommended: false },
      ],
    },
    "plan.dirty-worktree": {
      phase: "plan", step: "dirty-worktree",
      description: "未コミットの変更があります。先に commit または stash してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "コミットする", description: "", recommended: false },
        { id: 2, label: "スタッシュする", description: "", recommended: false },
        { id: 3, label: "その他", description: "", recommended: false },
      ],
    },
    "plan.test-mode": {
      phase: "plan", step: "test-mode",
      description: "テストを実行するか選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "実行する", description: "", recommended: true },
        { id: 2, label: "実行しない", description: "", recommended: false },
        { id: 3, label: "その他", description: "", recommended: false },
      ],
    },
    "plan.draft": {
      phase: "plan", step: "draft",
      description: "",
      recommendation: null,
      choices: [],
      _hybrid: true,
    },
    "plan.complete": {
      phase: "plan", step: "complete",
      description: "プランニングフェーズが完了しました。次の操作を選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "実装を進める", description: "", recommended: false },
        { id: 2, label: "プランを見直す", description: "", recommended: false },
        { id: 3, label: "その他", description: "", recommended: false },
      ],
    },
    "plan.base-branch": {
      phase: "plan", step: "base-branch",
      description: "現在のブランチから分岐します。",
      recommendation: null,
      choices: [
        { id: 1, label: "はい", description: "", recommended: false },
        { id: 2, label: "ブランチを指定する", description: "", recommended: false },
        { id: 3, label: "その他", description: "", recommended: false },
      ],
    },
    "impl.review-mode": {
      phase: "impl", step: "review-mode",
      description: "コードレビューの方針を選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "コードレビューを行い、自動で改善する", description: "", recommended: false },
        { id: 2, label: "コードレビューのみ", description: "", recommended: false },
        { id: 3, label: "しない", description: "", recommended: false },
      ],
    },
    "impl.review-item": {
      phase: "impl", step: "review-item",
      description: "",
      recommendation: null,
      choices: [],
      _hybrid: true,
    },
    "impl.confirmation": {
      phase: "impl", step: "confirmation",
      description: "実装とレビューが完了しました。次の操作を選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "承認する", description: "", recommended: false },
        { id: 2, label: "実装内容の概要を確認する", description: "", recommended: false },
        { id: 3, label: "実装内容を詳細に確認する", description: "", recommended: false },
        { id: 4, label: "その他", description: "", recommended: false },
      ],
    },
    "finalize.mode": {
      phase: "finalize", step: "mode",
      description: "終了処理の範囲を選択してください。",
      recommendation: null,
      choices: [
        { id: 1, label: "すべて実行", description: "コミット、マージまたは PR 作成、後片付け、必要ならドキュメント同期までまとめて進める", recommended: false },
        { id: 2, label: "個別に選択する", description: "実行する終了処理だけを選び、選んだものだけ順に進める", recommended: false },
      ],
    },
    "finalize.steps": {
      phase: "finalize", step: "steps",
      description: "実行するステップを選択してください。番号をカンマ区切りで入力（例: 1,2,3）",
      recommendation: null,
      // spec 251: retro is a mainline impl-phase step that runs before finalize.
      // It is no longer a finalize-time choice.
      choices: [
        { id: 1, label: "コミット", description: "", recommended: false },
        { id: 2, label: "マージ / PR 作成", description: "", recommended: false },
        { id: 3, label: "ドキュメント同期", description: "", recommended: false },
        { id: 4, label: "ブランチ削除", description: "", recommended: false },
        { id: 5, label: "作業の記録を保存", description: "", recommended: false },
      ],
    },
    "finalize.cleanup": {
      phase: "finalize", step: "cleanup",
      description: "worktree を削除しますか？",
      recommendation: null,
      choices: [
        { id: 1, label: "削除する", description: "", recommended: false },
        { id: 2, label: "残す", description: "", recommended: false },
        { id: 3, label: "その他", description: "", recommended: false },
      ],
    },
  },
  en: {
    "plan.work-environment": {
      phase: "plan", step: "work-environment",
      description: "Choose a work environment.",
      recommendation: null,
      choices: [
        { id: 1, label: "Git worktree (work in an isolated environment)", description: "", recommended: false },
        { id: 2, label: "Branch (create a feature branch)", description: "", recommended: false },
        { id: 3, label: "No branch", description: "", recommended: false },
      ],
    },
    "plan.dirty-worktree": {
      phase: "plan", step: "dirty-worktree",
      description: "There are uncommitted changes. Please commit or stash first.",
      recommendation: null,
      choices: [
        { id: 1, label: "Commit", description: "", recommended: false },
        { id: 2, label: "Stash", description: "", recommended: false },
        { id: 3, label: "Other", description: "", recommended: false },
      ],
    },
    "plan.test-mode": {
      phase: "plan", step: "test-mode",
      description: "Run tests?",
      recommendation: null,
      choices: [
        { id: 1, label: "Run", description: "", recommended: true },
        { id: 2, label: "Skip", description: "", recommended: false },
        { id: 3, label: "Other", description: "", recommended: false },
      ],
    },
    "plan.draft": {
      phase: "plan", step: "draft",
      description: "",
      recommendation: null,
      choices: [],
      _hybrid: true,
    },
    "plan.complete": {
      phase: "plan", step: "complete",
      description: "Planning phase is complete. Choose next action.",
      recommendation: null,
      choices: [
        { id: 1, label: "Proceed to implementation", description: "", recommended: false },
        { id: 2, label: "Review the plan", description: "", recommended: false },
        { id: 3, label: "Other", description: "", recommended: false },
      ],
    },
    "plan.base-branch": {
      phase: "plan", step: "base-branch",
      description: "Branch from current branch.",
      recommendation: null,
      choices: [
        { id: 1, label: "Yes", description: "", recommended: false },
        { id: 2, label: "Specify a branch", description: "", recommended: false },
        { id: 3, label: "Other", description: "", recommended: false },
      ],
    },
    "impl.review-mode": {
      phase: "impl", step: "review-mode",
      description: "Choose code review policy.",
      recommendation: null,
      choices: [
        { id: 1, label: "Run code review and auto-fix", description: "", recommended: false },
        { id: 2, label: "Code review only", description: "", recommended: false },
        { id: 3, label: "Skip", description: "", recommended: false },
      ],
    },
    "impl.review-item": {
      phase: "impl", step: "review-item",
      description: "",
      recommendation: null,
      choices: [],
      _hybrid: true,
    },
    "impl.confirmation": {
      phase: "impl", step: "confirmation",
      description: "Implementation and review are complete. Choose next action.",
      recommendation: null,
      choices: [
        { id: 1, label: "Approve", description: "", recommended: false },
        { id: 2, label: "Review implementation overview", description: "", recommended: false },
        { id: 3, label: "Review implementation in detail", description: "", recommended: false },
        { id: 4, label: "Other", description: "", recommended: false },
      ],
    },
    "finalize.mode": {
      phase: "finalize", step: "mode",
      description: "Choose the scope of finalization.",
      recommendation: null,
      choices: [
        { id: 1, label: "Run all steps", description: "Commit, merge or PR, cleanup, and documentation sync in one go", recommended: false },
        { id: 2, label: "Choose individually", description: "Select only the steps you want to run", recommended: false },
      ],
    },
    "finalize.steps": {
      phase: "finalize", step: "steps",
      description: "Select steps to execute. Enter numbers separated by commas (e.g., 1,2,3).",
      recommendation: null,
      // spec 251: retro is a mainline impl-phase step that runs before finalize.
      // It is no longer a finalize-time choice.
      choices: [
        { id: 1, label: "Commit", description: "", recommended: false },
        { id: 2, label: "Merge / PR creation", description: "", recommended: false },
        { id: 3, label: "Documentation sync", description: "", recommended: false },
        { id: 4, label: "Branch cleanup", description: "", recommended: false },
        { id: 5, label: "Save work record", description: "", recommended: false },
      ],
    },
    "finalize.cleanup": {
      phase: "finalize", step: "cleanup",
      description: "Remove worktree?",
      recommendation: null,
      choices: [
        { id: 1, label: "Remove", description: "", recommended: false },
        { id: 2, label: "Keep", description: "", recommended: false },
        { id: 3, label: "Other", description: "", recommended: false },
      ],
    },
  },
};

const DECISION_PROMPT_KINDS = new Set(["plan.approval"]);

/** Get all valid kind names (from ja, which is the superset). */
function validKinds() {
  return [...new Set([...Object.keys(PROMPTS_BY_LANG.ja), ...DECISION_PROMPT_KINDS])];
}

export default class GetPromptCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false, explicitTargetResolution: true });
  }

  execute(ctx) {
    const kind = ctx.kind;

    if (!kind) {
      throw new Error(`kind required. valid: ${validKinds().join(", ")}`);
    }

    if (!PROMPTS_BY_LANG.ja[kind] && !DECISION_PROMPT_KINDS.has(kind)) {
      throw new Error(`unknown kind '${kind}'. valid: ${validKinds().join(", ")}`);
    }

    const config = ctx.config;
    const lang = config?.lang || "en";
    const prompts = PROMPTS_BY_LANG[lang] || PROMPTS_BY_LANG.en;
    const def = kind === "plan.approval"
      ? new ApprovalDecisionPrompt({ root: ctx.root, config }).toPromptData({
        state: ctx.flowState,
      })
      : prompts[kind] || PROMPTS_BY_LANG.en[kind];

    // Get qa-count for current/total if in draft phase
    let current = null;
    let total = null;
    const state = ctx.flowState;
    if (state?.metrics?.draft) {
      current = state.metrics.draft.question || 0;
    }

    return {
      phase: def.phase,
      step: def.step,
      current,
      total,
      prompt: "",
      description: def.description,
      recommendation: def.recommendation,
      choices: def.choices.map(({ id, label, description, recommended }) => ({ id, label, description, recommended })),
    };
  }
}
