#!/usr/bin/env node
/**
 * Post a code-review findings report as a sticky PR comment.
 *
 * Reads REPORT_PATH, PR_NUMBER, FINDINGS_COUNT, and GH_TOKEN from the
 * environment. Uses the `gh` CLI to PATCH a previously-posted comment
 * tagged with the `code-review:findings` marker, so re-runs replace
 * prior output instead of stacking new comments on the PR.
 *
 * Called from the composite action at
 * `.github/actions/code-review/action.yml`. Designed to be non-blocking:
 * any failure is logged and exit code is 0.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MARKER = '<!-- code-review:findings -->';

const reportPath = process.env.REPORT_PATH;
const prNumber = process.env.PR_NUMBER;
const findingsCount = process.env.FINDINGS_COUNT || '?';

if (!reportPath || !prNumber) {
  console.error('REPORT_PATH and PR_NUMBER must be set');
  process.exit(0); // non-blocking
}

let report;
try {
  report = readFileSync(reportPath, 'utf8');
} catch (err) {
  console.error(`Cannot read report at ${reportPath}: ${err.message}`);
  process.exit(0);
}

const body = `${MARKER}
## Code Review — ${findingsCount} finding(s)

> Async review running parallel to CodeRabbit. Findings are advisory; not all are merge blockers.

${report}
`;

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts });
}

const workdir = mkdtempSync(join(tmpdir(), 'code-review-'));
const bodyFile = join(workdir, 'body.md');
writeFileSync(bodyFile, body);

let existingId = null;
try {
  const comments = JSON.parse(gh(['pr', 'view', prNumber, '--json', 'comments']));
  const match = (comments.comments ?? []).find((c) => c.body?.includes(MARKER));
  if (match) existingId = match.id;
} catch (err) {
  console.error(`Failed to list comments (continuing as new): ${err.message}`);
}

if (existingId) {
  try {
    const payloadFile = join(workdir, 'patch.json');
    writeFileSync(payloadFile, JSON.stringify({ body }));
    gh([
      'api',
      '--method',
      'PATCH',
      `/repos/{owner}/{repo}/issues/comments/${existingId}`,
      '--input',
      payloadFile,
    ]);
    console.log(`Updated existing code-review comment ${existingId}`);
    process.exit(0);
  } catch (err) {
    console.error(`Patch failed, posting new comment instead: ${err.message}`);
  }
}

try {
  gh(['pr', 'comment', prNumber, '--body-file', bodyFile]);
  console.log('Posted new code-review comment');
} catch (err) {
  console.error(`Failed to post comment: ${err.message}`);
  process.exit(0);
}
