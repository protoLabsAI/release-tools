# Audit the whole fleet for drift

Check every watched repo against the workspace-config standard at once.

## On demand

```bash
# For each active repo in protoWorkstacean/workspace/projects.yaml:
npx @protolabsai/release-tools verify-workspace-config --repo protoLabsAI/<repo> --json --warn-only
```

`--json` emits `{ target, violations, passed, errorCount, warnCount, ok }` for
aggregation; `--warn-only` keeps exit 0 so a loop doesn't abort on the first
drifting repo.

## Continuous (the standing mechanism)

The `Fleet Config Audit` workflow in protoWorkstacean
(`.github/workflows/fleet-config-audit.yml`) runs this across `projects.yaml`
daily on `namespace-profile-protolabs-linux`, writes a summary table, pings
`#alerts` on drift (when `DISCORD_WEBHOOK_ALERTS` is set), and fails the run
when any repo drifts — so the scheduled status is a live conformance signal.

Trigger it manually from the Actions tab (`workflow_dispatch`).
