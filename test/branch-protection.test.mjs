import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_REQUIRED_CHECKS,
  DEFAULT_REQUIRED_APPROVING_REVIEWS,
  applyRecommendedDefaults,
  filterBotChecks,
  isBotContext,
  mergeRequiredChecks,
  stripReadOnlyFields,
} from '../lib/branch-protection.mjs';

test('isBotContext detects [bot] suffix', () => {
  assert.equal(isBotContext('coderabbitai[bot]'), true);
  assert.equal(isBotContext('protoquinn[bot]'), true);
});

test('isBotContext detects known bot vendor names case-insensitively', () => {
  assert.equal(isBotContext('CodeRabbit'), true);
  assert.equal(isBotContext('codeRABBIT review'), true);
  assert.equal(isBotContext('protoquinn / QA'), true);
  assert.equal(isBotContext('SonarCloud Code Analysis'), true);
});

test('isBotContext leaves real CI context names alone', () => {
  for (const ctx of ['build', 'test', 'checks', 'ci-complete', 'lint', 'typecheck', 'e2e']) {
    assert.equal(isBotContext(ctx), false, `expected ${ctx} not to match`);
  }
});

test('isBotContext supports extraPatterns for repo-specific bots', () => {
  assert.equal(isBotContext('custom-llm-review', ['custom-llm']), true);
  assert.equal(isBotContext('build', ['custom-llm']), false);
});

test('isBotContext is conservative — empty / null / undefined return false', () => {
  assert.equal(isBotContext(''), false);
  assert.equal(isBotContext(null), false);
  assert.equal(isBotContext(undefined), false);
});

test('filterBotChecks separates bots from real checks', () => {
  const input = [
    { context: 'build', integration_id: 1 },
    { context: 'test', integration_id: 1 },
    { context: 'CodeRabbit', integration_id: 999 },
    { context: 'checks', integration_id: 1 },
  ];
  const { kept, removed } = filterBotChecks(input);
  assert.deepEqual(
    kept.map((c) => c.context),
    ['build', 'test', 'checks']
  );
  assert.deepEqual(
    removed.map((c) => c.context),
    ['CodeRabbit']
  );
});

test('mergeRequiredChecks preserves integration_id for known contexts', () => {
  const existing = [
    { context: 'build', integration_id: 15368 },
    { context: 'test', integration_id: 15368 },
  ];
  const desired = ['build', 'test', 'checks', 'ci-complete'];
  const merged = mergeRequiredChecks(existing, desired);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0], { context: 'build', integration_id: 15368 });
  assert.deepEqual(merged[1], { context: 'test', integration_id: 15368 });
  // New contexts have no integration_id — GitHub resolves at apply time.
  assert.deepEqual(merged[2], { context: 'checks' });
  assert.deepEqual(merged[3], { context: 'ci-complete' });
});

test('applyRecommendedDefaults drops bot checks and sets strict false by default', () => {
  const ruleset = {
    id: 12552305,
    name: 'Protect main',
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: true,
          required_status_checks: [
            { context: 'build', integration_id: 15368 },
            { context: 'test', integration_id: 15368 },
            { context: 'checks', integration_id: 15368 },
            { context: 'CodeRabbit', integration_id: 347564 },
          ],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  };

  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset);

  const rule = next.rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(
    rule.parameters.required_status_checks.map((c) => c.context),
    DEFAULT_REQUIRED_CHECKS
  );
  assert.equal(rule.parameters.strict_required_status_checks_policy, false);

  assert.equal(diff.strictBefore, true);
  assert.equal(diff.strictAfter, false);
  assert.ok(diff.removedContexts.includes('CodeRabbit'));
});

test('applyRecommendedDefaults respects custom required-checks list', () => {
  const ruleset = { rules: [] };
  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset, {
    requiredChecks: ['build', 'lint', 'typecheck'],
  });

  const rule = next.rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(
    rule.parameters.required_status_checks.map((c) => c.context),
    ['build', 'lint', 'typecheck']
  );
  assert.deepEqual(diff.addedContexts, ['build', 'lint', 'typecheck']);
});

test('applyRecommendedDefaults supports --strict opt-in', () => {
  const ruleset = { rules: [] };
  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset, {
    requiredChecks: ['build'],
    strict: true,
  });
  const rule = next.rules.find((r) => r.type === 'required_status_checks');
  assert.equal(rule.parameters.strict_required_status_checks_policy, true);
  assert.equal(diff.strictAfter, true);
});

