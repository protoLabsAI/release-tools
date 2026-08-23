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

test('--changelog json warns loudly (not silently) when the existing file is malformed', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'notes.md'), FIXTURE);
    const cl = join(dir, 'changelog.json');
    writeFileSync(cl, '{ not valid json ['); // corrupt
    const r = spawnSync(
      'node',
      [CLI, 'v9.9.9', '--notes-file', join(dir, 'notes.md'), '--changelog', cl, '--changelog-format', 'json'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    // The data loss is surfaced, not silent.
    assert.match(`${r.stdout}${r.stderr}`, /could not parse the existing changelog as JSON/i);
    // The release still lands rather than failing the job.
    assert.equal(JSON.parse(readFileSync(cl, 'utf8'))[0].version, 'v9.9.9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Prompt guarantees (protoAgent v0.104.0–v0.104.2) ───────────────────────────────────
// Four consecutive releases needed the generated notes hand-corrected before shipping, and
// every failure was the same shape: the rewrite kept WHAT changed and dropped what the
// reader must DO about it.
//
//   v0.104.0  dropped "peers must be on protolabs-a2a >= 0.3.0" (breaking, no dual-read)
//   v0.104.0  described a `no_delete` fence that REFUSES deletion as one that "gates
//             deletion behind approval" — two mechanisms compressed into one bullet, and
//             the safety control described as weaker than it is
//   v0.104.1  dropped that the flow MINTS an auth token, so other clients start 401ing
//   v0.104.2  dropped the manual recovery for an app too broken to run its own updater
//
// That was structural, not luck: "one sentence per bullet" + a word ceiling + "user-facing
// impact only" squeezes out exactly these, because a consequence is always a SECOND
// sentence. These assertions pin the instructions that fix it.
test('system prompt requires actions, consequences and recovery steps to survive', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    // A second sentence must be explicitly permitted, or the one-sentence rule wins.
    assert.match(out, /second sentence/i);
    assert.match(out, /breaking change or required upgrade/i);
    assert.match(out, /recovery step/i);
    // The worst case: the bug stops the app updating itself, so the notes are the only route.
    assert.match(out, /updating itself|update itself/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('system prompt forbids merging mechanisms or softening a stated limitation', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    assert.match(out, /NEVER merge two distinct mechanisms/);
    assert.match(out, /Do not soften or generalise/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the word ceiling does not license dropping a required action', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    assert.match(out, /ceiling is not a reason to drop/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── No invented capabilities (protoAgent v0.104.3) ─────────────────────────────────────
// The first release generated AFTER the #52 fix kept consequences correctly — and invented a
// feature: "The pairing page clearly indicates where the token was written." The console
// source contains that string zero times. It reads as a plausible sibling of the two REAL
// bullets beside it (a token is displayed; a prompt names file paths), which is what makes
// this failure mode expensive: an invented capability is indistinguishable from a real one
// until the reader goes looking for it.
//
// Root cause was in the prompt, not the model: "If commits are sparse, infer user impact from
// what is present" licensed exactly this, and "group into 2–4 sections" read as a quota that
// rewards padding.
test('system prompt forbids inventing capabilities and requires commit traceability', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    assert.match(out, /traceable to a specific commit/i);
    // Impact-inference stays legal; existence-inference does not — the distinction is the fix.
    assert.match(out, /never infer the EXISTENCE of a capability/i);
    assert.doesNotMatch(out, /If commits are sparse, infer user impact from what is present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the section range is a ceiling, not a quota to pad toward', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    assert.match(out, /ceiling, not a quota/i);
    assert.match(out, /Never pad/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Bullets are the contract, not a style (protoAgent v0.138.0) ────────────────────────
// The 2026-08-15 gateway cutover changed the model behind `protolabs/fast` without changing
// the alias. The first releases generated after it (protoAgent v0.137.0–v0.138.0) kept the
// intro and the bold headers but wrote a PROSE PARAGRAPH under each header — zero bullets.
// "then the sections with bullets" was the only formatting instruction, and the new model
// read "sections" as licence for paragraphs. Downstream, extractHighlights found no list
// lines, so the `highlights` output shipped `[]` and changelog/PR entries lost their list.
// The prompt now pins the marker itself and says why prose is not an option.
test('system prompt demands `- ` bullet lists under headers and forbids paragraphs', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  try {
    const out = runDryRun(dir).stdout;
    assert.match(out, /every line starts with "- "/);
    assert.match(out, /Never write paragraphs\s+under a header/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-markdown bullets (•) are normalized to `- ` across every sink', () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, 'notes.md'),
      'Intro line.\n\n**Setup**\n• first thing\n• second thing\n',
    );
    const ghOut = join(dir, 'gh_output');
    writeFileSync(ghOut, '');
    const r = spawnSync(
      'node',
      [CLI, 'v4.0.0', '--notes-file', join(dir, 'notes.md'), '--out', join(dir, 'out.md')],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: ghOut } },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(join(dir, 'out.md'), 'utf8');
    assert.doesNotMatch(out, /•/);
    assert.match(out, /- first thing/);
    // The list survives into the structured output too.
    assert.match(readFileSync(ghOut, 'utf8'), /highlights=\["first thing","second thing"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paragraph-only notes (no bullets at all) trip a loud warning', () => {
  const dir = tmp();
  try {
    // The exact v0.138.0 failure shape: intro + bold headers + prose, no list lines.
    writeFileSync(
      join(dir, 'notes.md'),
      'v0.138.0 introduces improvements.\n\n**Context Lifecycle**\nThe agent now applies rolling cache breakpoints. Dynamic context composes once per turn.\n',
    );
    const r = spawnSync('node', [CLI, 'v5.0.0', '--notes-file', join(dir, 'notes.md')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(`${r.stdout}${r.stderr}`, /notes contain no bullet list/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a single unwrapped prose blob (no newlines) also trips the warning', () => {
  const dir = tmp();
  try {
    // A model writing one long paragraph emits no hard newlines — the warning
    // must not hide behind a multi-line requirement.
    writeFileSync(
      join(dir, 'notes.md'),
      'This release improves reliability, hardens the gateway retry path, and exposes new outputs.',
    );
    const r = spawnSync('node', [CLI, 'v5.0.1', '--notes-file', join(dir, 'notes.md')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(`${r.stdout}${r.stderr}`, /notes contain no bullet list/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Docs-only commits are not shipped features (release-tools#51) ───────────────
// An ADR (Architecture Decision Record) records a PLAN; a `docs:`/`doc:` commit is a
// guide, README, or ADR — an explanation, not shipped behaviour. A docs commit that
// reached the LLM got described as delivered functionality nobody built, so they are
// stripped from the commit list AND the model is told ADRs are plans, not features.
test('docs-only (ADR/guide) commits are excluded from the user prompt; real features survive', () => {
  const dir = makeRepo(2, ['v1.0.0']);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('commit', '-q', '--allow-empty', '-m', 'docs(adr): ADR 0082 — per-chat ACP runtime');
  git('commit', '-q', '--allow-empty', '-m', 'docs: rewrite the setup guide');
  git('commit', '-q', '--allow-empty', '-m', 'doc(readme): fix a broken link');
  git('commit', '-q', '--allow-empty', '-m', 'feat: ship the per-chat ACP runtime');
  git('tag', 'v1.1.0');
  try {
    const r = runDryRun(dir);
    assert.equal(r.status, 0, r.stderr);
    // Isolate the user prompt — the system prompt legitimately mentions "docs-only".
    const userPrompt = r.stdout.split('── User Prompt ──')[1] ?? '';
    // None of the docs/ADR prefixes (scoped or bare, docs: and doc:) reach the LLM.
    assert.doesNotMatch(userPrompt, /ADR 0082/);
    assert.doesNotMatch(userPrompt, /rewrite the setup guide/);
    assert.doesNotMatch(userPrompt, /fix a broken link/);
    // ...but a real feature commit in the same range still does.
    assert.match(userPrompt, /ship the per-chat ACP runtime/);
    // And the system prompt tells the model an ADR is a plan, not a shipped feature.
    assert.match(r.stdout, /ADR .*is a PLAN, not a shipped feature/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
