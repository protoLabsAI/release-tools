# `@protolabsai/release-tools`

Reusable release-notes generator for protoLabs repos. Rewrites raw git commits
into themed release notes via the protoLabs LLM gateway and posts a Discord
embed. Ships as both an npm CLI and a composite GitHub Action.

[![npm](https://img.shields.io/npm/v/@protolabsai/release-tools.svg)](https://www.npmjs.com/package/@protolabsai/release-tools)

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

| Input              | Required | Default                                   | Description                                                                  |
| ------------------ | -------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `version`          | yes      | —                                         | Tag being released (e.g. `v0.34.0`)                                          |
| `previous-version` | yes      | —                                         | Previous tag for the diff range                                              |
| `post-discord`     | no       | `'true'`                                  | Post the notes to `DISCORD_RELEASE_WEBHOOK`                                  |
| `dry-run`          | no       | `'false'`                                 | Print the prompt and exit; no LLM call, no Discord post                      |
| `model`            | no       | `protolabs/fast`                          | LLM model alias                                                              |
| `base-url`         | no       | `https://api.proto-labs.ai/v1`            | Gateway base URL                                                             |
| `repo`             | no       | `${{ github.repository }}`                | `owner/name` for the release URL + footer                                    |
| `footer`           | no       | `protoLabs · <repo-name>`                 | Override Discord embed footer                                                |

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

## Development

```bash
npm install
node bin/rewrite-release-notes.mjs --help
node bin/rewrite-release-notes.mjs --dry-run
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
