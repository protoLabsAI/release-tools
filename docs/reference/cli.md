# CLI reference

Every command in `@protolabsai/release-tools`. Run any with `--help` for the
inline version. Install once (`npm i -g @protolabsai/release-tools`) or invoke
via `npx @protolabsai/release-tools <command>`.

| Command                                               | Purpose                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| [`rewrite-release-notes`](#rewrite-release-notes)     | Themed release notes + Discord embed from a commit range |
| [`build-updater-manifest`](#build-updater-manifest)   | Tauri auto-updater `latest.json` from signed artifacts   |
| [`apply-branch-protection`](#apply-branch-protection) | Apply org branch-protection ruleset defaults             |
| [`verify-workspace-config`](#verify-workspace-config) | Check a repo/fleet against the workspace-config standard |
| [`init-workspace-config`](#init-workspace-config)     | Scaffold a repo to that standard                         |

---

## rewrite-release-notes

`rewrite-release-notes [version] [previous-version] [flags]`

Auto-detects the two most recent semver tags when positionals are omitted.

| Flag                  | Default                        | Description                                     |
| --------------------- | ------------------------------ | ----------------------------------------------- |
| `--post-discord`      | off                            | Post the embed to `DISCORD_RELEASE_WEBHOOK`     |
| `--dry-run`           | off                            | Print the prompt and exit; no LLM call, no post |
| `--model <alias>`     | `protolabs/fast`               | Gateway model alias                             |
| `--base-url <url>`    | `https://api.proto-labs.ai/v1` | Gateway base URL                                |
| `--repo <owner/name>` | from git remote                | Repo for the release URL + footer               |

Env: `GATEWAY_API_KEY` (required for non-dry-run), `OPENAI_BASE_URL`,
`RELEASE_NOTES_MODEL`, `DISCORD_RELEASE_WEBHOOK`, `RELEASE_NOTES_REPO`,
`RELEASE_NOTES_FOOTER`.

---

## build-updater-manifest

`build-updater-manifest --version <v> --dist <dir> --base-url <url> [flags]`

| Flag               | Required | Description                                         |
| ------------------ | -------- | --------------------------------------------------- |
| `--version <v>`    | yes      | Semver being released (strip leading `v`)           |
| `--dist <dir>`     | yes      | Directory of release artifacts (walked recursively) |
| `--base-url <url>` | yes      | Public-read base URL where binaries land            |
| `--out <path>`     | no       | Manifest output path (default `./latest.json`)      |
| `--notes <text>`   | no       | Release-notes text in the manifest                  |
| `--pub-date <iso>` | no       | Override pub_date (default: now)                    |

Platform detection is filename-based (`.app.tar.gz`, `*-setup.nsis.zip`,
`.AppImage.tar.gz`) with matching `.sig` files.

---

## apply-branch-protection

`apply-branch-protection [flags]` — dry-run by default; `--apply` to PUT.

| Flag                          | Default             | Description                                   |
| ----------------------------- | ------------------- | --------------------------------------------- |
| `--repo <owner/name>`         | git remote          | Target repo                                   |
| `--branch <name>`             | `main`              | Protected branch                              |
| `--ruleset-id <id>`           | by-name lookup      | Apply to a specific ruleset                   |
| `--required-checks <list>`    | `build,test,checks` | Comma-separated contexts                      |
| `--strict`                    | off (loose)         | Enable `strict_required_status_checks_policy` |
| `--allow-bot-checks`          | off                 | Keep LLM-bot status checks required           |
| `--extra-bot-patterns <list>` | —                   | Extra case-insensitive bot substrings         |
| `--apply`                     | off                 | PUT the patched ruleset                       |
| `--json`                      | off                 | Print the would-be PUT body                   |

Defaults + rationale: [branch-protection-defaults](./branch-protection-defaults.md).

---

## verify-workspace-config

`verify-workspace-config [flags]` — local mode by default; `--repo` for remote.

| Flag                  | Default        | Description                                   |
| --------------------- | -------------- | --------------------------------------------- |
| `--repo <owner/name>` | (local)        | Audit a remote repo via `gh api`, no clone    |
| `--ref <ref>`         | default branch | Git ref for remote mode                       |
| `--root <path>`       | cwd            | Local repo root                               |
| `--warn-only`         | off            | Exit 0 even with errors (advisory)            |
| `--json`              | off            | Machine-readable report for fleet aggregation |

Exit codes: `0` conformant (or `--warn-only`), `1` error-severity drift, `2`
usage/IO error. Local mode checks **git-tracked** files (committed), not
filesystem presence. Rule table: [workspace-config-standard](./workspace-config-standard.md). Annotate a legit hosted runner with `# workspace-config: allow-hosted-runner <reason>` to except it; exceptions surface in `--json` as `runnerExceptions`.

---

## init-workspace-config

`init-workspace-config [flags]` — scaffold a checkout to the standard. Idempotent.

| Flag            | Default | Description                   |
| --------------- | ------- | ----------------------------- |
| `--root <path>` | cwd     | Repo root                     |
| `--dry-run`     | off     | Print the plan; write nothing |

Creates an empty `.beads/issues.jsonl`, a minimal `.automaker/settings.json`
(`{ "version": 1 }`), and the required `.gitignore` lines. Does **not** edit
workflow runner labels (per-workflow code edit; `verify-workspace-config`
flags those).
