import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_STANDARD,
  evaluateStandard,
  gitignoreMatches,
  resolveIgnored,
  isGitHubHostedRunner,
  listRunnerExceptions,
  planScaffold,
  SCAFFOLD_FILES,
  REQUIRED_GITIGNORE,
  WORKFLOW_SECURITY_LINT_PATH,
} from '../lib/workspace-config.mjs';

/** Build a manifest from a list of present files + gitignore text. */
function manifest(files, gitignore = '') {
  const set = new Set(files);
  return { hasFile: (p) => set.has(p), gitignore };
}

/** A fully-conformant workspace. */
function goodManifest() {
  return manifest(
    ['.beads/issues.jsonl', '.automaker/settings.json', WORKFLOW_SECURITY_LINT_PATH],
    [
      '.beads/beads.db',
      '.worktrees/',
      '.automaker/features/',
      '.automaker/checkpoints/',
      '.automaker/trajectory/',
    ].join('\n')
  );
}

test('gitignoreMatches ignores comments and blank lines', () => {
  const gi = '# a comment\n\n.worktrees/\n';
  assert.equal(gitignoreMatches(gi, ['.worktrees/']), true);
  assert.equal(gitignoreMatches('# .worktrees/', ['.worktrees/']), false); // commented out
  assert.equal(gitignoreMatches('', ['.worktrees/']), false);
});

// ── ignore resolution: isIgnored resolver vs .gitignore fallback (#32) ─────

test('resolveIgnored prefers the manifest resolver over .gitignore text', () => {
  // Resolver says ignored even though the .gitignore text has no matching line.
  assert.equal(resolveIgnored({ isIgnored: () => true, gitignore: '' }, '.beads/beads.db', ['.beads/beads.db']), true);
  // Resolver is authoritative: says NOT ignored even though the text would match.
  assert.equal(
    resolveIgnored({ isIgnored: () => false, gitignore: '.beads/beads.db' }, '.beads/beads.db', ['.beads/beads.db']),
    false
  );
});

test('resolveIgnored falls back to .gitignore substring match when no resolver', () => {
  assert.equal(resolveIgnored({ gitignore: '.beads/beads.db\n' }, '.beads/beads.db', ['.beads/beads.db']), true);
  assert.equal(resolveIgnored({ gitignore: '.worktrees/\n' }, '.beads/beads.db', ['.beads/beads.db']), false);
});

test('beads-db-gitignored passes on the allowlist form via the isIgnored resolver', () => {
  // The documented allowlist .beads/.gitignore — `*` ignores beads.db, but it
  // contains none of the legacy literal substrings. git (isIgnored) honors it.
  const m = {
    hasFile: (p) => ['.beads/issues.jsonl', '.automaker/settings.json', WORKFLOW_SECURITY_LINT_PATH].includes(p),
    gitignore: '.worktrees/\n.automaker/features/\n.automaker/checkpoints/\n.automaker/trajectory/',
    isIgnored: (p) => p === '.beads/beads.db', // git check-ignore would say yes
  };
  const r = evaluateStandard(m);
  assert.ok(r.passed.includes('beads-db-gitignored'), 'allowlist form should satisfy the rule');
  assert.equal(r.violations.some((v) => v.id === 'beads-db-gitignored'), false);
});

test('beads-db-gitignored still fails when git reports the db is NOT ignored', () => {
  const m = {
    hasFile: (p) => ['.beads/issues.jsonl', '.automaker/settings.json'].includes(p),
    gitignore: '.beads/beads.db', // text looks fine, but git is the source of truth
    isIgnored: () => false,
  };
  const r = evaluateStandard(m);
  assert.ok(r.violations.some((v) => v.id === 'beads-db-gitignored' && v.severity === 'error'));
});

test('a fully-conformant workspace passes with zero violations', () => {
  const r = evaluateStandard(goodManifest());
  assert.equal(r.ok, true);
  assert.equal(r.errorCount, 0);
  assert.equal(r.warnCount, 0);
  assert.equal(r.violations.length, 0);
  assert.equal(r.passed.length, WORKSPACE_STANDARD.length);
});

