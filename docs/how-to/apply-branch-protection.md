# Apply branch protection

Bring a repo's branch ruleset to the protoLabs defaults: loose policy,
correctness-only required checks, bot reviewers excluded.

## Dry run first (default — prints the diff, writes nothing)

```bash
npx @protolabsai/release-tools apply-branch-protection --repo protoLabsAI/myrepo --branch main
```

## Apply

```bash
npx @protolabsai/release-tools apply-branch-protection --repo protoLabsAI/myrepo --branch main --apply
```

## Common variants

```bash
# Rust monorepo — custom required checks
apply-branch-protection --required-checks cargo-test,cargo-clippy,cargo-fmt --apply

# Larger team — enable strict (branch must be up to date with base)
apply-branch-protection --branch main --strict --apply

# Keep a non-LLM bot check required (rare)
apply-branch-protection --required-checks build,test,checks,security-scanner --allow-bot-checks --apply
```

If it reports "No ruleset found", create a `Protect <branch>` ruleset in the
repo's GitHub settings first, then re-run. Rationale + the full rule set:
[branch-protection-defaults](../reference/branch-protection-defaults.md).
