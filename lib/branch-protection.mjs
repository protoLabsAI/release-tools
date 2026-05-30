/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Branch protection ruleset utilities.
 *
 * Three recommendations are codified here:
 *
 *  1. Bot reviewers do not belong in `required_status_checks`. Treat them as
 *     reviewers (they gate via `reviewDecision`), not as CI. Required status
 *     checks should reflect correctness signals only — build, test, lint.
 *     See protoLabsAI/release-tools#10.
 *
 *  2. `strict_required_status_checks_policy` should default to `false` for
 *     fast-moving, low-conflict repos with linear PR stacks. Strict mode
 *     forces an N×CI-cycle drag on stacked work. See
 *     protoLabsAI/release-tools#6.
 *
 *  3. `required_approving_review_count` should default to `0`, and
 *     `required_review_thread_resolution` to `false`. Approvals are advisory;
 *     a `CHANGES_REQUESTED` review is the explicit veto (it blocks via
 *     `reviewDecision`). Across the fleet, PRs are authored by an automation
 *     identity that cannot approve its own PR, so a count of 1 is permanently
 *     unsatisfiable and deadlocks every PR at `REVIEW_REQUIRED` despite green
 *     CI. Mandatory thread resolution re-introduces the same class of bot-stall
 *     as rule 1 (an unresolved CodeRabbit/SonarCloud thread blocks merge). CI
 *     (rule 1) is the correctness gate. Only an EXISTING pull_request rule is
 *     tuned — this never adds a PR requirement to a repo that lacks one.
 *     See protoLabsAI/protoMaker#3985.
 *
 * The exported functions are pure: they take a ruleset JSON shape, return a
 * new (or diff) ruleset JSON shape. The thin CLI in `bin/apply-branch-protection.mjs`
 * is responsible for I/O (fetching from GitHub, writing back).
 */

/**
 * Default contexts the script recommends as required. Correctness only.
 *
 * Intentionally minimal — `build`, `test`, and `checks` (lint/format) are
 * the universal correctness signals. Repo-specific rollups like
 * `ci-complete` should be added explicitly via `--required-checks` because
 * not every repo emits them and forcing them silently would BLOCK PRs in
 * repos that don't ship that workflow.
 */
export const DEFAULT_REQUIRED_CHECKS = ['build', 'test', 'checks'];

/**
 * Default number of approving reviews required to merge. `0` by default:
 * approvals are advisory, and a `CHANGES_REQUESTED` review is the explicit
 * veto (via `reviewDecision`). The fleet's automation identity authors every
 * PR and cannot approve its own, so any positive count is unsatisfiable and
 * deadlocks PRs at `REVIEW_REQUIRED`. Override with `--required-reviews <n>`
 * on repos with a human review workflow that can actually supply approvals.
 */
export const DEFAULT_REQUIRED_APPROVING_REVIEWS = 0;

/**
 * Substrings that identify a context as a bot reviewer rather than a CI check.
 * Matched case-insensitively against the context name. Extend via the
 * `extraBotPatterns` argument on `filterBotChecks`.
 */
export const KNOWN_BOT_PATTERNS = [
  '[bot]',
  'coderabbit',
  'protoquinn',
  'protoava',
  'protojon',
  'sonarcloud', // posts review-style status — treat as advisory
];

/**
 * Decide whether a status-check context name looks like a bot reviewer.
 *
 * @param {string} context
 * @param {string[]} [extraPatterns]
 * @returns {boolean}
 */
export function isBotContext(context, extraPatterns = []) {
  if (!context) return false;
  const lower = String(context).toLowerCase();
  return [...KNOWN_BOT_PATTERNS, ...extraPatterns].some((p) =>
    lower.includes(String(p).toLowerCase())
  );
}

/**
 * Filter a list of required_status_checks entries, dropping any entry whose
 * context name matches a known bot pattern.
 *
 * @param {Array<{ context: string, integration_id?: number }>} checks
 * @param {{ extraBotPatterns?: string[] }} [opts]
 * @returns {{ kept: typeof checks, removed: typeof checks }}
 */
export function filterBotChecks(checks, opts = {}) {
  const extra = opts.extraBotPatterns ?? [];
  const kept = [];
  const removed = [];
  for (const c of checks ?? []) {
    if (isBotContext(c.context, extra)) {
      removed.push(c);
    } else {
      kept.push(c);
    }
  }
  return { kept, removed };
}

/**
 * Merge a desired list of context names into the existing required_status_checks
 * entries, preserving any `integration_id` that's already known for that
 * context and inserting bare entries for any new ones.
 *
 * @param {Array<{ context: string, integration_id?: number }>} existing
 * @param {string[]} desiredContexts
 * @returns {Array<{ context: string, integration_id?: number }>}
 */
export function mergeRequiredChecks(existing, desiredContexts) {
  const existingByContext = new Map((existing ?? []).map((c) => [c.context, c]));
  return desiredContexts.map((context) => {
    const prev = existingByContext.get(context);
    return prev ?? { context };
  });
}

