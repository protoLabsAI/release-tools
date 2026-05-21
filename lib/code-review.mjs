/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_SCHEMA_VERSION = '0.1.0';
export const DEFAULT_REVIEW_STATE_DIR = '.release-tools-review';
export const DEFAULT_REVIEW_MODEL = 'protolabs/smart';
export const DEFAULT_REVIEW_BASE_URL = 'https://api.proto-labs.ai/v1';
export const MAX_REVIEW_CONTEXT_CHARS = 12000;
export const MAX_REVIEW_FILE_CHARS = 4000;

const DEFAULT_FEATURE_SPECS = [
  {
    feature_id: 'release_package',
    name: 'Release package metadata',
    description: 'Package metadata, README usage, actions, and workflow wiring.',
    owned_globs: [
      'package.json',
      'README.md',
      'action.yml',
      '.github/workflows/*.yml',
      '.github/workflows/*.yaml',
    ],
    context_globs: [],
    test_globs: ['test/**/*.mjs', 'test/**/*.js', 'tests/**/*.mjs', 'tests/**/*.js'],
  },
  {
    feature_id: 'release_tools_cli',
    name: 'Release tools CLI',
    description: 'Executable CLI entrypoints and reusable release tooling logic.',
    owned_globs: ['bin/*.mjs', 'lib/**/*.mjs', 'lib/*.mjs'],
    context_globs: ['README.md', 'package.json'],
    test_globs: ['test/**/*.mjs', 'test/**/*.js', 'tests/**/*.mjs', 'tests/**/*.js'],
  },
  {
    feature_id: 'tests',
    name: 'Tests and smoke coverage',
    description: 'Node tests, smoke scripts, and CI validation paths.',
    owned_globs: ['test/**/*.mjs', 'test/**/*.js', 'tests/**/*.mjs', 'tests/**/*.js'],
    context_globs: ['package.json', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
    test_globs: [],
  },
];

export class CodeReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodeReviewError';
  }
}

export function initReviewState({
  repoRoot = process.cwd(),
  stateDir = DEFAULT_REVIEW_STATE_DIR,
  model = DEFAULT_REVIEW_MODEL,
  configPath = null,
} = {}) {
  const root = path.resolve(repoRoot);
  const state = resolveStateDir(root, stateDir);
  fs.mkdirSync(state, { recursive: true });
  const config = {
    schema_version: REVIEW_SCHEMA_VERSION,
    state_dir: state,
    provider: {
      name: 'openai-compatible',
      model,
      env: {
        api_key: 'GATEWAY_API_KEY or OPENAI_API_KEY',
        base_url: 'OPENAI_BASE_URL',
        model: 'CODE_REVIEW_MODEL',
      },
    },
    review: {
      max_context_chars: MAX_REVIEW_CONTEXT_CHARS,
      max_file_chars: MAX_REVIEW_FILE_CHARS,
      max_findings_per_feature: 8,
    },
    config_path: configPath,
    feature_specs: loadFeatureSpecs(root, configPath),
  };
  const project = {
    schema_version: REVIEW_SCHEMA_VERSION,
    project: path.basename(root),
    kind: 'code-review-target',
    root,
    git_head: gitHead(root),
    generated_at: utcNow(),
  };
  writeJson(path.join(state, 'config.json'), config);
  writeJson(path.join(state, 'project.json'), project);
  return { state_dir: state, config, project };
}

export function mapReviewFeatures({
  repoRoot = process.cwd(),
  stateDir = DEFAULT_REVIEW_STATE_DIR,
  configPath = null,
} = {}) {
  const root = path.resolve(repoRoot);
  const state = resolveStateDir(root, stateDir);
  const allFiles = repoFiles(root, state);
  const featureSpecs = loadFeatureSpecs(root, configPath, state);
  const features = featureSpecs.map((spec) => featureRecord(root, allFiles, spec));
  const payload = {
    schema_version: REVIEW_SCHEMA_VERSION,
    generated_at: utcNow(),
    git_head: gitHead(root),
    features,
  };
  fs.mkdirSync(state, { recursive: true });
  writeJson(path.join(state, 'features.json'), payload);
  return payload;
}

