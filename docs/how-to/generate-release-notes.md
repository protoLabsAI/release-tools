# Generate + post release notes

Turn the commit range between two tags into themed release notes and post a
Discord embed.

## As a GitHub Action (recommended)

```yaml
# .github/workflows/release.yml
- uses: protoLabsAI/release-tools@v1
  with:
    version: ${{ steps.version.outputs.tag }}
    previous-version: ${{ steps.version.outputs.prev_tag }}
  env:
    GATEWAY_API_KEY: ${{ secrets.GATEWAY_API_KEY }}
    DISCORD_RELEASE_WEBHOOK: ${{ secrets.DISCORD_RELEASE_WEBHOOK }}
```

## As a CLI

```bash
# Explicit range, post to Discord
npx @protolabsai/release-tools rewrite-release-notes v0.34.0 v0.33.0 --post-discord

# Auto-detect the two most recent semver tags
npx @protolabsai/release-tools rewrite-release-notes --post-discord

# Dry run — print the prompt, no LLM call, no post
npx @protolabsai/release-tools rewrite-release-notes v0.34.0 v0.33.0 --dry-run
```

Required env: `GATEWAY_API_KEY` (LLM gateway), `DISCORD_RELEASE_WEBHOOK` (with
`--post-discord`). See the [CLI reference](../reference/cli.md#rewrite-release-notes)
for all flags.