test('applyRecommendedDefaults supports allow-bot-checks via excludeBots:false', () => {
  // The CLI may set this when a caller has explicitly opted in via
  // --allow-bot-checks. In that mode, a bot context that the user requested
  // explicitly must survive.
  const ruleset = { rules: [] };
  const { ruleset: next } = applyRecommendedDefaults(ruleset, {
    requiredChecks: ['build', 'CodeRabbit'],
    excludeBots: false,
  });
  const rule = next.rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(
    rule.parameters.required_status_checks.map((c) => c.context),
    ['build', 'CodeRabbit']
  );
});

test('applyRecommendedDefaults creates the rule if missing', () => {
  const ruleset = { rules: [] };
  const { ruleset: next } = applyRecommendedDefaults(ruleset, {
    requiredChecks: ['build', 'test'],
  });
  const rule = next.rules.find((r) => r.type === 'required_status_checks');
  assert.ok(rule, 'expected required_status_checks rule to be added');
  assert.deepEqual(rule.parameters.required_status_checks.map((c) => c.context), ['build', 'test']);
});

test('DEFAULT_REQUIRED_APPROVING_REVIEWS is 0 (approvals advisory)', () => {
  assert.equal(DEFAULT_REQUIRED_APPROVING_REVIEWS, 0);
});

test('applyRecommendedDefaults zeroes review count + thread resolution on an existing pull_request rule', () => {
  const ruleset = {
    name: 'Protect main',
    rules: [
      { type: 'required_status_checks', parameters: { required_status_checks: [] } },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
          dismiss_stale_reviews_on_push: true,
          allowed_merge_methods: ['merge', 'squash'],
        },
      },
    ],
  };

  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset);

  const pr = next.rules.find((r) => r.type === 'pull_request');
  assert.equal(pr.parameters.required_approving_review_count, 0);
  assert.equal(pr.parameters.required_review_thread_resolution, false);
  // Unrelated PR params are preserved.
  assert.equal(pr.parameters.dismiss_stale_reviews_on_push, true);
  assert.deepEqual(pr.parameters.allowed_merge_methods, ['merge', 'squash']);

  assert.equal(diff.pullRequestRulePresent, true);
  assert.equal(diff.reviewsBefore, 1);
  assert.equal(diff.reviewsAfter, 0);
  assert.equal(diff.threadResolutionBefore, true);
  assert.equal(diff.threadResolutionAfter, false);
});

test('applyRecommendedDefaults honors a custom requiredReviews (human-review opt-out)', () => {
  const ruleset = {
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }],
  };
  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset, {
    requiredReviews: 2,
    requireThreadResolution: true,
  });
  const pr = next.rules.find((r) => r.type === 'pull_request');
  assert.equal(pr.parameters.required_approving_review_count, 2);
  assert.equal(pr.parameters.required_review_thread_resolution, true);
  assert.equal(diff.reviewsAfter, 2);
  assert.equal(diff.threadResolutionAfter, true);
});

test('applyRecommendedDefaults never CREATES a pull_request rule when absent', () => {
  const ruleset = { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }] };
  const { ruleset: next, diff } = applyRecommendedDefaults(ruleset);
  assert.equal(next.rules.some((r) => r.type === 'pull_request'), false);
  assert.equal(diff.pullRequestRulePresent, false);
  assert.equal(diff.reviewsAfter, null);
  assert.equal(diff.threadResolutionAfter, null);
});

test('stripReadOnlyFields removes id and other server-only fields', () => {
  const before = {
    id: 12552305,
    node_id: 'RR_xxx',
    name: 'Protect main',
    created_at: '2024-01-01',
    updated_at: '2026-01-01',
    source_type: 'Repository',
    source: 'protoLabsAI/protoMaker',
    current_user_can_bypass: 'always',
    _links: { self: { href: '...' } },
    rules: [{ type: 'required_status_checks', parameters: {} }],
  };
  const after = stripReadOnlyFields(before);
  assert.equal(after.id, undefined);
  assert.equal(after.node_id, undefined);
  assert.equal(after.created_at, undefined);
  assert.equal(after.updated_at, undefined);
  assert.equal(after.source_type, undefined);
  assert.equal(after.source, undefined);
  assert.equal(after.current_user_can_bypass, undefined);
  assert.equal(after._links, undefined);
  assert.equal(after.name, 'Protect main');
  assert.ok(after.rules);
  // Doesn't mutate the original
  assert.equal(before.id, 12552305);
});
