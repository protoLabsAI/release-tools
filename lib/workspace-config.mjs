/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The protoLabs workspace-config standard.
 *
 * Every repo the fleet watches and manages (Quinn review scope — see
 * protoWorkstacean/workspace/projects.yaml) should carry a consistent
 * baseline of issue-tracker (`.beads/`) and board (`.automaker/`) config so
 * agent runs behave the same everywhere and drift is catchable in CI.
 *
 * This module is pure: callers build a `WorkspaceManifest` (which files exist,
 * what `.gitignore` contains) from a local checkout or the GitHub API, and
 * `evaluateStandard()` returns the violations. The thin CLI in
 * `bin/verify-workspace-config.mjs` does the I/O.
 *
 * See: protoLabsAI/release-tools — workspace-config-standard.md
 */

/**
 * @typedef {Object} WorkflowRunner
 * @property {string} file       — workflow filename (e.g. 'ci.yml')
 * @property {string} runsOn     — the literal `runs-on:` value (e.g. 'ubuntu-latest')
 * @property {boolean} [allowed] — sanctioned hosted-runner exception (annotated). Not flagged.
 * @property {string} [reason]   — the exception reason from the annotation.
 */

/**
 * @typedef {Object} WorkspaceManifest
 * @property {(path: string) => boolean} hasFile  — does a tracked/committed file exist at this path?
 * @property {string} gitignore                    — full root .gitignore contents ('' if none)
 * @property {(path: string) => boolean} [isIgnored] — authoritative ignore check (git check-ignore).
 *   When present it's the source of truth; absent → fall back to root-.gitignore substring matching.
 * @property {WorkflowRunner[]} [workflowRunners]  — every `runs-on:` value across .github/workflows/
 */

/**
 * GitHub-hosted runner labels. We want every workflow on an org-owned runner
 * (namespace-profile-protolabs-linux) so we stop burning GitHub Actions
 * minutes. Anything matching this prefix is a hosted runner.
 */
const GITHUB_HOSTED_RUNNER_PATTERN = /^(ubuntu|windows|macos)-/i;

/** Whether a `runs-on:` label is a GitHub-hosted runner (vs self-hosted/namespace). */
export function isGitHubHostedRunner(label) {
  if (!label) return false;
  const v = String(label).trim();
  // Expression-based runs-on (matrix, vars) — can't statically resolve; not flagged here.
  if (v.includes('${{')) return false;
  return GITHUB_HOSTED_RUNNER_PATTERN.test(v);
}

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} description
 * @property {'error'|'warn'} severity
 * @property {(m: WorkspaceManifest) => boolean} ok  — true when the rule is satisfied
 * @property {string} fix                            — one-line remediation hint
 */

