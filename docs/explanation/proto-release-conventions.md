# Proto release conventions

Why the release + fleet tooling is shaped the way it is. This page is
background, not instructions — if you want steps, see the
[how-to guides](../index.md#how-to-guides--accomplish-a-task).

## One package, one source of truth

Every repo in the org wants the same rituals: consistent CI gating, consistent
issue/board config, the same release flow. Copy-pasting scripts between repos
guarantees drift. `@protolabsai/release-tools` centralizes the logic and exposes
it as CLIs (and a GitHub Action) so a repo adopts a convention by *calling* it,
never by forking it. When the convention changes, it changes in one place and
every consumer picks it up.

This is why the verifier, the scaffolder, and the onboarding skill all share
`lib/workspace-config.mjs`: the definition of "the standard" exists once. The
fleet audit, a repo's PR gate, and the onboard flow can't disagree about what
conformance means.

## Required status checks gate correctness, not opinions

LLM review bots (CodeRabbit, Quinn) post status checks. It's tempting to make
them required. We don't, because:

- A bot outage or a webhook that races a fast-merging PR leaves the PR blocked
  with nothing wrong with the code.
- Bots already have a real veto: a `CHANGES_REQUESTED` review blocks merge via
  `reviewDecision`. That's the right level — explicit, contextual, dismissible.

So required checks are `build` / `test` / `checks` — signals that the code
works. Advisory review stays advisory. (We learned this the hard way: a PR sat
blocked because CodeRabbit hadn't posted a status yet on an otherwise-green,
fast-merged PR.)

## Loose branch policy for linear stacks

`strict_required_status_checks_policy: true` forces a PR to be up-to-date with
its base before merge. For small teams shipping linear PR stacks that's an
N×CI-cycle tax: merge A, B is now behind, rebase B, wait for CI, merge B, C is
behind… A five-PR stack can cost ~25 minutes of pure CI-wait. The test suite is
the real safety net — a stale branch that would break main usually fails its
own CI. We default loose, and keep strict only on repos with enough parallel
contributors that semantic conflicts between stale branches are a genuine risk.

## Owned runners, not GitHub-hosted

GitHub-hosted runners bill metered minutes. Routine CI should run on the
self-hosted `namespace-profile-protolabs-linux` profile. The standard flags any
`ubuntu/windows/macos-*` `runs-on:` so minutes don't leak silently. The
exception is work that genuinely needs a hosted runner — cross-platform binary
builds (Tauri's macOS/Windows targets can't build on a Linux runner), npm
provenance — which is why an exception mechanism is on the roadmap rather than a
blanket ban.

## `.automaker/settings.json` is committed per repo

The per-repo settings file pins the agent baseline. Committing it makes the
baseline reviewable and identical for every agent run against the repo. A repo
with no committed settings inherits whatever the host happens to have — which is
how a stale `claude-sonnet` model alias once 401'd every gateway call, because
the host's settings hadn't migrated to the `protolabs/*` tiers. Pinning the
baseline in-repo turns that class of failure into a reviewable diff.

## `.beads/beads.db` gitignored, `issues.jsonl` committed

beads keeps an authoritative SQLite store (`beads.db`) and a git-friendly
JSONL export (`issues.jsonl`). The `.db` is binary, conflict-prone, and
rebuildable from the JSONL; the JSONL merges cleanly and is the version-control
source of truth. So the `.db` is gitignored and the `.jsonl` is committed.
(The verifier checks *committed* state via the git index, not the filesystem —
a present-but-ignored `beads.db` on disk is correct and must not be flagged.)

## Detection at two levels

A repo gates its own PRs by running `verify-workspace-config` in CI. The fleet
is also swept centrally by the daily audit in protoWorkstacean. Two levels
because per-repo CI only protects repos that adopted the check, while the
central audit covers everything in the registry with zero per-repo setup —
including repos that haven't adopted the gate yet.
