# Handoff: `review-code` v1.1.0

Date: 2026-05-21

## What Landed

- Moved the model-backed review harness out of `mythxengine2.0` and into `protoLabsAI/release-tools`.
- Closed MythX PR #92 as superseded by shared tooling.
- Merged release-tools PR #4: https://github.com/protoLabsAI/release-tools/pull/4
- Added the reusable `review-code` CLI:
  - `review-code init`
  - `review-code map`
  - `review-code run`
  - `review-code status`
  - `review-code report`
- Added `lib/code-review.mjs` with bounded feature mapping, strict JSON review calls, persisted findings, triage preservation, allowlisted locations, symlink-safe repo scanning, and Markdown reports.
- Added tests, CI syntax checks, smoke coverage, and an ESLint flat config.
- Created GitHub release `v1.1.0`: https://github.com/protoLabsAI/release-tools/releases/tag/v1.1.0

## Validation

Local validation passed:

```bash
node --check bin/rewrite-release-notes.mjs
node --check bin/build-updater-manifest.mjs
node --check bin/review-code.mjs
node --check lib/code-review.mjs
npm test
npm run smoke
npm run lint
```

Live gateway smoke passed with `protolabs/fast`:

```bash
review-code init
review-code map
review-code run --model protolabs/fast --limit 1
review-code report
```

## Current Usage

npm still serves `@protolabsai/release-tools@1.0.0`, so use the GitHub tag until npm publish is fixed:

```bash
npx --yes -p github:protoLabsAI/release-tools#v1.1.0 review-code --help
```

Once npm publish is fixed, the intended command is:

```bash
npx --yes -p @protolabsai/release-tools review-code --help
```

## Open Items

1. Fix npm publishing for `@protolabsai/release-tools@1.1.0`.
   - The release workflow created tag `v1.1.0`.
   - GitHub release exists.
   - npm publish failed with registry 404 / permission-style output.
   - `npm view @protolabsai/release-tools version` still returns `1.0.0`.
   - Likely cause: `NPM_TOKEN` scope/package permission for the `@protolabsai` org package.
2. After token/scope access is fixed, rerun the release workflow or publish `1.1.0`.
3. Minimax is supported through `--model` / `CODE_REVIEW_MODEL`, but the current gateway key rejects likely Minimax aliases as not allowed.
   - Need gateway model allowlist update before using Minimax for review runs.

## Notes

- `review-code` is intentionally report-only. It does not patch code.
- Findings are persisted under `.release-tools-review/`.
- Existing triage fields are preserved when findings regenerate.
- Repo-local feature boundaries can be supplied with `review-code.config.json`.
