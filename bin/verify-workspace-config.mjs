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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateStandard } from '../lib/workspace-config.mjs';

/**
 * Extract `runs-on:` values from a workflow YAML body. Deliberately a regex
 * scan, not a full YAML parse — runs-on can be a scalar, a list, or an
 * expression, and we only need the literal labels to flag hosted runners.
 * Returns one entry per runs-on occurrence.
 */
function extractRunsOn(file, body) {
  const out = [];
  const re = /^\s*runs-on:\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    let val = m[1].trim();
    // Inline list form: [ubuntu-latest, ...] — split and emit each.
    if (val.startsWith('[')) {
      val
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .forEach((label) => out.push({ file, runsOn: label }));
    } else {
      out.push({ file, runsOn: val.replace(/^['"]|['"]$/g, '') });
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
  const target = args.repo ?? args.root ?? process.cwd();

  if (args.json) {
    console.log(JSON.stringify({ target, ...report }, null, 2));
  } else {
    printHuman(target, report);
  }

  if (!report.ok && !args.warnOnly) process.exit(1);
  process.exit(0);
} catch (err) {
  console.error(`verify-workspace-config: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
}

// ── manifest builders ────────────────────────────────────────────────────

/** Build a manifest from a local checkout (working tree). */
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

  return {
    hasFile: (p) => existsSync(join(root, p)),
    gitignore,
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

  // Fetch .gitignore content (base64) if present.
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

function printHuman(target, report) {
  console.log(`workspace-config: ${target}`);
  if (report.violations.length === 0) {
    console.log('  ✅ conformant — all standard checks pass');
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