/**
 * Apply the recommended defaults to a ruleset JSON shape.
 *
 * @param {object} ruleset - The full ruleset object from
 *   `GET /repos/{owner}/{repo}/rulesets/{id}`.
 * @param {object} [opts]
 * @param {string[]} [opts.requiredChecks] - Context names to require. Default DEFAULT_REQUIRED_CHECKS.
 * @param {boolean} [opts.strict] - strict_required_status_checks_policy. Default false.
 * @param {boolean} [opts.excludeBots] - Drop bot-pattern contexts. Default true.
 * @param {string[]} [opts.extraBotPatterns] - Additional case-insensitive substrings to treat as bot.
 * @param {number} [opts.requiredReviews] - required_approving_review_count for an existing
 *   pull_request rule. Default DEFAULT_REQUIRED_APPROVING_REVIEWS (0).
 * @param {boolean} [opts.requireThreadResolution] - required_review_thread_resolution. Default false.
 * @returns {{ ruleset: object, diff: object }}
 */
export function applyRecommendedDefaults(ruleset, opts = {}) {
  const requiredChecks = opts.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const strict = opts.strict ?? false;
  const excludeBots = opts.excludeBots ?? true;
  const extraBotPatterns = opts.extraBotPatterns ?? [];
  const requiredReviews = opts.requiredReviews ?? DEFAULT_REQUIRED_APPROVING_REVIEWS;
  const requireThreadResolution = opts.requireThreadResolution ?? false;

  // Deep clone so callers can compare before/after without aliasing.
  const next = JSON.parse(JSON.stringify(ruleset ?? {}));
  if (!Array.isArray(next.rules)) next.rules = [];

  let rule = next.rules.find((r) => r.type === 'required_status_checks');
  if (!rule) {
    rule = {
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: true,
        required_status_checks: [],
        strict_required_status_checks_policy: false,
      },
    };
    next.rules.push(rule);
  }
  if (!rule.parameters) rule.parameters = {};
  const params = rule.parameters;
  const beforeChecks = params.required_status_checks ?? [];
  const beforeStrict =
    typeof params.strict_required_status_checks_policy === 'boolean'
      ? params.strict_required_status_checks_policy
      : null;

  // Step 1: merge the desired context list (preserving known integration_ids).
  let merged = mergeRequiredChecks(beforeChecks, requiredChecks);

  // Step 2: drop bot patterns from anything that survived. Important if a
  // caller passes a custom requiredChecks list that happens to include bots.
  let removed = [];
  if (excludeBots) {
    const filtered = filterBotChecks(merged, { extraBotPatterns });
    merged = filtered.kept;
    removed = filtered.removed;
  }

  params.required_status_checks = merged;
  params.strict_required_status_checks_policy = strict;

  const beforeContexts = beforeChecks.map((c) => c.context);
  const afterContexts = merged.map((c) => c.context);
  const addedContexts = afterContexts.filter((c) => !beforeContexts.includes(c));
  const removedContexts = [
    // Anything dropped because it was a bot, plus anything that wasn't in the
    // new desired list.
    ...removed.map((c) => c.context),
    ...beforeContexts.filter((c) => !afterContexts.includes(c) && !removed.some((r) => r.context === c)),
  ];

  // Step 3: tune the review stance on an EXISTING pull_request rule. We never
  // CREATE one — adding a PR requirement to a repo that lacks it is a bigger
  // policy change than this tool should make silently. Approvals are advisory;
  // CHANGES_REQUESTED is the explicit veto. (release-tools rule 3)
  const prRule = next.rules.find((r) => r.type === 'pull_request');
  let reviewsBefore = null;
  let threadResolutionBefore = null;
  if (prRule) {
    if (!prRule.parameters) prRule.parameters = {};
    reviewsBefore =
      typeof prRule.parameters.required_approving_review_count === 'number'
        ? prRule.parameters.required_approving_review_count
        : null;
    threadResolutionBefore =
      typeof prRule.parameters.required_review_thread_resolution === 'boolean'
        ? prRule.parameters.required_review_thread_resolution
        : null;
    prRule.parameters.required_approving_review_count = requiredReviews;
    prRule.parameters.required_review_thread_resolution = requireThreadResolution;
  }

  return {
    ruleset: next,
    diff: {
      addedContexts,
      removedContexts,
      strictBefore: beforeStrict,
      strictAfter: strict,
      pullRequestRulePresent: !!prRule,
      reviewsBefore,
      reviewsAfter: prRule ? requiredReviews : null,
      threadResolutionBefore,
      threadResolutionAfter: prRule ? requireThreadResolution : null,
    },
  };
}

/**
 * Strip writable-only fields from a ruleset so the result is acceptable as
 * the body of `PUT /repos/{owner}/{repo}/rulesets/{id}`. GitHub rejects
 * read-only fields like `id`, `_links`, `current_user_can_bypass`, etc.
 *
 * @param {object} ruleset
 * @returns {object}
 */
export function stripReadOnlyFields(ruleset) {
  const READ_ONLY = [
    'id',
    'node_id',
    'created_at',
    'updated_at',
    'source_type',
    'source',
    'current_user_can_bypass',
    '_links',
  ];
  const copy = JSON.parse(JSON.stringify(ruleset));
  for (const k of READ_ONLY) delete copy[k];
  return copy;
}
