# release-tools docs

Tooling and conventions for the protoLabs release + fleet-management surface.
Organized by the [Diátaxis](https://diataxis.fr/) framework — four doc types,
each serving one need. Start with the type that matches what you're doing.

## Tutorials — learn by doing

Guided, start-to-finish, guaranteed to work. Read these first if you're new.

- [Onboard a repo into the fleet](./tutorials/onboard-a-repo.md) — take a brand-new GitHub repo from zero to fleet-managed, conformant, and protected.

## How-to guides — accomplish a task

You know what you want; these are the steps.

- [Generate + post release notes](./how-to/generate-release-notes.md)
- [Apply branch protection](./how-to/apply-branch-protection.md)
- [Verify & fix workspace config](./how-to/verify-and-fix-workspace-config.md)
- [Audit the whole fleet for drift](./how-to/audit-the-fleet.md)

## Reference — look something up

Complete, terse, accurate.

- [CLI reference](./reference/cli.md) — every command, flag, exit code, env var.
- [Workspace-config standard](./reference/workspace-config-standard.md) — the `.beads/` + `.automaker/` + runner rule table.
- [Branch-protection defaults](./reference/branch-protection-defaults.md) — the ruleset shape and the two policy rules.

## Explanation — understand why

The reasoning behind the conventions.

- [Proto release conventions](./explanation/proto-release-conventions.md) — why owned runners, why bots aren't required checks, why settings are committed, why beads.db is gitignored.

## The pieces at a glance

| Tool                      | One line                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `rewrite-release-notes`   | Turn raw commits into themed release notes + Discord embed                           |
| `build-updater-manifest`  | Build the Tauri auto-updater `latest.json` from signed artifacts                     |
| `apply-branch-protection` | Apply the org ruleset defaults (loose policy, correctness-only checks, no bot gates) |
| `verify-workspace-config` | Check a repo (or the fleet) against the `.beads/`+`.automaker/`+runner standard      |
| `init-workspace-config`   | Scaffold a repo to that standard (idempotent)                                        |