export async function reviewMappedFeatures({
  repoRoot = process.cwd(),
  stateDir = DEFAULT_REVIEW_STATE_DIR,
  model = DEFAULT_REVIEW_MODEL,
  limit = null,
  featureId = null,
  configPath = null,
  client = null,
} = {}) {
  const root = path.resolve(repoRoot);
  const state = resolveStateDir(root, stateDir);
  let features = [...loadOrMapFeatures(root, state, configPath).features];
  if (featureId) {
    features = features.filter((feature) => feature.feature_id === featureId);
    if (features.length === 0) {
      throw new CodeReviewError(`Unknown feature_id: ${featureId}`);
    }
  }
  if (limit !== null && limit !== undefined) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new CodeReviewError('Invalid --limit: must be a positive integer');
    }
    features = features.slice(0, parsedLimit);
  }
  if (features.length === 0) {
    throw new CodeReviewError('No feature records selected for review');
  }

  const provider = client ?? {
    createStructuredOutput: (request) => callStructuredReview(request),
  };
  const findingsDir = path.join(state, 'findings');
  fs.mkdirSync(findingsDir, { recursive: true });
  const acceptedFindings = [];
  const reviewed = [];
  let rejectedCount = 0;

  for (const feature of features) {
    const response = await provider.createStructuredOutput({
      model,
      systemPrompt: reviewSystemPrompt(),
      userPrompt: reviewPrompt(root, feature),
      schema: reviewOutputSchema(),
    });
    const { findings, rejected } = normalizeFindings(root, feature, response);
    rejectedCount += rejected;
    for (const finding of findings) {
      const findingPath = path.join(findingsDir, `${finding.finding_id}.json`);
      const existing = loadJson(findingPath, null);
      const merged = preserveTriage(existing, finding);
      writeJson(findingPath, merged);
      acceptedFindings.push(merged);
    }
    reviewed.push({
      feature_id: feature.feature_id,
      finding_count: findings.length,
      rejected_count: rejected,
    });
  }

  const run = {
    schema_version: REVIEW_SCHEMA_VERSION,
    generated_at: utcNow(),
    git_head: gitHead(root),
    model,
    reviewed,
    finding_count: acceptedFindings.length,
    rejected_count: rejectedCount,
    findings: acceptedFindings.map((finding) => finding.finding_id),
  };
  const runsDir = path.join(state, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  writeJson(path.join(runsDir, `review_${timestampId()}.json`), run);
  return run;
}

export function reviewStatus({
  repoRoot = process.cwd(),
  stateDir = DEFAULT_REVIEW_STATE_DIR,
} = {}) {
  const root = path.resolve(repoRoot);
  const state = resolveStateDir(root, stateDir);
  const featuresPayload = loadJson(path.join(state, 'features.json'), {});
  const findings = loadReviewFindings({ stateDir: state });
  const statusCounts = {};
  const severityCounts = {};
  for (const finding of findings) {
    const status = String(finding.status ?? 'open');
    const severity = String(finding.severity ?? 'low');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
  }
  return {
    state_dir: state,
    git_head: gitHead(root),
    feature_count: Array.isArray(featuresPayload.features)
      ? featuresPayload.features.length
      : 0,
    finding_count: findings.length,
    status_counts: statusCounts,
    severity_counts: severityCounts,
  };
}