test('missing .beads/issues.jsonl is an error', () => {
  const m = manifest(['.automaker/settings.json'], '.beads/beads.db\n.worktrees/');
  const r = evaluateStandard(m);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.id === 'beads-issues-jsonl' && v.severity === 'error'));
});

test('missing .automaker/settings.json is an error (committed baseline required)', () => {
  const m = manifest(['.beads/issues.jsonl'], '.beads/beads.db\n.worktrees/');
  const r = evaluateStandard(m);
  assert.equal(r.ok, false);
  assert.ok(
    r.violations.some((v) => v.id === 'automaker-settings-committed' && v.severity === 'error')
  );
});

test('beads.db not gitignored is an error', () => {
  const m = manifest(['.beads/issues.jsonl', '.automaker/settings.json'], '.worktrees/');
  const r = evaluateStandard(m);
  assert.ok(r.violations.some((v) => v.id === 'beads-db-gitignored'));
});

test('beads.db committed is an error even if also gitignored', () => {
  const m = manifest(
    ['.beads/issues.jsonl', '.automaker/settings.json', '.beads/beads.db'],
    '.beads/beads.db\n.worktrees/\n.automaker/features/\n.automaker/checkpoints/\n.automaker/trajectory/'
  );
  const r = evaluateStandard(m);
  assert.ok(r.violations.some((v) => v.id === 'beads-db-not-committed' && v.severity === 'error'));
});

test('.worktrees not gitignored is an error', () => {
  const m = manifest(['.beads/issues.jsonl', '.automaker/settings.json'], '.beads/beads.db');
  const r = evaluateStandard(m);
  assert.ok(r.violations.some((v) => v.id === 'worktrees-gitignored'));
});

test('missing automaker transient ignores is a WARN, not an error', () => {
  // Everything required present + ignored, but no transient-dir ignores.
  const m = manifest(
    ['.beads/issues.jsonl', '.automaker/settings.json'],
    '.beads/beads.db\n.worktrees/'
  );
  const r = evaluateStandard(m);
  assert.equal(r.ok, true, 'warn-only violation should not fail the standard');
  assert.equal(r.errorCount, 0);
  // two warns: missing transient ignores + missing workflow-security-lint
  assert.equal(r.warnCount, 2);
  assert.ok(
    r.violations.some((v) => v.id === 'automaker-transient-gitignored' && v.severity === 'warn')
  );
  assert.ok(
    r.violations.some((v) => v.id === 'workflow-security-lint' && v.severity === 'warn')
  );
});

test('a bare repo (nothing) reports all errors + the warn', () => {
  const r = evaluateStandard(manifest([], ''));
  // 4 errors: issues.jsonl, beads-db-gitignored, automaker-settings, worktrees
  // (beads-db-not-committed passes — it's absent — so it is NOT a violation)
  assert.equal(r.errorCount, 4);
  // 2 warns: automaker-transient-gitignored + workflow-security-lint
  assert.equal(r.warnCount, 2);
  assert.equal(r.ok, false);
  assert.ok(r.passed.includes('beads-db-not-committed'));
});

test('each rule carries a fix hint', () => {
  for (const rule of WORKSPACE_STANDARD) {
    assert.ok(typeof rule.fix === 'string' && rule.fix.length > 0, `${rule.id} missing fix`);
    assert.ok(['error', 'warn'].includes(rule.severity), `${rule.id} bad severity`);
  }
});

// ── self-hosted runner rule ──────────────────────────────────────────────

test('isGitHubHostedRunner flags hosted labels, allows owned/self-hosted', () => {
  for (const hosted of ['ubuntu-latest', 'ubuntu-24.04', 'windows-latest', 'macos-14', 'macOS-latest']) {
    assert.equal(isGitHubHostedRunner(hosted), true, `${hosted} should be hosted`);
  }
  for (const owned of ['namespace-profile-protolabs-linux', 'self-hosted', 'protolabs-arm']) {
    assert.equal(isGitHubHostedRunner(owned), false, `${owned} should NOT be hosted`);
  }
});

