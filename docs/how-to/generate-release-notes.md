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

## Drive the GitHub release body + a changelog from the same notes

The notes the LLM produces are the same text your GitHub release body and your
changelog want. Expose them once and fan them out — no second hand-written copy
to drift.

The action sets two step outputs: `notes` (markdown) and `highlights` (a JSON
array of the bullet lines, for structured changelogs).

```yaml
- id: notes
  uses: protoLabsAI/release-tools@v2
  with:
    version: ${{ steps.version.outputs.tag }}
    previous-version: ${{ steps.version.outputs.prev_tag }}
    # Optional: maintain a CHANGELOG.md (md) or a changelog.json (json) in-repo.
    changelog-file: CHANGELOG.md
    changelog-format: md
  env:
    GATEWAY_API_KEY: ${{ secrets.GATEWAY_API_KEY }}
    DISCORD_RELEASE_WEBHOOK: ${{ secrets.DISCORD_RELEASE_WEBHOOK }}

# Use the polished notes for the GitHub release body too.
- run: gh release edit "${{ steps.version.outputs.tag }}" --notes "${{ steps.notes.outputs.notes }}"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For a bespoke changelog (e.g. a marketing site's `changelog.json` with extra
fields), consume `steps.notes.outputs.highlights` and build the entry yourself.

### One generation, reused across jobs

Generate once and reuse the exact text in a later job (so the changelog entry and
the release body can never disagree): write it with `--out`, commit it, then pass
it back with `--notes-file` instead of re-running the LLM.

```bash
# job A (e.g. when the release PR is prepared)
npx @protolabsai/release-tools rewrite-release-notes v0.34.0 v0.33.0 \
  --out .release-notes/v0.34.0.md --changelog CHANGELOG.md

# job B (on the tag) — reuse, no second LLM call
npx @protolabsai/release-tools rewrite-release-notes v0.34.0 \
  --notes-file .release-notes/v0.34.0.md --post-discord
```