export function loadReviewFindings({ stateDir = DEFAULT_REVIEW_STATE_DIR } = {}) {
  const findingsDir = path.join(path.resolve(stateDir), 'findings');
  if (!fs.existsSync(findingsDir)) return [];
  const findings = [];
  for (const name of fs.readdirSync(findingsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const payload = loadJson(path.join(findingsDir, name), null);
    if (payload && typeof payload === 'object' && payload.finding_id) {
      findings.push(payload);
    }
  }
  return findings.sort((a, b) => {
    const left = [
      severityRank(a.severity),
      String(a.feature_id ?? ''),
      String(a.path ?? ''),
      Number(a.line ?? 0),
    ];
    const right = [
      severityRank(b.severity),
      String(b.feature_id ?? ''),
      String(b.path ?? ''),
      Number(b.line ?? 0),
    ];
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

export function buildReviewReport({
  repoRoot = process.cwd(),
  stateDir = DEFAULT_REVIEW_STATE_DIR,
  output = null,
} = {}) {
  const root = path.resolve(repoRoot);
  const state = resolveStateDir(root, stateDir);
  const reportPath = output
    ? path.resolve(root, output)
    : path.join(state, 'report.md');
  const status = reviewStatus({ repoRoot: root, stateDir: state });
  const findings = loadReviewFindings({ stateDir: state });
  const lines = [
    '# protoLabs Code Review Report',
    '',
    `- Generated: \`${utcNow()}\``,
    `- Git head: \`${status.git_head}\``,
    `- Features mapped: \`${status.feature_count}\``,
    `- Findings: \`${status.finding_count}\``,
    '',
  ];
  if (findings.length === 0) {
    lines.push('No findings recorded.', '');
  } else {
    lines.push('## Findings', '');
    for (const finding of findings) {
      lines.push(
        `### ${String(finding.severity).toUpperCase()} - ${finding.title}`,
        '',
        `- ID: \`${finding.finding_id}\``,
        `- Status: \`${finding.status ?? 'open'}\``,
        `- Feature: \`${finding.feature_id ?? ''}\``,
        `- Category: \`${finding.category ?? ''}\``,
        `- Confidence: \`${finding.confidence ?? ''}\``,
        `- Location: \`${finding.path ?? ''}:${finding.line ?? ''}\``,
        '',
        '**Evidence**',
        '',
        String(finding.evidence ?? '').trim(),
        '',
        '**Recommendation**',
        '',
        String(finding.recommendation ?? '').trim(),
        '',
      );
    }
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return { path: reportPath, finding_count: findings.length };
}

export function reviewPrompt(repoRoot, feature) {
  const snippets = [];
  for (const [label, key, maxFiles] of [
    ['owned', 'owned_files', 6],
    ['tests', 'test_files', 4],
    ['context', 'context_files', 3],
  ]) {
    for (const relPath of (feature[key] ?? []).slice(0, maxFiles)) {
      snippets.push(fileExcerpt(repoRoot, relPath, label));
    }
  }
  return [
    'Review this bounded feature record.',
    '',
    `Feature:\n${JSON.stringify(feature, null, 2)}`,
    '',
    'Relevant files:',
    '',
    boundedFileContext(snippets),
    '',
    'Return findings only when they are still-valid and actionable.',
    'If no issue is worth filing, return {"findings": []}.',
  ].join('\n');
}

export function reviewOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            category: {
              type: 'string',
              enum: [
                'bug',
                'security',
                'performance',
                'docs-gap',
                'test-gap',
                'maintainability',
              ],
            },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low'],
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            path: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            evidence: { type: 'string' },
            recommendation: { type: 'string' },
          },
          required: [
            'title',
            'category',
            'severity',
            'confidence',
            'path',
            'line',
            'evidence',
            'recommendation',
          ],
        },
      },
    },
    required: ['findings'],
  };
}

function reviewSystemPrompt() {
  return [
    'You are reviewing a software repository through protoLabs release-tools.',
    'Return strict JSON only.',
    'Focus on actionable correctness, security, determinism, contract drift, and missing tests.',
    'Do not report style nits. Do not invent files or private context.',
  ].join(' ');
}

