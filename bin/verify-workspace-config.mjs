#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verify a repo against the protoLabs workspace-config standard — the
 * baseline `.beads/` (issue tracker) and `.automaker/` (board) config every
 * fleet-watched repo should carry. Drift is flagged so CI can gate on it.
 *
 * Two modes:
 *   - Local (default): inspects the current checkout's working tree + git index.
 *     Use in a repo's CI on PR.
 *   - Remote (--repo owner/name): inspects a repo via the GitHub API (no clone).
 *     Use for a central fleet audit across every watched repo.
 *
 * Usage:
 *   verify-workspace-config [flags]
 *
 * Flags:
 *   --repo <owner/name>   Audit a remote repo via `gh api` instead of the local checkout.
 *   --ref <ref>           Git ref for remote mode (default: the repo's default branch).
 *   --root <path>         Local repo root (default: cwd). Ignored in remote mode.
 *   --warn-only           Exit 0 even with errors (advisory). Default: exit 1 on any error.
 *   --json                Emit a machine-readable JSON report to stdout (for the fleet check).
 *   --help                Show this help.
 *
 * Exit codes: 0 = conformant (or --warn-only), 1 = error-severity violations,
 *   2 = usage/IO error.
 *
 * Environment: GH_TOKEN / GITHUB_TOKEN honored by `gh` for remote mode.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateStandard, listRunnerExceptions } from '../lib/workspace-config.mjs';

/**
 * Extract `runs-on:` values from a workflow YAML body. Deliberately a regex
 * scan, not a full YAML parse — runs-on can be a scalar, a list, or an
 * expression, and we only need the literal labels to flag hosted runners.
 * Returns one entry per runs-on occurrence.
 */