test('isGitHubHostedRunner does not flag expression-based runs-on', () => {
  assert.equal(isGitHubHostedRunner('${{ matrix.os }}'), false);
  assert.equal(isGitHubHostedRunner('${{ vars.RUNNER }}'), false);
});

test('a workflow on a GitHub-hosted runner is an error, with offending files in detail', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'ubuntu-latest' },
      { file: 'release.yml', runsOn: 'namespace-profile-protolabs-linux' },
    ],
  };
  const r = evaluateStandard(m);
  const v = r.violations.find((x) => x.id === 'workflows-use-owned-runners');
  assert.ok(v, 'expected runner violation');
  assert.equal(v.severity, 'error');
  assert.deepEqual(v.detail, ['ci.yml: runs-on ubuntu-latest']);
});

test('all workflows on owned runners → no runner violation', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'namespace-profile-protolabs-linux' },
      { file: 'release.yml', runsOn: 'namespace-profile-protolabs-linux' },
    ],
  };
  const r = evaluateStandard(m);
  assert.equal(r.violations.some((x) => x.id === 'workflows-use-owned-runners'), false);
  assert.equal(r.ok, true);
});

test('no workflows at all → runner rule passes (nothing to flag)', () => {
  const r = evaluateStandard(goodManifest()); // no workflowRunners field
  assert.equal(r.violations.some((x) => x.id === 'workflows-use-owned-runners'), false);
});

test('missing workflow-security-lint is a warn (not an error)', () => {
  // good manifest minus the security-lint workflow
  const m = manifest(
    ['.beads/issues.jsonl', '.automaker/settings.json'],
    ['.beads/beads.db', '.worktrees/', '.automaker/features/'].join('\n')
  );
  const r = evaluateStandard(m);
  const v = r.violations.find((x) => x.id === 'workflow-security-lint');
  assert.ok(v, 'expected a workflow-security-lint violation');
  assert.equal(v.severity, 'warn');
  // a warn alone does not fail the gate
  assert.equal(r.violations.filter((x) => x.severity === 'error' && x.id === 'workflow-security-lint').length, 0);
});

test('present workflow-security-lint satisfies the rule', () => {
  const r = evaluateStandard(goodManifest());
  assert.ok(r.passed.includes('workflow-security-lint'));
});

// ── scaffolder (planScaffold) ────────────────────────────────────────────

test('planScaffold on a bare repo creates all files + all gitignore lines', () => {
  const m = { hasFile: () => false, gitignore: '' };
  const plan = planScaffold(m);
  assert.equal(plan.create.length, SCAFFOLD_FILES.length);
  assert.deepEqual(plan.create.map((f) => f.path).sort(), [
    '.automaker/settings.json',
    '.beads/issues.jsonl',
    WORKFLOW_SECURITY_LINT_PATH,
  ]);
  assert.deepEqual(plan.gitignoreAdditions, REQUIRED_GITIGNORE);
});

test('planScaffold is idempotent — fully-scaffolded repo needs nothing', () => {
  const present = new Set(SCAFFOLD_FILES.map((f) => f.path));
  const m = {
    hasFile: (p) => present.has(p),
    gitignore: REQUIRED_GITIGNORE.join('\n'),
  };
  const plan = planScaffold(m);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.gitignoreAdditions.length, 0);
});

test('planScaffold only fills gaps — partial repo', () => {
  // Has settings.json + ignores beads.db, but missing issues.jsonl + worktrees ignore.
  const m = {
    hasFile: (p) => p === '.automaker/settings.json',
    gitignore: '.beads/beads.db\n',
  };
  const plan = planScaffold(m);
  assert.deepEqual(
    plan.create.map((f) => f.path),
    ['.beads/issues.jsonl', WORKFLOW_SECURITY_LINT_PATH]
  );
  assert.ok(plan.gitignoreAdditions.includes('.worktrees/'));
  assert.ok(!plan.gitignoreAdditions.includes('.beads/beads.db')); // already present
});

