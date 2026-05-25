# Workspace Config Standard

The baseline `.beads/` (issue tracker) and `.automaker/` (board) config every
fleet-watched repo should carry. "Watched" = a repo in
`protoWorkstacean/workspace/projects.yaml` that Quinn reviews and the board
engine manages. A consistent baseline means agent runs behave the same in
every repo, and drift is catchable in CI instead of surfacing as a
mid-run failure (e.g. a missing `.automaker/settings.json` falling back to an
unsupported model and 401ing the gateway).

Enforced by `verify-workspace-config` (this package).

## The standard

| Rule                             | Severity | Requirement                                                                                                                             |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `beads-issues-jsonl`             | error    | `.beads/issues.jsonl` is **committed** (git-friendly export, merges cleanly)                                                            |
| `beads-db-gitignored`            | error    | `.beads/beads.db` is **gitignored** (rebuildable SQLite)                                                                                |
| `beads-db-not-committed`         | error    | `.beads/beads.db` is **not committed**                                                                                                  |
| `automaker-settings-committed`   | error    | `.automaker/settings.json` is **committed** (versioned per-repo agent baseline)                                                         |
| `worktrees-gitignored`           | error    | `.worktrees/` is **gitignored** (agent worktrees never committed)                                                                       |
| `automaker-transient-gitignored` | warn     | `.automaker/features/`, `checkpoints/`, `trajectory/` gitignored; `settings.json` + `context/` stay committed                           |
| `workflows-use-owned-runners`    | error    | every `runs-on:` is an org-owned runner (`namespace-profile-protolabs-linux`), never GitHub-hosted (`ubuntu-*`, `windows-*`, `macos-*`) |

**Errors gate CI. Warnings are advisory.**

### Why workflows must use org-owned runners

GitHub-hosted runners burn metered Actions minutes. Every protoLabs repo
should run CI on the self-hosted `namespace-profile-protolabs-linux` profile.
The check scans `.github/workflows/*.yml` `runs-on:` values and flags any
hosted label (`ubuntu-*`, `windows-*`, `macos-*`), listing the offending
workflow files. Expression-based `runs-on` (`${{ matrix.os }}`) is not
statically flagged — matrix-hosted runners need a manual look.

#### Sanctioned hosted-runner exceptions

Some hosted-runner uses are legitimate and can't move to the namespace profile
— cross-platform binary builds (macOS/Windows Tauri targets), npm publish with
provenance. Annotate them so they pass without disabling the rule repo-wide:

```yaml
jobs:
  bundle:
    # workspace-config: allow-hosted-runner cross-platform binary build
    runs-on: macos-14
  notes:
    runs-on: ubuntu-latest  # workspace-config: allow-hosted-runner npm provenance
```

The annotation is honored on the `runs-on:` line (trailing comment) or the line
directly above it. Exceptions still appear in the audit output (and `--json`
`runnerExceptions`) — a sanctioned exception is visible, not silent.

### Why `.automaker/settings.json` is committed per-repo

The per-repo settings file pins the agent baseline — gateway model tiers
(`protolabs/fast` / `protolabs/smart` / `protolabs/reasoning`) and workflow
defaults. Committing it makes the baseline reviewable and identical for every
agent run against the repo. A repo with no committed settings inherits
whatever the host happens to have, which is how a stale `claude-sonnet` alias
once 401'd every model call through the gateway.

### Why `.beads/beads.db` is gitignored but `issues.jsonl` is committed

`beads.db` is the authoritative SQLite store but is binary and rebuildable
(`br sync --import-only --rebuild`). `issues.jsonl` is the git-friendly export
that merges cleanly and is the source of truth in version control. Committing
the `.db` causes merge conflicts and bloat; never committing the `.jsonl`
loses the issue history.

## Usage

### Local (CI on PR)

Run in the repo's working tree. Exits non-zero on any error-severity violation.

```bash
npx @protolabsai/release-tools verify-workspace-config
```

Reusable CI step:

```yaml
# .github/workflows/checks.yml
- name: Verify workspace config
  run: npx --yes -p @protolabsai/release-tools verify-workspace-config
```

### Remote (central fleet audit)

Audit any watched repo via the GitHub API — no clone needed. Used by the
fleet drift check to scan every `projects.yaml` repo at once.

```bash
verify-workspace-config --repo protoLabsAI/protoMaker
verify-workspace-config --repo protoLabsAI/protoCLI --json --warn-only
```

`--json` emits a machine-readable report (`{ target, violations, passed,
errorCount, warnCount, ok }`) for the fleet check to aggregate.

### Flags

| Flag                  | Effect                                                         |
| --------------------- | -------------------------------------------------------------- |
| `--repo <owner/name>` | Audit a remote repo via `gh api` instead of the local checkout |
| `--ref <ref>`         | Git ref for remote mode (default: repo's default branch)       |
| `--root <path>`       | Local repo root (default: cwd)                                 |
| `--warn-only`         | Exit 0 even with errors (advisory)                             |
| `--json`              | Machine-readable JSON report                                   |

Exit codes: `0` conformant (or `--warn-only`), `1` error-severity violations,
`2` usage/IO error.

## Scaffolding (init-workspace-config)

`init-workspace-config` writes the missing baseline files and patches
`.gitignore` to bring a repo to standard. Idempotent — re-running only fills
gaps. It does NOT edit workflow runner labels (that's a per-workflow change;
`verify-workspace-config` flags those).

```bash
# preview
npx @protolabsai/release-tools init-workspace-config --dry-run
# apply, then commit
npx @protolabsai/release-tools init-workspace-config
git add .beads/issues.jsonl .automaker/settings.json .gitignore
```

It creates an empty `.beads/issues.jsonl`, a minimal `.automaker/settings.json`
(`{ "version": 1 }` — teams layer workflow/model overrides on top), and the
required `.gitignore` lines.

## Bringing a repo into conformance

```bash
# beads
br init                      # creates .beads/ + issues.jsonl
echo '.beads/beads.db' >> .gitignore
git rm --cached .beads/beads.db 2>/dev/null || true

# automaker
echo '.worktrees/' >> .gitignore
printf '.automaker/features/\n.automaker/checkpoints/\n.automaker/trajectory/\n' >> .gitignore
# commit a settings.json with the gateway tiers — copy from a conformant repo
# (protoMaker is the reference) and adjust per-project workflow settings.
git add .beads/issues.jsonl .automaker/settings.json .gitignore
```

## Related

- [`apply-branch-protection`](./branch-protection-defaults.md) — the sibling org-config CLI
- `protoWorkstacean/workspace/projects.yaml` — the watched-repo registry the fleet audit iterates