async function callStructuredReview({ model, systemPrompt, userPrompt, schema }) {
  const apiKey = process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new CodeReviewError('GATEWAY_API_KEY or OPENAI_API_KEY is required');
  }
  const baseUrl = normalizeBaseUrl(
    process.env.OPENAI_BASE_URL || DEFAULT_REVIEW_BASE_URL,
  );
  const rawTimeoutMs = Number(process.env.CODE_REVIEW_TIMEOUT_MS || '30000');
  const timeoutMs =
    Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'code_review_findings',
            strict: true,
            schema,
          },
        },
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CodeReviewError(`LLM API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new CodeReviewError(`LLM API error ${res.status}: ${await res.text()}`);
  }
  const payload = await res.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new CodeReviewError('LLM response did not include message content');
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CodeReviewError('LLM response JSON must be an object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof CodeReviewError) throw error;
    throw new CodeReviewError(`LLM response was not valid JSON: ${error.message}`);
  }
}

function normalizeFindings(repoRoot, feature, response) {
  const rawFindings = response?.findings;
  if (!Array.isArray(rawFindings)) {
    throw new CodeReviewError('Review provider response must include findings list');
  }
  const findings = [];
  let rejected = 0;
  for (const rawFinding of rawFindings) {
    if (!rawFinding || typeof rawFinding !== 'object') {
      rejected += 1;
      continue;
    }
    const location = validateFindingLocation(repoRoot, feature, rawFinding);
    if (!location) {
      rejected += 1;
      continue;
    }
    const finding = {
      schema_version: REVIEW_SCHEMA_VERSION,
      status: 'open',
      feature_id: String(feature.feature_id ?? ''),
      title: requiredString(rawFinding, 'title'),
      category: requiredString(rawFinding, 'category'),
      severity: requiredString(rawFinding, 'severity'),
      confidence: requiredString(rawFinding, 'confidence'),
      path: location.path,
      line: location.line,
      evidence: requiredString(rawFinding, 'evidence'),
      recommendation: requiredString(rawFinding, 'recommendation'),
      created_at: utcNow(),
    };
    finding.finding_id = findingId(feature, finding);
    findings.push(finding);
  }
  return { findings, rejected };
}

function validateFindingLocation(repoRoot, feature, finding) {
  const relPath = typeof finding.path === 'string' ? normalizeRelPath(finding.path) : '';
  const line = Number(finding.line);
  if (!relPath || !Number.isInteger(line) || line <= 0) return null;
  const allowlist = new Set([
    ...(feature.owned_files ?? []),
    ...(feature.context_files ?? []),
    ...(feature.test_files ?? []),
  ]);
  if (!allowlist.has(relPath)) return null;
  const absolute = safeRepoPath(repoRoot, relPath);
  if (!absolute) return null;
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
  const lineCount = Math.max(1, text.split('\n').length);
  if (line > lineCount) return null;
  return { path: relPath, line };
}

function preserveTriage(existing, finding) {
  if (!existing || typeof existing !== 'object') return finding;
  const preserved = { ...finding };
  for (const key of ['status', 'triage', 'resolution', 'notes', 'owner']) {
    if (existing[key] !== undefined) preserved[key] = existing[key];
  }
  return preserved;
}

function loadFeatureSpecs(repoRoot, configPath = null, stateDir = null) {
  const candidates = [];
  if (configPath) candidates.push(path.resolve(repoRoot, configPath));
  if (stateDir) candidates.push(path.join(stateDir, 'config.json'));
  candidates.push(path.join(repoRoot, 'review-code.config.json'));
  for (const candidate of candidates) {
    const payload = loadJson(candidate, null);
    if (!payload || typeof payload !== 'object') continue;
    const specs = payload.features ?? payload.feature_specs;
    if (Array.isArray(specs) && specs.length > 0) {
      return specs.map(normalizeFeatureSpec);
    }
  }
  return DEFAULT_FEATURE_SPECS.map(normalizeFeatureSpec);
}

function normalizeFeatureSpec(spec) {
  return {
    feature_id: requiredConfigString(spec, 'feature_id'),
    name: spec.name ? String(spec.name) : String(spec.feature_id),
    description: spec.description ? String(spec.description) : '',
    owned_globs: normalizeStringList(spec.owned_globs),
    context_globs: normalizeStringList(spec.context_globs),
    test_globs: normalizeStringList(spec.test_globs),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function requiredConfigString(spec, key) {
  const value = spec?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodeReviewError(`Feature spec field ${key} must be a non-empty string`);
  }
  return value.trim();
}

function loadOrMapFeatures(repoRoot, stateDir, configPath) {
  const payload = loadJson(path.join(stateDir, 'features.json'), null);
  if (payload && Array.isArray(payload.features)) return payload;
  return mapReviewFeatures({ repoRoot, stateDir, configPath });
}

function featureRecord(repoRoot, allFiles, spec) {
  const ownedFiles = matchFiles(allFiles, spec.owned_globs);
  const contextFiles = matchFiles(allFiles, spec.context_globs).filter(
    (relPath) => !ownedFiles.includes(relPath),
  );
  const testFiles = matchFiles(allFiles, spec.test_globs);
  return {
    feature_id: spec.feature_id,
    name: spec.name,
    description: spec.description,
    entrypoints: entrypoints(ownedFiles),
    owned_files: ownedFiles,
    context_files: contextFiles,
    test_files: testFiles,
    owned_file_count: ownedFiles.length,
    context_file_count: contextFiles.length,
    test_file_count: testFiles.length,
    owned_bytes: ownedFiles.reduce((total, relPath) => {
      try {
        return total + fs.statSync(path.join(repoRoot, relPath)).size;
      } catch {
        return total;
      }
    }, 0),
  };
}

function repoFiles(repoRoot, stateDir) {
  const excludeDirs = new Set([
    '.git',
    'node_modules',
    'coverage',
    'dist',
    '.clawpatch',
    '.release-tools-review',
    path.basename(stateDir),
  ]);
  const files = [];
  walkRepo(repoRoot, repoRoot, excludeDirs, files);
  return files.sort();
}

function walkRepo(repoRoot, currentDir, excludeDirs, files) {
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (excludeDirs.has(entry.name)) continue;
    const absolute = path.join(currentDir, entry.name);
    const relPath = normalizeRelPath(path.relative(repoRoot, absolute));
    if (entry.isSymbolicLink()) {
      const resolved = safeResolvedPath(repoRoot, absolute);
      if (!resolved) continue;
      let stats;
      try {
        stats = fs.statSync(resolved);
      } catch {
        continue;
      }
      if (stats.isFile()) files.push(relPath);
      continue;
    }
    if (entry.isDirectory()) {
      walkRepo(repoRoot, absolute, excludeDirs, files);
      continue;
    }
    if (entry.isFile()) files.push(relPath);
  }
}

function matchFiles(files, patterns) {
  const matched = [];
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    for (const relPath of files) {
      if (regex.test(relPath) && !matched.includes(relPath)) {
        matched.push(relPath);
      }
    }
  }
  return matched;
}

function globToRegExp(pattern) {
  const normalized = normalizeRelPath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function entrypoints(ownedFiles) {
  const priority = ['package.json', 'action.yml'];
  const prioritized = priority.filter((relPath) => ownedFiles.includes(relPath));
  return prioritized.length > 0 ? prioritized : ownedFiles.slice(0, 2);
}

function fileExcerpt(repoRoot, relPath, label) {
  const absolute = safeRepoPath(repoRoot, relPath);
  if (!absolute) return `### ${label}: ${relPath}\n(unreadable: outside repo)`;
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    return `### ${label}: ${relPath}\n(unreadable: ${error.message})`;
  }
  if (text.length > MAX_REVIEW_FILE_CHARS) {
    text = `${text.slice(0, MAX_REVIEW_FILE_CHARS)}\n...<truncated>...`;
  }
  const numbered = text
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, '0')}: ${line}`)
    .join('\n');
  return `### ${label}: ${relPath}\n\`\`\`text\n${numbered}\n\`\`\``;
}

