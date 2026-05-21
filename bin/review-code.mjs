#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs a bounded model-backed code review loop for any repo.
 *
 * Usage:
 *   review-code init [flags]
 *   review-code map [flags]
 *   review-code run [flags]
 *   review-code status [flags]
 *   review-code report [flags]
 *
 * Flags:
 *   --repo-root <path>     Repository to review. Default: current directory.
 *   --state-dir <path>    Local review state. Default: .release-tools-review
 *   --config <path>       Optional review-code config JSON with feature specs.
 *   --model <alias>       Gateway model alias. Default: CODE_REVIEW_MODEL or protolabs/smart.
 *   --feature-id <id>     Review one mapped feature.
 *   --limit <n>           Review first n mapped features. Default for run: 1.
 *   --all                 Review every mapped feature.
 *   --output <path>       Markdown report path for report command.
 *   --help                Show this help.
 *
 * Environment:
 *   GATEWAY_API_KEY or OPENAI_API_KEY   Bearer token for the gateway.
 *   OPENAI_BASE_URL                     Default: https://api.proto-labs.ai/v1
 *   CODE_REVIEW_MODEL                   Default model override.
 */

import path from 'node:path';

import {
  CodeReviewError,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_STATE_DIR,
  buildReviewReport,
  initReviewState,
  mapReviewFeatures,
  reviewMappedFeatures,
  reviewStatus,
} from '../lib/code-review.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const self = url.fileURLToPath(import.meta.url);
  const src = fs.readFileSync(self, 'utf8').split('\n');
  const start = src.findIndex((line) => line.startsWith(' * Runs'));
  const end = src.findIndex((line, index) => index > start && line.startsWith(' */'));
  const help = src
    .slice(start, end)
    .map((line) => line.replace(/^ \* ?/, ''))
    .join('\n');
  console.log(help);
  process.exit(0);
}

const { command, flags } = parseArgs(process.argv.slice(2));
if (!command) {
  console.error('Missing command. Use --help for usage.');
  process.exit(1);
}

const repoRoot = flags['repo-root'] ?? process.cwd();
const stateDir = flags['state-dir'] ?? DEFAULT_REVIEW_STATE_DIR;
const configPath = flags.config ?? null;
const model =
  flags.model ?? process.env.CODE_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL;

try {
  if (command === 'init') {
    const result = initReviewState({ repoRoot, stateDir, model, configPath });
    console.log(`review_state=${result.state_dir}`);
    console.log(`model=${result.config.provider.model}`);
    process.exit(0);
  }

  if (command === 'map') {
    const result = mapReviewFeatures({ repoRoot, stateDir, configPath });
    console.log(`features=${result.features.length}`);
    console.log(`path=${resultPath(repoRoot, stateDir, 'features.json')}`);
    process.exit(0);
  }

  if (command === 'run') {
    if (!process.env.GATEWAY_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new CodeReviewError('GATEWAY_API_KEY or OPENAI_API_KEY is required');
    }
    const limit = runLimit(flags);
    const result = await reviewMappedFeatures({
      repoRoot,
      stateDir,
      model,
      limit,
      featureId: flags['feature-id'] ?? null,
      configPath,
    });
    console.log(
      `reviewed=${result.reviewed.length} findings=${result.finding_count} ` +
        `rejected=${result.rejected_count} model=${result.model}`,
    );
    process.exit(0);
  }

  if (command === 'status') {
    const result = reviewStatus({ repoRoot, stateDir });
    console.log(
      `features=${result.feature_count} findings=${result.finding_count} ` +
        `statuses=${JSON.stringify(result.status_counts)}`,
    );
    process.exit(0);
  }

  if (command === 'report') {
    const result = buildReviewReport({
      repoRoot,
      stateDir,
      output: flags.output ?? null,
    });
    console.log(`report=${result.path} findings=${result.finding_count}`);
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'all') {
      flags[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CodeReviewError(`Missing value for --${key}`);
    }
    flags[key] = value;
    index += 1;
  }
  return { command: positional[0], flags };
}

function runLimit(flags) {
  if (flags.all) return null;
  const raw = flags.limit ?? '1';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CodeReviewError('Invalid --limit: must be a positive integer');
  }
  return parsed;
}

function resultPath(repoRoot, stateDir, fileName) {
  return path.join(
    path.isAbsolute(stateDir) ? stateDir : path.join(repoRoot, stateDir),
    fileName,
  );
}
