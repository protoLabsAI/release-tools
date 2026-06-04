import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'rewrite-release-notes.mjs');

/** Spin up a throwaway git repo with `commits` commits and the given tags. */
function makeRepo(commits, tags) {
  const dir = mkdtempSync(join(tmpdir(), 'reltools-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@protolabs.studio');
  git('config', 'user.name', 'Test');
  for (let i = 0; i < commits; i++) git('commit', '-q', '--allow-empty', '-m', `feat: change ${i}`);
  for (const t of tags) git('tag', t);
  return dir;
}

/** Run the CLI in `dir` with `--dry-run` (exits before any LLM/Discord call). */
function runDryRun(dir, args = []) {
  return spawnSync('node', [CLI, ...args, '--dry-run'], { cwd: dir, encoding: 'utf8' });
}

test('first release (single tag) diffs from the root commit instead of erroring', () => {
  const dir = makeRepo(3, ['v0.1.0']);
  try {
    const r = runDryRun(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Could not determine version tags/);
    assert.match(r.stdout, /first release; diffing from root commit [0-9a-f]{7,}/);
    assert.match(r.stdout, /── User Prompt ──/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with a prior tag, the previous version resolves normally (no root fallback)', () => {
  const dir = makeRepo(3, ['v0.1.0']);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('commit', '-q', '--allow-empty', '-m', 'feat: more');
  git('tag', 'v0.2.0');
  try {
    const r = runDryRun(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /first release/);
    assert.match(r.stdout, /Generating release notes: v0\.1\.0 → v0\.2\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no version at all still errors clearly', () => {
  const dir = makeRepo(1, []); // no tags
  try {
    const r = runDryRun(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not determine the release version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
