# Verify & fix workspace config

Check a repo against the `.beads/` + `.automaker/` + GitHub-hosted-runner standard, and
bring it into conformance.

## Verify

```bash
# Local checkout (use in a repo's CI on PR — exits non-zero on error drift)
npx @protolabsai/release-tools verify-workspace-config

# Remote, no clone
npx @protolabsai/release-tools verify-workspace-config --repo protoLabsAI/myrepo
```

## Fix

The scaffolder writes the missing files + `.gitignore` lines (idempotent):

```bash
npx @protolabsai/release-tools init-workspace-config --dry-run   # preview
npx @protolabsai/release-tools init-workspace-config             # apply
git add .beads/issues.jsonl .automaker/settings.json .gitignore
git commit -m "chore: conform to workspace-config standard"
```

## The one thing the scaffolder can't fix

`workflows-use-github-hosted-runners` errors are per-workflow code edits. In
each listed workflow file, change a Namespace runner such as
`runs-on: ${{ vars.NSC_RUNNER || 'namespace-profile-protolabs-linux' }}` to
`runs-on: ubuntu-latest` (or `macos-latest` / `windows-latest` if the job needs
that OS), then open a PR. Full rule table: [workspace-config-standard](../reference/workspace-config-standard.md).
