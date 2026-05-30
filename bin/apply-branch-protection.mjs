#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Apply the protoLabs recommended branch protection ruleset to a repo.
 *
 * Defaults:
 *   - `required_status_checks`: build, test, checks, ci-complete (correctness only)
 *   - `strict_required_status_checks_policy`: false (don't force PRs to be up-to-date with base)
 *   - Drop any context that looks like an LLM review bot (CodeRabbit, protoquinn[bot], etc.)
 *     from required_status_checks. Bots gate via reviewDecision, not status checks.
 *   - On an EXISTING pull_request rule: `required_approving_review_count` → 0 and
 *     `required_review_thread_resolution` → false. Approvals are advisory; CHANGES_REQUESTED
 *     is the explicit veto. The fleet automation identity authors every PR and can't approve
 *     its own, so any positive count deadlocks at REVIEW_REQUIRED. Never creates a PR rule.
 *
 * Driven by the rationale in release-tools#6 (strict policy),
 * release-tools#10 (bot-checks exclusion), and protoMaker#3985 (review-count stance).
 *
 * Usage:
 *   apply-branch-protection [flags]
 *
 * Flags:
 *   --repo <owner/name>       Target repository. Default: derived from `git remote get-url origin`.
 *   --branch <name>           Protected branch name. Default: main.
 *   --ruleset-id <id>         Apply to an existing ruleset by id. If omitted, looks for a ruleset
 *                             matching --branch by name (e.g. "Protect main") and uses the first hit.
 *   --required-checks <list>  Comma-separated context names. Default: build,test,checks,ci-complete.
 *   --strict                  Enable strict_required_status_checks_policy. Default: off (loose).
 *   --required-reviews <n>    required_approving_review_count on an existing pull_request rule.
 *                             Default: 0 (approvals advisory; CHANGES_REQUESTED is the veto).
 *   --require-thread-resolution  Set required_review_thread_resolution true. Default: off.
 *   --allow-bot-checks        Keep contexts whose name looks like an LLM-review bot. Default: drop them.
 *   --extra-bot-patterns <l>  Comma-separated extra case-insensitive substrings to treat as bot.
 *   --apply                   PUT the patched ruleset. Without this flag, prints the diff and exits.
 *   --json                    Print the would-be PUT body to stdout (combine with --apply to also POST).
 *   --help                    Show this help.
 *
 * Environment:
 *   GH_TOKEN / GITHUB_TOKEN   Optional. If unset, falls back to the locally-authenticated `gh` CLI.
 *
 * Examples:
 *   # Dry run — show what would change on the current repo's main branch
 *   apply-branch-protection
 *
 *   # Apply the recommended defaults to a specific repo
 *   apply-branch-protection --repo protoLabsAI/protoMaker --branch main --apply
 *
 *   # Custom required checks for a Rust monorepo
 *   apply-branch-protection --required-checks cargo-test,cargo-clippy,cargo-fmt --apply
 *
 *   # Keep CodeRabbit as required (overrides the bot filter)
 *   apply-branch-protection --allow-bot-checks --required-checks build,test,checks,CodeRabbit --apply
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_REQUIRED_CHECKS,
  applyRecommendedDefaults,
  stripReadOnlyFields,
} from '../lib/branch-protection.mjs';

const execFileAsync = promisify(execFile);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  await printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));