test('scaffolded .automaker/settings.json is valid JSON with version 1', () => {
  const settings = SCAFFOLD_FILES.find((f) => f.path === '.automaker/settings.json');
  const parsed = JSON.parse(settings.content);
  assert.equal(parsed.version, 1);
});

test('scaffold output makes a bare repo pass evaluateStandard (sans runner rule)', () => {
  // Simulate applying the scaffold to a bare repo, then re-evaluate.
  const created = new Set(SCAFFOLD_FILES.map((f) => f.path));
  const m = {
    hasFile: (p) => created.has(p),
    gitignore: REQUIRED_GITIGNORE.join('\n'),
    // no workflows → runner rule passes
  };
  const r = evaluateStandard(m);
  assert.equal(r.ok, true);
  assert.equal(r.errorCount, 0);
});

// ── runner exception annotation ──────────────────────────────────────────

test('annotated hosted runner is allowed (not a violation) and surfaced as exception', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'namespace-profile-protolabs-linux' },
      {
        file: 'tauri-release.yml',
        runsOn: 'macos-14',
        allowed: true,
        reason: 'cross-platform build',
      },
    ],
  };
  const r = evaluateStandard(m);
  assert.equal(r.violations.some((x) => x.id === 'workflows-use-owned-runners'), false);
  assert.equal(r.ok, true);
  const exc = listRunnerExceptions(m);
  assert.equal(exc.length, 1);
  assert.deepEqual(exc[0], { file: 'tauri-release.yml', runsOn: 'macos-14', reason: 'cross-platform build' });
});

test('unannotated hosted runner is still a violation even when another is annotated', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'ubuntu-latest' }, // not annotated → error
      { file: 'tauri.yml', runsOn: 'macos-14', allowed: true, reason: 'mac build' },
    ],
  };
  const r = evaluateStandard(m);
  const v = r.violations.find((x) => x.id === 'workflows-use-owned-runners');
  assert.ok(v);
  assert.deepEqual(v.detail, ['ci.yml: runs-on ubuntu-latest']); // only the unannotated one
});

test('listRunnerExceptions returns [] when no annotated hosted runners', () => {
  assert.deepEqual(listRunnerExceptions(goodManifest()), []);
});

// ── planScaffold narrows blanket ignores (#21) ───────────────────────────

test('planScaffold flags a blanket .automaker/ ignore for removal + re-adds selective', () => {
  const m = {
    hasFile: (p) => p === '.automaker/settings.json' || p === '.beads/issues.jsonl',
    gitignore: '.automaker/\n.worktrees/\n.beads/beads.db\n',
  };
  const plan = planScaffold(m);
  assert.deepEqual(plan.gitignoreRemovals, ['.automaker/']);
  // transient lines must be (re)added since the blanket coverage is going away
  assert.ok(plan.gitignoreAdditions.includes('.automaker/features/'));
});

test('planScaffold narrows a blanket .beads/ ignore too', () => {
  const m = {
    hasFile: (p) => p === '.automaker/settings.json' || p === '.beads/issues.jsonl',
    gitignore: '.beads/\n.worktrees/\n.automaker/features/\n.automaker/checkpoints/\n.automaker/trajectory/\n',
  };
  const plan = planScaffold(m);
  assert.ok(plan.gitignoreRemovals.includes('.beads/'));
  assert.ok(plan.gitignoreAdditions.includes('.beads/beads.db'));
});

test('planScaffold leaves selective .automaker/features/ alone (no false removal)', () => {
  const m = {
    hasFile: () => true,
    gitignore: REQUIRED_GITIGNORE.join('\n'),
  };
  const plan = planScaffold(m);
  assert.deepEqual(plan.gitignoreRemovals, []);
  assert.deepEqual(plan.gitignoreAdditions, []);
});