function extractRunsOn(file, body) {
  const out = [];
  // Sanctioned hosted-runner exception annotation. Honored on the runs-on line
  // itself (trailing comment) or on the immediately-preceding line.
  const ANNO = /#\s*workspace-config:\s*allow-hosted-runner\b\s*(.*)/i;
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*runs-on:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;

    // Detect the annotation: trailing on this line, or on the line above.
    let allowed = false;
    let reason = '';
    const inline = ANNO.exec(line);
    const prev = i > 0 ? ANNO.exec(lines[i - 1]) : null;
    if (inline) {
      allowed = true;
      reason = inline[1].trim();
    } else if (prev) {
      allowed = true;
      reason = prev[1].trim();
    }

    // Strip a trailing comment from the value before parsing labels.
    let val = m[1].replace(/\s+#.*$/, '').trim();

    const push = (label) => out.push({ file, runsOn: label, allowed, reason });
    if (val.startsWith('[')) {
      val
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .forEach(push);
    } else {
      push(val.replace(/^['"]|['"]$/g, ''));
    }
  }
  return out;
}

const execFileAsync = promisify(execFile);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  await printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));

try {
  const manifest = args.repo
    ? await remoteManifest(args.repo, args.ref)
    : localManifest(args.root ?? process.cwd());

  const report = evaluateStandard(manifest);
  const exceptions = listRunnerExceptions(manifest);
  const target = args.repo ?? args.root ?? process.cwd();

  if (args.json) {
    console.log(JSON.stringify({ target, ...report, runnerExceptions: exceptions }, null, 2));
  } else {
    printHuman(target, report, exceptions);
  }

  if (!report.ok && !args.warnOnly) process.exit(1);
  process.exit(0);
} catch (err) {
  console.error(`verify-workspace-config: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
}

// ── manifest builders ────────────────────────────────────────────────────

/** Build a manifest from a local checkout. */
function localManifest(root) {
  const giPath = join(root, '.gitignore');
  const gitignore = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';

  const workflowRunners = [];
  const wfDir = join(root, '.github', 'workflows');
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const body = readFileSync(join(wfDir, f), 'utf8');
      workflowRunners.push(...extractRunsOn(f, body));
    }
  }

  // `hasFile` means COMMITTED, not present-on-disk. A gitignored-but-present
  // file (e.g. the live .beads/beads.db SQLite) is correct and must not trip
  // `beads-db-not-committed`. Use the git index, not existsSync. Fall back to
  // existsSync only when git isn't available (not a checkout).
  let tracked = null;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    tracked = new Set(out.split('\0').filter(Boolean));
  } catch {
    tracked = null;
  }

  // Authoritative ignore resolution via git, so the allowlist `.beads/.gitignore`
  // form (`*` + `!issues.jsonl`) and nested/global ignore files are honored —
  // substring-matching the root .gitignore alone can't see them, which false-
  // failed `beads-db-gitignored` for any contributor with a local beads.db (#32).
  // `git check-ignore -q PATH` exits 0=ignored, 1=not ignored, 128=error; it
  // works on the pathname whether or not the file exists. Only wired when git is
  // usable (tracked !== null); otherwise the rule falls back to .gitignore text.
  const isIgnored = tracked
    ? (p) => {
        try {
          execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', p], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      }
    : undefined;

  return {
    hasFile: (p) => (tracked ? tracked.has(p) : existsSync(join(root, p))),
    gitignore,
    ...(isIgnored ? { isIgnored } : {}),
    workflowRunners,
  };
}

/** Build a manifest from a remote repo via the GitHub contents API. */
async function remoteManifest(repo, ref) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/name, got "${repo}"`);

  const resolvedRef = ref ?? (await defaultBranch(owner, name));

  const exists = async (path) => {
    try {
      await execFileAsync(
        'gh',
        ['api', `repos/${owner}/${name}/contents/${path}?ref=${resolvedRef}`],
        { encoding: 'utf8' }
      );
      return true;
    } catch {
      return false;
    }
  };

  // Fetch root .gitignore content (base64) if present. NOTE: remote mode has no
  // git, so it can't `check-ignore` and supplies no `isIgnored` — `beads-db-
  // gitignored` falls back to substring matching the ROOT .gitignore only. It
  // still can't see the allowlist `*` form or a nested .beads/.gitignore (#32 is
  // fixed for local mode only; remote audit retains this blind spot by design —
  // follow-up: fetch .beads/.gitignore + evaluate with an allowlist-aware matcher).
  let gitignore = '';
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${owner}/${name}/contents/.gitignore?ref=${resolvedRef}`, '--jq', '.content'],
      { encoding: 'utf8' }
    );
    gitignore = Buffer.from(stdout.trim(), 'base64').toString('utf8');
  } catch {
    gitignore = '';
  }

  // Pre-resolve the file checks the standard cares about (avoid a round-trip per call).
  const checkedPaths = [
    '.beads/issues.jsonl',
    '.beads/beads.db',
    '.automaker/settings.json',
  ];
  const present = new Set();
  await Promise.all(
    checkedPaths.map(async (p) => {
      if (await exists(p)) present.add(p);
    })
  );

  // List .github/workflows/ and pull each workflow's runs-on values.
  const workflowRunners = [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${name}/contents/.github/workflows?ref=${resolvedRef}`,
        '--jq',
        '.[] | select(.name | test("\\\\.ya?ml$")) | .name',
      ],
      { encoding: 'utf8' }
    );
    const files = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(
      files.map(async (f) => {
        try {
          const { stdout: b64 } = await execFileAsync(
            'gh',
            [
              'api',
              `repos/${owner}/${name}/contents/.github/workflows/${f}?ref=${resolvedRef}`,
              '--jq',
              '.content',
            ],
            { encoding: 'utf8' }
          );
          const body = Buffer.from(b64.trim(), 'base64').toString('utf8');
          workflowRunners.push(...extractRunsOn(f, body));
        } catch {
          /* skip unreadable workflow */
        }
      })
    );
  } catch {
    /* no .github/workflows dir */
  }

  return { hasFile: (p) => present.has(p), gitignore, workflowRunners };
}

async function defaultBranch(owner, name) {
  const { stdout } = await execFileAsync(
    'gh',
    ['api', `repos/${owner}/${name}`, '--jq', '.default_branch'],
    { encoding: 'utf8' }
  );
  return stdout.trim() || 'main';
}

// ── output ──────────────────────────────────────────────────────────────

function printHuman(target, report, exceptions = []) {
  console.log(`workspace-config: ${target}`);
  const printExceptions = () => {
    for (const e of exceptions) {
      console.log(`  ℹ️  hosted-runner exception: ${e.file} (${e.runsOn})${e.reason ? ` — ${e.reason}` : ''}`);
    }
  };
  if (report.violations.length === 0) {
    console.log('  ✅ conformant — all standard checks pass');
    printExceptions();
    return;
  }
  for (const v of report.violations) {
    const mark = v.severity === 'error' ? '❌' : '⚠️ ';
    console.log(`  ${mark} [${v.id}] ${v.description}`);
    if (v.detail) {
      for (const d of v.detail) console.log(`        • ${d}`);
    }
    console.log(`        fix: ${v.fix}`);
  }
  printExceptions();
  console.log('');
  console.log(
    `  ${report.errorCount} error(s), ${report.warnCount} warning(s), ${report.passed.length} passed`
  );
}

// ── arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`flag ${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--repo':
        opts.repo = next();
        break;
      case '--ref':
        opts.ref = next();
        break;
      case '--root':
        opts.root = next();
        break;
      case '--warn-only':
        opts.warnOnly = true;
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
