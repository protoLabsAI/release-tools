import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_STANDARD,
  evaluateStandard,
  gitignoreMatches,
  resolveIgnored,
  isGitHubHostedRunner,
  isNamespaceRunner,
  listRunnerExceptions,
  planScaffold,
  SCAFFOLD_FILES,
  REQUIRED_GITIGNORE,
  WORKFLOW_SECURITY_LINT_PATH,
  FLEET_BIOME_VERSION,
  cleanVersion,
  biomeVersion,
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
      '.automaker-lock',
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
    '.beads/beads.db\n.worktrees/\n.automaker-lock'
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
  // 5 errors: issues.jsonl, beads-db-gitignored, automaker-settings, worktrees,
  // automaker-lock-gitignored. (beads-db-not-committed AND automaker-lock-not-committed
  // pass — both absent — so they are NOT violations.)
  assert.equal(r.errorCount, 5);
  // 2 warns: automaker-transient-gitignored + workflow-security-lint
  assert.equal(r.warnCount, 2);
  assert.equal(r.ok, false);
  assert.ok(r.passed.includes('beads-db-not-committed'));
  assert.ok(r.passed.includes('automaker-lock-not-committed'));
});

test('each rule carries a fix hint', () => {
  for (const rule of WORKSPACE_STANDARD) {
    assert.ok(typeof rule.fix === 'string' && rule.fix.length > 0, `${rule.id} missing fix`);
    assert.ok(['error', 'warn'].includes(rule.severity), `${rule.id} bad severity`);
  }
});

// ── runner rule: GitHub-hosted is the standard, Namespace is retired ────

test('isGitHubHostedRunner recognises hosted labels', () => {
  for (const hosted of ['ubuntu-latest', 'ubuntu-24.04', 'windows-latest', 'macos-14', 'macOS-latest']) {
    assert.equal(isGitHubHostedRunner(hosted), true, `${hosted} should be hosted`);
  }
  for (const other of ['namespace-profile-protolabs-linux', 'self-hosted', '${{ matrix.os }}']) {
    assert.equal(isGitHubHostedRunner(other), false, `${other} should NOT be hosted`);
  }
});

test('isNamespaceRunner flags namespace labels and NSC_RUNNER expressions', () => {
  for (const ns of [
    'namespace-profile-protolabs-linux',
    'nscloud-ubuntu-22.04-amd64-4x16',
    "${{ vars.NSC_RUNNER || 'namespace-profile-protolabs-linux' }}",
    "${{ inputs.runner || vars.NSC_RUNNER || 'ubuntu-latest' }}",
    '${{ vars.NSC_RUNNER }}',
  ]) {
    assert.equal(isNamespaceRunner(ns), true, `${ns} should be Namespace`);
  }
  for (const ok of ['ubuntu-latest', 'macos-14', 'windows-latest', '${{ matrix.os }}', "${{ inputs.runner || 'ubuntu-latest' }}"]) {
    assert.equal(isNamespaceRunner(ok), false, `${ok} should NOT be Namespace`);
  }
});

test('a workflow on a Namespace runner is an error, with offending files in detail', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'ubuntu-latest' },
      { file: 'release.yml', runsOn: 'namespace-profile-protolabs-linux' },
      { file: 'lint.yml', runsOn: "${{ vars.NSC_RUNNER || 'namespace-profile-protolabs-linux' }}" },
    ],
  };
  const r = evaluateStandard(m);
  const v = r.violations.find((x) => x.id === 'workflows-use-github-hosted-runners');
  assert.ok(v, 'expected runner violation');
  assert.equal(v.severity, 'error');
  assert.match(v.fix, /ubuntu-latest/);
  assert.deepEqual(v.detail, [
    'release.yml: runs-on namespace-profile-protolabs-linux',
    "lint.yml: runs-on ${{ vars.NSC_RUNNER || 'namespace-profile-protolabs-linux' }}",
  ]);
});

test('all workflows on GitHub-hosted runners → no runner violation', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [
      { file: 'ci.yml', runsOn: 'ubuntu-latest' },
      { file: 'tauri.yml', runsOn: '${{ matrix.os }}' },
      { file: 'mac.yml', runsOn: 'macos-14' },
    ],
  };
  const r = evaluateStandard(m);
  assert.equal(r.violations.some((x) => x.id === 'workflows-use-github-hosted-runners'), false);
  assert.equal(r.ok, true);
});

test('the old owned-runners rule is gone', () => {
  assert.equal(WORKSPACE_STANDARD.some((x) => x.id === 'workflows-use-owned-runners'), false);
  assert.ok(WORKSPACE_STANDARD.some((x) => x.id === 'workflows-use-github-hosted-runners'));
});

