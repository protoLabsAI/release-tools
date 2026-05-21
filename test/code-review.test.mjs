import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_REVIEW_CONTEXT_CHARS,
  buildReviewReport,
  initReviewState,
  mapReviewFeatures,
  reviewMappedFeatures,
  reviewPrompt,
  reviewStatus,
} from '../lib/code-review.mjs';

test('maps configured features and skips external symlinks', () => {
  const repo = createRepo();
  const outside = path.join(os.tmpdir(), `release-tools-leak-${process.pid}.js`);
  fs.writeFileSync(outside, 'secret();\n', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(repo, 'src', 'leak.js'));
  } catch {
    // Some platforms or filesystems disallow symlinks; the mapping behavior is
    // still covered by the real file assertions below.
  }

  const mapped = mapReviewFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    configPath: 'review-code.config.json',
  });

  const feature = mapped.features.find((item) => item.feature_id === 'app');
  assert.ok(feature);
  assert.deepEqual(feature.owned_files, ['src/app.js']);
  assert.deepEqual(feature.test_files, ['test/app.test.js']);
  assert.ok(!feature.owned_files.includes('src/leak.js'));
});

test('review run persists findings, preserves triage, and reports status', async () => {
  const repo = createRepo();
  initReviewState({
    repoRoot: repo,
    stateDir: '.review-state',
    configPath: 'review-code.config.json',
  });
  mapReviewFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    configPath: 'review-code.config.json',
  });
  const client = new FakeClient([
    {
      title: 'App bug',
      category: 'bug',
      severity: 'medium',
      confidence: 'high',
      path: 'src/app.js',
      line: 1,
      evidence: 'The app exports a value.',
      recommendation: 'Add a clearer assertion.',
    },
  ]);

  const first = await reviewMappedFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    featureId: 'app',
    client,
  });

  assert.equal(first.finding_count, 1);
  const findingsDir = path.join(repo, '.review-state', 'findings');
  const findingFile = path.join(findingsDir, fs.readdirSync(findingsDir)[0]);
  const persisted = JSON.parse(fs.readFileSync(findingFile, 'utf8'));
  persisted.status = 'resolved';
  persisted.notes = 'Handled elsewhere.';
  fs.writeFileSync(findingFile, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  const second = await reviewMappedFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    featureId: 'app',
    client,
  });
  const status = reviewStatus({ repoRoot: repo, stateDir: '.review-state' });
  const report = buildReviewReport({ repoRoot: repo, stateDir: '.review-state' });
  const finalFinding = JSON.parse(fs.readFileSync(findingFile, 'utf8'));

  assert.equal(second.finding_count, 1);
  assert.equal(status.finding_count, 1);
  assert.equal(finalFinding.status, 'resolved');
  assert.equal(finalFinding.notes, 'Handled elsewhere.');
  assert.equal(report.finding_count, 1);
  assert.match(
    fs.readFileSync(path.join(repo, '.review-state', 'report.md'), 'utf8'),
    /App bug/,
  );
});

test('review run rejects out-of-scope findings', async () => {
  const repo = createRepo();
  mapReviewFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    configPath: 'review-code.config.json',
  });
  const client = new FakeClient([
    {
      title: 'Outside file',
      category: 'bug',
      severity: 'high',
      confidence: 'high',
      path: 'package.json',
      line: 1,
      evidence: 'Not in the reviewed feature allowlist.',
      recommendation: 'Do not persist this.',
    },
    {
      title: 'Bad line',
      category: 'bug',
      severity: 'low',
      confidence: 'high',
      path: 'src/app.js',
      line: 999,
      evidence: 'Line is outside file bounds.',
      recommendation: 'Do not persist this either.',
    },
  ]);

  const result = await reviewMappedFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    featureId: 'app',
    client,
  });

  assert.equal(result.finding_count, 0);
  assert.equal(result.rejected_count, 2);
});

test('review prompts stay bounded', () => {
  const repo = createRepo();
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(
      path.join(repo, 'src', `large-${index}.js`),
      `${'x'.repeat(5000)}\n`,
      'utf8',
    );
  }
  const mapped = mapReviewFeatures({
    repoRoot: repo,
    stateDir: '.review-state',
    configPath: 'review-code.config.json',
  });
  const feature = mapped.features.find((item) => item.feature_id === 'app');
  const prompt = reviewPrompt(repo, feature);

  assert.ok(prompt.length < MAX_REVIEW_CONTEXT_CHARS + 2500);
  assert.match(prompt, /omitted by review context budget/);
});

test('review-code CLI help works', () => {
  const output = execFileSync('node', ['bin/review-code.mjs', '--help'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.match(output, /review-code run/);
});

class FakeClient {
  constructor(findings) {
    this.findings = findings;
  }

  async createStructuredOutput() {
    return { findings: this.findings };
  }
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tools-review-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(
    path.join(repo, 'test', 'app.test.js'),
    'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(repo, 'review-code.config.json'),
    JSON.stringify(
      {
        features: [
          {
            feature_id: 'app',
            name: 'App',
            description: 'App source and tests.',
            owned_globs: ['src/**/*.js'],
            context_globs: [],
            test_globs: ['test/**/*.js'],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  return repo;
}
