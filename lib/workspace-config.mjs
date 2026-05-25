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
 * @property {string} file     — workflow filename (e.g. 'ci.yml')
 * @property {string} runsOn   — the literal `runs-on:` value (e.g. 'ubuntu-latest')
 */

/**
 * @typedef {Object} WorkspaceManifest
 * @property {(path: string) => boolean} hasFile  — does a tracked/committed file exist at this path?
 * @property {string} gitignore                    — full .gitignore contents ('' if none)
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
    ok: (m) => gitignoreMatches(m.gitignore, ['.beads/beads.db', '.beads/*.db', '.beads/']),
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
    ok: (m) => !(m.workflowRunners ?? []).some((w) => isGitHubHostedRunner(w.runsOn)),
    fix: 'Change `runs-on:` from ubuntu/windows/macos-* to `namespace-profile-protolabs-linux` in the flagged workflows',
    detail: (m) =>
      (m.workflowRunners ?? [])
        .filter((w) => isGitHubHostedRunner(w.runsOn))
        .map((w) => `${w.file}: runs-on ${w.runsOn}`),
  },
]);

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
        ...(detail && detail.length ? { detail } : {}),
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
  { path: '.automaker/settings.json', content: JSON.stringify({ version: 1 }, null, 2) + '\n' },
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
  const gitignoreAdditions = REQUIRED_GITIGNORE.filter(
    (line) => !gitignoreMatches(manifest.gitignore, [line])
  );
  return { create, gitignoreAdditions };
}
