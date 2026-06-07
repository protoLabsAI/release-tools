import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── Notes reuse + changelog/outputs ───────────────────────────────────────────
// --notes-file supplies notes directly, so these exercise the output/changelog
// paths with no git range and no gateway key.

const FIXTURE =
  'Sharpens the first-run flow.\n\n**Setup**\n- remembers you are set up\n- downloads voice models with progress\n';

/** A plain (non-git) temp dir — the --notes-file path needs no git range. */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'reltools-'));
}

test('--notes-file + --out writes the notes to a file, no gateway key', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const r = spawnSync(
      'node',
      [CLI, 'v1.2.3', '--notes-file', join(dir, 'notes.md'), '--out', join(dir, 'out.md')],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GATEWAY_API_KEY: '' } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      readFileSync(join(dir, 'out.md'), 'utf8'),
      /downloads voice models with progress/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changelog json prepends a structured entry with extracted highlights', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const cl = join(dir, 'changelog.json');
    const r = spawnSync(
      'node',
      [CLI, 'v2.0.0', '--notes-file', join(dir, 'notes.md'), '--changelog', cl, '--changelog-format', 'json', '--date', '2026-01-02'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const entries = JSON.parse(readFileSync(cl, 'utf8'));
    assert.equal(entries[0].version, 'v2.0.0');
    assert.equal(entries[0].date, '2026-01-02');
    assert.deepEqual(entries[0].highlights, [
      'remembers you are set up',
      'downloads voice models with progress',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changelog json is newest-first and replaces a re-run of the same version', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const cl = join(dir, 'changelog.json');
    writeFileSync(
      cl,
      JSON.stringify([{ version: 'v1.0.0', date: '2025-01-01', highlights: ['old'] }], null, 2),
    );
    const run = (v) =>
      spawnSync('node', [CLI, v, '--notes-file', join(dir, 'notes.md'), '--changelog', cl, '--changelog-format', 'json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run('v2.0.0').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(cl, 'utf8')).map((e) => e.version), ['v2.0.0', 'v1.0.0']);
    // Re-running the same version replaces it rather than duplicating.
    assert.equal(run('v2.0.0').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(cl, 'utf8')).map((e) => e.version), ['v2.0.0', 'v1.0.0']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changelog md prepends a dated section under the # title', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const cl = join(dir, 'CHANGELOG.md');
    writeFileSync(cl, '# Changelog\n\n## v1.0.0 — 2025-01-01\n\nOld stuff.\n');
    const r = spawnSync('node', [CLI, 'v2.0.0', '--notes-file', join(dir, 'notes.md'), '--changelog', cl, '--date', '2026-01-02'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(cl, 'utf8');
    assert.match(md, /^# Changelog/);
    assert.ok(md.indexOf('## v2.0.0 — 2026-01-02') < md.indexOf('## v1.0.0'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exposes notes + highlights on $GITHUB_OUTPUT', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const ghOut = join(dir, 'gh_output');
    writeFileSync(ghOut, '');
    const r = spawnSync('node', [CLI, 'v3.0.0', '--notes-file', join(dir, 'notes.md')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: ghOut },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(ghOut, 'utf8');
    assert.match(out, /notes<<RELNOTES_EOF/);
    assert.match(out, /highlights=\[/);
    assert.match(out, /downloads voice models with progress/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
