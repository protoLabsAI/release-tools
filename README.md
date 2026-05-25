# `@protolabsai/release-tools`

Reusable release-notes generator for protoLabs repos. Rewrites raw git commits
into themed release notes via the protoLabs LLM gateway and posts a Discord
embed. Ships as both an npm CLI and a composite GitHub Action.

[![npm](https://img.shields.io/npm/v/@protolabsai/release-tools.svg)](https://www.npmjs.com/package/@protolabsai/release-tools)

📚 **[Full documentation](./docs/index.md)** — organized by [Diátaxis](https://diataxis.fr/): tutorials, how-to guides, reference, and explanation. New here? Start with [Onboard a repo into the fleet](./docs/tutorials/onboard-a-repo.md).

## Why

Each protoLabs repo wants the same release ritual: tag → generate notes → post
to Discord. Copy-pasting the same `rewrite-release-notes.mjs` between repos
guarantees they drift. This package centralizes the script and exposes it via
two interfaces so any repo can drop it into their existing release workflow
without forking the logic.

## Use it as a GitHub Action (recommended)

```yaml
# .github/workflows/release.yml in your repo
- name: Generate + post release notes
  uses: protoLabsAI/release-tools@v1
  with:
    version: ${{ steps.version.outputs.tag }}
    previous-version: ${{ steps.version.outputs.prev_tag }}
  env:
    GATEWAY_API_KEY: ${{ secrets.GATEWAY_API_KEY }}
    DISCORD_RELEASE_WEBHOOK: ${{ secrets.DISCORD_RELEASE_WEBHOOK }}
```

### Inputs

| Input              | Required | Default                        | Description                                             |
| ------------------ | -------- | ------------------------------ | ------------------------------------------------------- |
| `version`          | yes      | —                              | Tag being released (e.g. `v0.34.0`)                     |
| `previous-version` | yes      | —                              | Previous tag for the diff range                         |
| `post-discord`     | no       | `'true'`                       | Post the notes to `DISCORD_RELEASE_WEBHOOK`             |
| `dry-run`          | no       | `'false'`                      | Print the prompt and exit; no LLM call, no Discord post |
| `model`            | no       | `protolabs/fast`               | LLM model alias                                         |
| `base-url`         | no       | `https://api.proto-labs.ai/v1` | Gateway base URL                                        |
| `repo`             | no       | `${{ github.repository }}`     | `owner/name` for the release URL + footer               |
| `footer`           | no       | `protoLabs · <repo-name>`      | Override Discord embed footer                           |

### Required secrets

- `GATEWAY_API_KEY` — bearer token for the protoLabs LLM gateway
- `DISCORD_RELEASE_WEBHOOK` — Discord webhook URL for the release channel

## Use it as a CLI

```bash
# Reads tags from the current repo, posts to Discord:
npx @protolabsai/release-tools rewrite-release-notes \
  v0.34.0 v0.33.0 --post-discord

# Dry-run — print the prompt that would be sent and exit:
npx @protolabsai/release-tools rewrite-release-notes \
  v0.34.0 v0.33.0 --dry-run
```

When called with no positional args, it auto-detects the two most recent
semver tags from `git tag --sort=-v:refname`.

### Environment variables

```
GATEWAY_API_KEY            (required for non-dry-run) Bearer token for the gateway.
OPENAI_BASE_URL           Override the gateway base URL.
                          Default: https://api.proto-labs.ai/v1
RELEASE_NOTES_MODEL       Override the model alias.
                          Default: protolabs/fast
DISCORD_RELEASE_WEBHOOK   (required with --post-discord) Discord webhook URL.
RELEASE_NOTES_REPO        owner/name used for the release URL + footer.
                          Default: derived from `git remote get-url origin`.
RELEASE_NOTES_FOOTER      Override the Discord embed footer.
                          Default: "protoLabs · <repo-name>"
```

## Behavior

1. Lists commits in the range `<previous-version>..<version>`.
2. Filters out merge / `chore: release` / `chore: bump` / `promote` commits.
3. **Squash-merge fallback:** if the tag-to-tag range yields nothing
   user-facing (because dev → main was squash-merged), falls back to
   `<previous-version>..origin/dev` which preserves the individual commits.
4. Sends the filtered commits to the configured LLM with a system prompt
   that enforces the protoLabs voice guide (themed sections, no marketing
   language, no emojis, max 300 words).
5. Prints the rendered notes to stdout.
6. With `--post-discord`, posts a single embed to
   `DISCORD_RELEASE_WEBHOOK` with retry-on-failure.

If all commits are filtered out, the script exits without calling the LLM or
posting to Discord — maintenance releases ("CI-only") don't blast the channel.

## Tauri release workflow

A reusable workflow for the **pre-release** half of the desktop pipeline:
build, sign, notarize, and publish a Tauri 2 app across macOS (universal),
Windows, and Linux. Same lifecycle as `rewrite-release-notes`, just upstream
of it.

### Use it

```yaml
# .github/workflows/build-desktop.yml in your repo
name: Build Desktop App

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

jobs:
  desktop:
    uses: protoLabsAI/release-tools/.github/workflows/tauri-release.yml@v1
    secrets: inherit
    with:
      project-path: apps/desktop
      app-identifier: studio.protolabs.example
      r2-bucket: example-desktop-releases
      r2-public-base-url: https://dl.example.studio
      pre-build-command: pnpm build # optional: workspace builds before tauri-action
```

### Inputs

| Input                  | Required | Default                                 | Description                                                           |
| ---------------------- | -------- | --------------------------------------- | --------------------------------------------------------------------- |
| `project-path`         | yes      | —                                       | Directory containing `src-tauri/` (e.g. `apps/desktop`).              |
| `app-identifier`       | yes      | —                                       | CFBundleIdentifier (e.g. `studio.protolabs.example`).                 |
| `r2-bucket`            | yes      | —                                       | Cloudflare R2 bucket for binaries + `latest.json`.                    |
| `r2-public-base-url`   | yes      | —                                       | Public-read base URL of the bucket. Embedded in the updater manifest. |
| `node-version`         | no       | `'22'`                                  | Node.js version for the build.                                        |
| `pnpm-version`         | no       | `'9.15.0'`                              | pnpm version. Set `''` to use npm.                                    |
| `pre-build-command`    | no       | `''`                                    | Shell command run after install, before `tauri-action`.               |
| `draft-github-release` | no       | `true`                                  | Create a draft Release with all artifacts attached.                   |
| `release-notes-text`   | no       | `'See the GitHub Release for details.'` | Embedded in `latest.json` (Tauri updater shows this in the prompt).   |

### Required secrets (pass via `secrets: inherit`)

**macOS code signing:**

- `APPLE_CERTIFICATE` — base64 of your Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — `.p12` export password
- `APPLE_SIGNING_IDENTITY` — `Developer ID Application: Your Name (TEAMID)`
- `APPLE_TEAM_ID` — 10-char Team ID
- `KEYCHAIN_PASSWORD` — any random string; used for the temporary CI keychain

**macOS notarization (pick one path):**

- App Store Connect API key (preferred): `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_BASE64` — store the `.p8` file as base64 (`base64 -i AuthKey_XYZ.p8 | pbcopy`); the workflow decodes it to disk and points `APPLE_API_KEY_PATH` at the file.
- App-specific password (fallback): `APPLE_ID`, `APPLE_PASSWORD`

**Windows code signing (SSL.com eSigner):**

- `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_CREDENTIAL_ID`, `ESIGNER_TOTP_SECRET`

**Tauri updater signing:**

- `TAURI_SIGNING_PRIVATE_KEY` — generated via `tauri signer generate`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

**Cloudflare R2 publish:**

- `CLOUDFLARE_API_TOKEN` — R2 Object Read & Write on your bucket
- `R2_ACCOUNT_ID`

### Updater manifest CLI

The `publish` job calls `build-updater-manifest` (the second binary this
package exports) to emit a `latest.json` for the in-app Tauri updater.
You can also run it directly:

```bash
npx -p @protolabsai/release-tools build-updater-manifest \
  --version 0.2.1 \
  --dist ./artifacts \
  --base-url https://dl.example.studio/0.2.1 \
  --out ./latest.json
```

Walks the `--dist` directory, finds platform binaries + their `.sig` files,
and writes a manifest in the exact shape Tauri's updater expects. Exits
non-zero if any binary is missing its signature, so the `publish` job fails
loudly when signing didn't run.

## Branch protection defaults

`apply-branch-protection` applies the protoLabs recommended branch protection
ruleset to a repo. Two opinions, both off-by-default in GitHub's UI:

1. **`required_status_checks` is for correctness, not advisory signals.** Drop
   LLM review bots (CodeRabbit, protoquinn[bot], etc.) from required checks.
   Bots gate via `reviewDecision` — silence shouldn't block merges.
2. **`strict_required_status_checks_policy: false`** for fast-moving repos with
   linear PR stacks. Strict mode forces an N×CI-cycle drag on stacked work.

```bash
# Dry-run against the current repo's main branch
npx @protolabsai/release-tools apply-branch-protection

# Apply the defaults to a specific repo
npx @protolabsai/release-tools apply-branch-protection \
  --repo protoLabsAI/myrepo \
  --branch main \
  --apply

# Custom required checks (Rust monorepo)
npx @protolabsai/release-tools apply-branch-protection \
  --required-checks cargo-test,cargo-clippy,cargo-fmt \
  --apply
```

See [`docs/branch-protection-defaults.md`](./docs/reference/branch-protection-defaults.md)
for the full rationale, the "when not to use the defaults" list, and the flag
reference.

## Workspace config standard

`verify-workspace-config` checks a repo against the protoLabs baseline for
`.beads/` (issue tracker) and `.automaker/` (board) config that every
fleet-watched repo should carry — plus a self-hosted-runner check so no repo
silently burns GitHub-hosted minutes.

```bash
# Local — in a repo's CI on PR (exits non-zero on error-severity drift)
npx @protolabsai/release-tools verify-workspace-config

# Remote — central fleet audit of any watched repo (no clone)
npx @protolabsai/release-tools verify-workspace-config --repo protoLabsAI/protoMaker
npx @protolabsai/release-tools verify-workspace-config --repo protoLabsAI/protoCLI --json --warn-only
```

See [`docs/workspace-config-standard.md`](./docs/reference/workspace-config-standard.md)
for the full rule table and remediation steps.

## Development

```bash
npm install
node bin/rewrite-release-notes.mjs --help
node bin/build-updater-manifest.mjs --help
node bin/apply-branch-protection.mjs --help
node bin/verify-workspace-config.mjs --help
npm test
```

CI runs `node --check`, `--help`, and `--dry-run` smoke tests on every push.

## Releasing

Bump `version` in `package.json` on `main`. The Release workflow:

1. Tags the commit `vX.Y.Z`.
2. Publishes to npm with provenance.
3. Creates a GitHub release with auto-generated notes.

Re-running the workflow on a commit whose tag already exists is a no-op.

## License

Apache-2.0
