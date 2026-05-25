# Verify & fix workspace config

Check a repo against the `.beads/` + `.automaker/` + owned-runner standard, and
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

`workflows-use-owned-runners` errors are per-workflow code edits: change
`runs-on: ubuntu-latest` (etc.) to `runs-on: namespace-profile-protolabs-linux`
in the listed workflow files and open a PR. Cross-platform builds that
legitimately need hosted runners are a known exception (see
release-tools#17). Full rule table: [workspace-config-standard](../reference/workspace-config-standard.md).