try {
  await main(args);
} catch (err) {
  console.error(`apply-branch-protection: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}

async function main(opts) {
  const repo = opts.repo ?? (await detectRepoFromGit());
  if (!repo) {
    throw new Error(
      'Could not determine target repo. Pass --repo <owner/name> or run inside a git checkout with origin set.'
    );
  }
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`--repo must be in owner/name format, got "${repo}"`);
  }

  const branch = opts.branch ?? 'main';
  const requiredChecks = opts.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const extraBotPatterns = opts.extraBotPatterns ?? [];

  const rulesetId = opts.rulesetId ?? (await findRulesetIdForBranch(owner, name, branch));
  if (!rulesetId) {
    throw new Error(
      `No ruleset found for branch "${branch}" on ${repo}. Create one via the UI first, or pass --ruleset-id.`
    );
  }

  const before = await ghApi(`repos/${owner}/${name}/rulesets/${rulesetId}`);
  const { ruleset: after, diff } = applyRecommendedDefaults(before, {
    requiredChecks,
    strict: opts.strict,
    excludeBots: !opts.allowBotChecks,
    extraBotPatterns,
    requiredReviews: opts.requiredReviews,
    requireThreadResolution: opts.requireThreadResolution,
  });

  console.log(`Repo:        ${repo}`);
  console.log(`Ruleset:     ${before.name ?? '(unnamed)'} (id ${rulesetId})`);
  console.log(`Branch:      ${branch}`);
  console.log('');
  console.log('Diff:');
  if (diff.addedContexts.length === 0 && diff.removedContexts.length === 0) {
    console.log('  required_status_checks: (no change)');
  } else {
    if (diff.addedContexts.length > 0) {
      console.log(`  + ${diff.addedContexts.join(', ')}`);
    }
    if (diff.removedContexts.length > 0) {
      console.log(`  - ${diff.removedContexts.join(', ')}`);
    }
  }
  if (diff.strictBefore !== diff.strictAfter) {
    console.log(`  strict_required_status_checks_policy: ${diff.strictBefore} → ${diff.strictAfter}`);
  }
  if (!diff.pullRequestRulePresent) {
    console.log('  pull_request rule: (none — review stance not applied; this tool never adds one)');
  } else {
    if (diff.reviewsBefore !== diff.reviewsAfter) {
      console.log(`  required_approving_review_count: ${diff.reviewsBefore} → ${diff.reviewsAfter}`);
    }
    if (diff.threadResolutionBefore !== diff.threadResolutionAfter) {
      console.log(
        `  required_review_thread_resolution: ${diff.threadResolutionBefore} → ${diff.threadResolutionAfter}`
      );
    }
  }
  console.log('');

  const body = stripReadOnlyFields(after);

  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
  }

  if (!opts.apply) {
    console.log('Dry run. Re-run with --apply to PUT this ruleset.');
    return;
  }

  await ghApi(`repos/${owner}/${name}/rulesets/${rulesetId}`, {
    method: 'PUT',
    body,
  });
  console.log(`Applied. ${repo} ruleset ${rulesetId} updated.`);
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`flag ${a} requires a value`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--repo':
        opts.repo = next();
        break;
      case '--branch':
        opts.branch = next();
        break;
      case '--ruleset-id':
        opts.rulesetId = Number(next());
        break;
      case '--required-checks':
        opts.requiredChecks = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--required-reviews': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--required-reviews must be a non-negative integer, got "${n}"`);
        }
        opts.requiredReviews = n;
        break;
      }
      case '--require-thread-resolution':
        opts.requireThreadResolution = true;
        break;
      case '--allow-bot-checks':
        opts.allowBotChecks = true;
        break;
      case '--extra-bot-patterns':
        opts.extraBotPatterns = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

async function detectRepoFromGit() {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    });
    const url = stdout.trim();
    // Handle both SSH (git@github.com:owner/name.git) and HTTPS (https://github.com/owner/name.git)
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

async function findRulesetIdForBranch(owner, name, branch) {
  const rulesets = await ghApi(`repos/${owner}/${name}/rulesets`);
  // Prefer an exact "Protect <branch>" match; fall back to first ruleset that
  // mentions the branch in its name.
  const exact = rulesets.find((r) => r.name === `Protect ${branch}`);
  if (exact) return exact.id;
  const loose = rulesets.find((r) => (r.name ?? '').toLowerCase().includes(branch.toLowerCase()));
  return loose?.id ?? null;
}

/**
 * Thin wrapper around the locally-authenticated `gh api` CLI. Uses gh because
 * it already handles auth, host overrides, and rate-limit retries — and every
 * dev environment that runs release-tools also has gh installed.
 */
async function ghApi(endpoint, opts = {}) {
  const args = ['api', endpoint];
  if (opts.method && opts.method !== 'GET') {
    args.push('-X', opts.method);
  }
  if (opts.body) {
    args.push('--input', '-');
  }
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    input: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return JSON.parse(stdout);
}

async function printHelp() {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const self = url.fileURLToPath(import.meta.url);
  const src = fs.readFileSync(self, 'utf8').split('\n');
  const header = [];
  for (const line of src) {
    if (line.startsWith('#!')) continue;
    header.push(line);
    if (line.startsWith(' */')) break;
  }
  console.log(header.join('\n'));
}