function boundedFileContext(snippets) {
  const kept = [];
  let total = 0;
  let omitted = 0;
  for (const snippet of snippets) {
    const extra = snippet.length + (kept.length > 0 ? 2 : 0);
    if (kept.length > 0 && total + extra > MAX_REVIEW_CONTEXT_CHARS) {
      omitted += 1;
      continue;
    }
    if (kept.length === 0 && extra > MAX_REVIEW_CONTEXT_CHARS) {
      const marker = '\n...<snippet truncated to configured review budget>...';
      const budget = Math.max(0, MAX_REVIEW_CONTEXT_CHARS - marker.length);
      kept.push(`${snippet.slice(0, budget)}${marker}`);
      total = kept[0].length;
      continue;
    }
    kept.push(snippet);
    total += extra;
  }
  let rendered = kept.join('\n\n');
  if (omitted > 0) {
    rendered += `\n\n...<${omitted} file excerpt(s) omitted by review context budget>...`;
  }
  return rendered;
}

function requiredString(mapping, key) {
  const value = mapping?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodeReviewError(`Finding field ${key} must be a non-empty string`);
  }
  return value.trim();
}

function findingId(feature, finding) {
  const raw = [
    feature.feature_id ?? '',
    finding.title ?? '',
    finding.path ?? '',
    finding.line ?? '',
    finding.evidence ?? '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4;
}

function resolveStateDir(repoRoot, stateDir) {
  return path.isAbsolute(stateDir) ? stateDir : path.join(repoRoot, stateDir);
}

function safeRepoPath(repoRoot, relPath) {
  const absolute = path.resolve(repoRoot, relPath);
  return isInside(repoRoot, absolute) ? absolute : null;
}

function safeResolvedPath(repoRoot, absolute) {
  try {
    const resolved = fs.realpathSync(absolute);
    return isInside(repoRoot, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelPath(value) {
  return String(value).replaceAll(path.sep, '/').replace(/^\.\/+/, '');
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.host) {
    throw new CodeReviewError('OPENAI_BASE_URL must use http or https');
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1';
  }
  return url.toString().replace(/\/$/, '');
}

function gitHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}
