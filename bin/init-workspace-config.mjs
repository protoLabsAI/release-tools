#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scaffold a repo to the protoLabs workspace-config standard: create the
 * missing `.beads/` + `.automaker/` baseline files and patch `.gitignore`.
 * Idempotent — re-running only fills gaps. Run inside a checkout, then commit.
 *
 * What it does NOT do: change `.github/workflows` runner labels — that's a
 * per-workflow code edit. `verify-workspace-config` flags those separately.
 *
 * Usage:
 *   init-workspace-config [flags]
 *
 * Flags:
 *   --root <path>   Repo root (default: cwd).
 *   --dry-run       Print the plan; write nothing.
 *   --help          Show this help.
 *
 * After running:
 *   git add .beads/issues.jsonl .automaker/settings.json .gitignore
 *   npx @protolabsai/release-tools verify-workspace-config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { planScaffold } from '../lib/workspace-config.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  await printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ?? process.cwd();

try {
  const giPath = join(root, '.gitignore');
  const gitignore = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const manifest = { hasFile: (p) => existsSync(join(root, p)), gitignore };

  const plan = planScaffold(manifest);

  if (plan.create.length === 0 && plan.gitignoreAdditions.length === 0) {
    console.log('workspace-config: already scaffolded — nothing to do.');
    process.exit(0);
  }

  console.log(`workspace-config scaffold for ${root}${args.dryRun ? ' (dry run)' : ''}:`);

  for (const f of plan.create) {
    console.log(`  + create ${f.path}`);
    if (!args.dryRun) {
      const abs = join(root, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
  }

  if (plan.gitignoreAdditions.length > 0) {
    console.log(`  ~ .gitignore += ${plan.gitignoreAdditions.join(', ')}`);
    if (!args.dryRun) {
      const block =
        (gitignore && !gitignore.endsWith('\n') ? '\n' : '') +
        '\n# protoLabs workspace-config standard\n' +
        plan.gitignoreAdditions.join('\n') +
        '\n';
      writeFileSync(giPath, gitignore + block);
    }
  }

  console.log('');
  if (args.dryRun) {
    console.log('Dry run — nothing written. Re-run without --dry-run to apply.');
  } else {
    console.log('Done. Next:');
    console.log('  git add .beads/issues.jsonl .automaker/settings.json .gitignore');
    console.log('  npx @protolabsai/release-tools verify-workspace-config');
  }
  process.exit(0);
} catch (err) {
  console.error(`init-workspace-config: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('--root requires a value');
      opts.root = v;
      i++;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else {
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