/** Returns true if any non-comment .gitignore line matches one of `patterns` (substring). */
export function gitignoreMatches(gitignore, patterns) {
  const lines = (gitignore || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return patterns.some((p) => lines.some((l) => l.includes(p)));
}

/**
 * Is `path` git-ignored? Prefers the manifest's authoritative resolver
 * (`isIgnored`, backed by `git check-ignore` in local mode), falling back to
 * substring-matching the root .gitignore for manifests that don't provide one
 * (remote/fleet-audit mode, hand-built test manifests).
 *
 * The fallback is intentionally narrow: it can't see the allowlist `*` form, a
 * nested `.beads/.gitignore`, or global excludes — which is exactly why local
 * mode asks git instead. See #32.
 *
 * @param {WorkspaceManifest} manifest
 * @param {string} path                — repo-relative path to test
 * @param {string[]} fallbackPatterns  — substrings to grep when no `isIgnored`
 */
export function resolveIgnored(manifest, path, fallbackPatterns) {
  if (typeof manifest.isIgnored === 'function') return manifest.isIgnored(path);
  return gitignoreMatches(manifest.gitignore, fallbackPatterns);
}

/** Canonical path for the fleet workflow security lint. */
export const WORKFLOW_SECURITY_LINT_PATH = '.github/workflows/workflow-security-lint.yml';

/**
 * Scaffold content for the workflow security lint: a thin caller of the
 * canonical reusable workflow in release-tools, so zizmor/actionlint versions
 * stay centralized (bump once, every repo follows) instead of drifting per-repo.
 */
export const WORKFLOW_SECURITY_LINT_CONTENT = `# Fleet workflow security lint — calls the canonical reusable workflow in
# protoLabsAI/release-tools (zizmor + actionlint). Versions are centralized
# there; this caller stays tiny. \`verify-workspace-config\` requires this file.
name: Workflow Security Lint

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  security-lint:
    uses: protoLabsAI/release-tools/.github/workflows/workflow-security-lint.yml@main
`;

/**
 * The standard. Ordered; errors gate CI, warns are advisory.
 */
export const WORKSPACE_STANDARD = /** @type {Rule[]} */ ([
  {
    id: 'beads-issues-jsonl',
    description: '.beads/issues.jsonl is committed (git-friendly issue export)',
    severity: 'error',
    ok: (m) => m.hasFile('.beads/issues.jsonl'),
    fix: 'Run `br init` (or `br sync`) and commit .beads/issues.jsonl',
  },
  {
    id: 'beads-db-gitignored',
    description: '.beads/beads.db is gitignored (rebuildable SQLite, must not be committed)',
    severity: 'error',
    // Ask git (via the manifest's isIgnored) so the allowlist `*` form and a
    // nested .beads/.gitignore are honored, not just literal root-.gitignore
    // lines. Falls back to substring matching when no resolver is supplied. #32.
    ok: (m) => resolveIgnored(m, '.beads/beads.db', ['.beads/beads.db', '.beads/*.db', '.beads/']),
    fix: 'Add `.beads/beads.db` to .gitignore',
  },
  {
    id: 'beads-db-not-committed',
    description: '.beads/beads.db is NOT committed',
    severity: 'error',
    ok: (m) => !m.hasFile('.beads/beads.db'),
    fix: 'git rm --cached .beads/beads.db and add it to .gitignore',
  },
  {
    id: 'automaker-settings-committed',
    description: '.automaker/settings.json is committed (versioned per-repo agent baseline)',
    severity: 'error',
    ok: (m) => m.hasFile('.automaker/settings.json'),
    fix: 'Commit .automaker/settings.json with the gateway model tiers (protolabs/fast|smart|reasoning) and workflow defaults',
  },
  {
    id: 'worktrees-gitignored',
    description: '.worktrees/ is gitignored (agent worktrees must never be committed)',
    severity: 'error',
    ok: (m) => gitignoreMatches(m.gitignore, ['.worktrees/', '.worktrees']),
    fix: 'Add `.worktrees/` to .gitignore',
  },
  {
    id: 'automaker-transient-gitignored',
    description:
      '.automaker transient dirs (features, checkpoints, images) are gitignored while settings/context stay committed',
    severity: 'warn',
    ok: (m) =>
      gitignoreMatches(m.gitignore, [
        '.automaker/features',
        '.automaker/checkpoints',
        '.automaker/trajectory',
      ]),
    fix: 'Add `.automaker/features/`, `.automaker/checkpoints/`, `.automaker/trajectory/` to .gitignore (keep settings.json + context/ committed)',
  },
  {
    id: 'workflows-use-owned-runners',
    description:
      'GitHub Actions workflows run on org-owned runners (namespace-profile-protolabs-linux), not GitHub-hosted',
    severity: 'error',
    // A hosted runner is only a violation when it is NOT an annotated exception.
    // Annotate with `# workspace-config: allow-hosted-runner <reason>` on or
    // above the runs-on line for legit cases (cross-platform builds, npm
    // provenance). Exceptions still surface in --json via listRunnerExceptions.
    ok: (m) => !(m.workflowRunners ?? []).some((w) => isGitHubHostedRunner(w.runsOn) && !w.allowed),
    fix: 'Change `runs-on:` to `namespace-profile-protolabs-linux`, or annotate a legit hosted runner with `# workspace-config: allow-hosted-runner <reason>`',
    detail: (m) =>
      (m.workflowRunners ?? [])
        .filter((w) => isGitHubHostedRunner(w.runsOn) && !w.allowed)
        .map((w) => `${w.file}: runs-on ${w.runsOn}`),
  },
  {
    id: 'workflow-security-lint',
    description:
      'A workflow security lint (zizmor + actionlint) runs in CI — catches CWE-94 script injection, unpinned actions, and token over-privilege',
    // warn (not error) so adoption can roll out across the fleet without breaking
    // CI on day one. Tighten to error once every managed repo has adopted it.
    severity: 'warn',
    ok: (m) => m.hasFile(WORKFLOW_SECURITY_LINT_PATH),
    fix: `Add ${WORKFLOW_SECURITY_LINT_PATH} (run \`init-workspace-config\`, or call the reusable workflow: \`uses: protoLabsAI/release-tools/.github/workflows/workflow-security-lint.yml@main\`)`,
  },
]);

/**
 * Annotated hosted-runner exceptions, for transparency in audit output. These
 * pass the rule but should remain visible — a sanctioned exception is not the
 * same as conformance.
 *
 * @param {WorkspaceManifest} manifest
 * @returns {{ file: string, runsOn: string, reason: string }[]}
 */
export function listRunnerExceptions(manifest) {
  return (manifest.workflowRunners ?? [])
    .filter((w) => isGitHubHostedRunner(w.runsOn) && w.allowed)
    .map((w) => ({ file: w.file, runsOn: w.runsOn, reason: w.reason ?? '' }));
}

/**
 * @typedef {Object} Violation
 * @property {string} id
 * @property {string} description
 * @property {'error'|'warn'} severity
 * @property {string} fix
 */

/**
 * Evaluate a manifest against the standard.
 *
 * @param {WorkspaceManifest} manifest
 * @param {{ standard?: Rule[] }} [opts]
 * @returns {{ violations: Violation[], passed: string[], errorCount: number, warnCount: number, ok: boolean }}
 */
export function evaluateStandard(manifest, opts = {}) {
  const standard = opts.standard ?? WORKSPACE_STANDARD;
  const violations = [];
  const passed = [];
  for (const rule of standard) {
    if (rule.ok(manifest)) {
      passed.push(rule.id);
    } else {
      const detail = typeof rule.detail === 'function' ? rule.detail(manifest) : undefined;
      violations.push({
        id: rule.id,
        description: rule.description,
        severity: rule.severity,
        fix: rule.fix,
        ...(detail?.length ? { detail } : {}),
      });
    }
  }
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warnCount = violations.filter((v) => v.severity === 'warn').length;
  return { violations, passed, errorCount, warnCount, ok: errorCount === 0 };
}

// ─── Scaffolding ─────────────────────────────────────────────────────────────

/**
 * Files the scaffolder creates when missing. Minimal-but-valid:
 *   - .beads/issues.jsonl: empty export (no issues yet); `br` appends on first use.
 *   - .automaker/settings.json: { version: 1 } — matches DEFAULT_PROJECT_SETTINGS.
 *     Teams layer workflow/model overrides on top; the standard only requires
 *     the committed baseline exists.
 */
export const SCAFFOLD_FILES = [
  { path: '.beads/issues.jsonl', content: '' },
  { path: '.automaker/settings.json', content: `${JSON.stringify({ version: 1 }, null, 2)}\n` },
  { path: WORKFLOW_SECURITY_LINT_PATH, content: WORKFLOW_SECURITY_LINT_CONTENT },
];

/** .gitignore lines the standard requires. Added if not already matched. */
export const REQUIRED_GITIGNORE = [
  '.beads/beads.db',
  '.worktrees/',
  '.automaker/features/',
  '.automaker/checkpoints/',
  '.automaker/trajectory/',
];

/**
 * Compute the file creates + .gitignore additions needed to bring a workspace
 * to standard. Pure — the CLI performs the writes. Does NOT touch
 * .github/workflows runners (that's a per-workflow code edit, flag-only).
 *
 * @param {WorkspaceManifest} manifest
 * @returns {{ create: {path:string,content:string}[], gitignoreAdditions: string[] }}
 */
export function planScaffold(manifest) {
  const create = SCAFFOLD_FILES.filter((f) => !manifest.hasFile(f.path));

  // Blanket ignores that shadow files the standard requires committed. Left by
  // the old onboard skill (`.automaker/`) and naive setups (`.beads/`). They
  // must be narrowed to the transient-only ignores or settings.json /
  // issues.jsonl can't be tracked. Exact-line match so we never remove a
  // legit selective line like `.automaker/features/`. See #21.
  const blanketIgnores = ['.automaker', '.automaker/', '.beads', '.beads/'];
  const existingLines = new Set(
    (manifest.gitignore || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const gitignoreRemovals = blanketIgnores.filter((b) => existingLines.has(b));

  // After narrowing, recompute which required lines are still missing. A
  // blanket line being removed means its coverage is gone, so the required
  // selective lines must be (re)added.
  const gitignoreAdditions = REQUIRED_GITIGNORE.filter((line) => {
    // Treat a to-be-removed blanket as no longer matching.
    if (gitignoreRemovals.length > 0) return !existingLines.has(line);
    return !gitignoreMatches(manifest.gitignore, [line]);
  });

  return { create, gitignoreAdditions, gitignoreRemovals };
}
