# Branch Protection Defaults

A protoLabs convention for branch protection rulesets on GitHub. Codified as
`bin/apply-branch-protection.mjs` so any repo in the org can adopt it with one
command. Pairs with the existing release-notes generator — same package, same
install, same versioning.

## The rules

### 1. `required_status_checks` is for correctness, not advisory signals

Required status checks should gate on whether **the code works**: build,
test, lint. They should NOT contain LLM review bots (CodeRabbit, protoquinn,
SonarCloud, etc.), because:

- If the bot is rate-limited or down, every PR blocks until it recovers.
- If the bot's webhook races a fast-merging PR (CI finishes before the bot's
  status arrives), the PR sits `mergeStateStatus: BLOCKED` indefinitely until
  someone nudges it manually.
- Bots already have a legitimate veto path: a `CHANGES_REQUESTED` review
  blocks merge via `reviewDecision`. That's the right level. Comments are
  advisory, approvals are advisory, blocking happens explicitly.

| Belongs in `required_status_checks` | Doesn't belong                                          |
| ----------------------------------- | ------------------------------------------------------- |
| `build`                             | `CodeRabbit` (LLM advisory review)                      |
| `test`                              | `protoquinn[bot]` / any `[bot]` status                  |
| `checks` (lint/format)              | `SonarCloud Code Analysis`                              |
| Repo-specific rollups (opt-in)      | Any external service whose outage shouldn't halt merges |

### 2. `strict_required_status_checks_policy: false` for fast-moving repos

GitHub's "strict" mode (the default in the UI) forces a PR's branch to be
up-to-date with the base before merge. For solo-dev or small-team repos with
linear PR stacks, that's an N×CI-cycle drag: merge A → B is behind → rebase B
→ wait for CI → merge B → C is behind → repeat. A 5-PR stack can cost ~25
minutes of CI-wait instead of ~5 for a single cycle.

For repos with **1–3 contributors, linear sprint cadence, strong test
coverage**, flip strict to `false`. The actual safety net is the test suite —
stale branches that would break main usually fail their own CI before merge.

Keep strict `true` on repos with **5+ contributors or frequent parallel
feature branches** where semantic conflicts between stale branches are a real
risk.

### 3. `required_review_thread_resolution: true` — review comments must be resolved

Every ecosystem repo requires that **PR review threads are resolved before
merge** (the `pull_request` rule's `required_review_thread_resolution`). A
review comment from Quinn, CodeRabbit, or a human can't be silently merged
past — the thread must be addressed and resolved first. This is the gate that
makes review feedback actually count (CI-pass alone is not sufficient to merge).

It deliberately does **not** force `required_approving_review_count` — org
policy is that bots gate via review decision / thread resolution, not a forced
approval count (which a bot identity often can't satisfy). Existing PR-rule
params (approval counts, code-owner requirements) are preserved; only thread
resolution is turned on. Opt out per-repo with `--no-thread-resolution` if a
repo genuinely shouldn't gate on it.

## What this PRESERVES

Even with `strict: false`:

- PR required before merging to `main` ✓
- All required status checks must pass on the PR's last CI run ✓
- Force-push to `main` blocked ✓
- Branch deletion blocked ✓
- Auto-delete head branch on merge ✓

What changes:

- `mergeState: BEHIND` no longer blocks merge.
- The PR can merge whenever its **own** CI is green, regardless of how far
  `main` has advanced since the PR opened.

## Usage

Install once:

```bash
npm install -g @protolabsai/release-tools
# or run via npx
npx @protolabsai/release-tools apply-branch-protection --help
```

### Dry run (default — safe, prints diff and exits)

```bash
apply-branch-protection --repo protoLabsAI/myrepo --branch main
```

### Apply with defaults (loose + correctness-only + bots filtered)

```bash
apply-branch-protection --repo protoLabsAI/myrepo --branch main --apply
```

### Custom required checks

```bash
# Rust monorepo
apply-branch-protection \
  --repo protoLabsAI/myrepo \
  --required-checks cargo-test,cargo-clippy,cargo-fmt \
  --apply

# Add a repo-specific rollup
apply-branch-protection \
  --required-checks build,test,checks,ci-complete \
  --apply
```

### Strict mode (5+ contributors / parallel work)

```bash
apply-branch-protection --branch main --strict --apply
```

### Allow bot status checks (opt-out of the bot filter)

You almost never want this. The flag exists for repos that depend on a
non-LLM bot (e.g. a custom security scanner that exposes itself as a
`[bot]` status), and you've decided it really is a correctness gate.

```bash
apply-branch-protection \
  --required-checks build,test,checks,security-scanner \
  --allow-bot-checks \
  --apply
```

### Extra bot patterns for repo-specific advisory bots

```bash
apply-branch-protection \
  --extra-bot-patterns acme-llm-reviewer,custom-ai-bot \
  --apply
```

## How it works

1. Resolves the target repo from `--repo`, or from `git remote get-url origin`.
2. Finds the ruleset for the branch by name (`Protect <branch>`), or takes
   `--ruleset-id` directly. Bails if no matching ruleset exists — create one
   in the UI first.
3. Reads the ruleset, computes the recommended shape via
   `lib/branch-protection.mjs`, and prints a diff.
4. Without `--apply`, exits. With `--apply`, PUTs the patched ruleset back.

Read-only fields (`id`, `created_at`, `_links`, etc.) are stripped before the
PUT so GitHub doesn't 422. Known `integration_id` values for kept contexts
are preserved.

## When NOT to use the defaults

- **Heavily-contested `main` branches** (5+ contributors making parallel
  changes that touch overlapping code). Strict mode catches semantic
  conflicts the test suite would miss.
- **Repos where a bot really IS a correctness gate.** E.g. a security
  scanner that must clear before deploy. Use `--allow-bot-checks` and
  list it explicitly in `--required-checks`.
- **Repos with regulatory requirements** that mandate specific gating
  behavior. The defaults are calibrated for fast iteration, not compliance.

## Related issues

- [release-tools#6](https://github.com/protoLabsAI/release-tools/issues/6) — original strict/loose recommendation
- [release-tools#10](https://github.com/protoLabsAI/release-tools/issues/10) — bot-checks exclusion
- [protoMaker#3745](https://github.com/protoLabsAI/protoMaker/issues/3745) — first applied case (CodeRabbit dropped from `Protect main`)