test('no workflows at all → runner rule passes (nothing to flag)', () => {
  const r = evaluateStandard(goodManifest()); // no workflowRunners field
  assert.equal(r.violations.some((x) => x.id === 'workflows-use-github-hosted-runners'), false);
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

// ── retired hosted-runner annotation ─────────────────────────────────────

test('listRunnerExceptions is deprecated and always empty', () => {
  const m = {
    ...goodManifest(),
    workflowRunners: [{ file: 'tauri.yml', runsOn: 'macos-14' }],
  };
  assert.deepEqual(listRunnerExceptions(m), []);
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

// ── biome-linter (fleet biome version tracking) ──────────────────────────────

/** Build a manifest for a node repo with a given biome dep + biome.json presence. */
function nodeManifest({ biomeDep, hasBiomeJson = true, dev = true } = {}) {
  const files = new Set(hasBiomeJson ? ['biome.json'] : []);
  const deps = biomeDep ? { '@biomejs/biome': biomeDep } : {};
  return {
    hasFile: (p) => files.has(p),
    gitignore: '',
    packageJson: { [dev ? 'devDependencies' : 'dependencies']: deps },
  };
}

const biomeViolation = (m) =>
  evaluateStandard(m).violations.find((v) => v.id === 'biome-linter');

test('cleanVersion strips semver range prefixes', () => {
  assert.equal(cleanVersion('2.4.16'), '2.4.16');
  assert.equal(cleanVersion('^2.4.16'), '2.4.16');
  assert.equal(cleanVersion('~2.4.16'), '2.4.16');
  assert.equal(cleanVersion('>=2.4.16'), '2.4.16');
  assert.equal(cleanVersion(' 2.4.16 '), '2.4.16');
  assert.equal(cleanVersion(undefined), '');
});

test('biomeVersion reads devDependencies then dependencies, null when absent', () => {
  assert.equal(biomeVersion({ devDependencies: { '@biomejs/biome': '2.4.16' } }), '2.4.16');
  assert.equal(biomeVersion({ dependencies: { '@biomejs/biome': '^2.0.0' } }), '^2.0.0');
  assert.equal(biomeVersion({ devDependencies: { eslint: '^9' } }), null);
  assert.equal(biomeVersion(null), null);
});

test('biome-linter is N/A for non-node repos (no packageJson)', () => {
  // Python/Rust repos have no package.json → rule passes, no violation.
  const m = { hasFile: () => false, gitignore: '' };
  assert.equal(biomeViolation(m), undefined);
  assert.ok(evaluateStandard(m).passed.includes('biome-linter'));
});

test('biome-linter passes when a node repo is on the fleet biome version', () => {
  const m = nodeManifest({ biomeDep: FLEET_BIOME_VERSION });
  assert.equal(biomeViolation(m), undefined);
  // a caret range on the same version still matches (cleanVersion strips ^)
  assert.equal(biomeViolation(nodeManifest({ biomeDep: `^${FLEET_BIOME_VERSION}` })), undefined);
});

test('biome-linter warns (not errors) when a node repo has no biome dep', () => {
  // Otherwise-conformant repo on ESLint → only the biome-linter warn fires, and
  // a warn must not fail overall conformance.
  const m = { ...goodManifest(), packageJson: { devDependencies: { eslint: '^9' } } };
  const r = evaluateStandard(m);
  const v = r.violations.find((x) => x.id === 'biome-linter');
  assert.ok(v, 'expected a biome-linter violation');
  assert.equal(v.severity, 'warn');
  assert.match(v.detail.join(' '), /no @biomejs\/biome/);
  assert.equal(r.ok, true, 'warn-severity biome gap must not fail conformance');
});

test('biome-linter warns when biome is declared but no biome.json', () => {
  const v = biomeViolation(nodeManifest({ biomeDep: FLEET_BIOME_VERSION, hasBiomeJson: false }));
  assert.ok(v);
  assert.match(v.detail.join(' '), /no biome\.json/);
});

test('biome-linter warns on version drift from the fleet pin', () => {
  const v = biomeViolation(nodeManifest({ biomeDep: '2.3.0' }));
  assert.ok(v);
  assert.match(v.detail.join(' '), new RegExp(`fleet tracks ${FLEET_BIOME_VERSION.replace(/\./g, '\\.')}`));
});

test('biome.jsonc satisfies the config requirement too', () => {
  const m = {
    hasFile: (p) => p === 'biome.jsonc',
    gitignore: '',
    packageJson: { devDependencies: { '@biomejs/biome': FLEET_BIOME_VERSION } },
  };
  assert.equal(biomeViolation(m), undefined);
});
