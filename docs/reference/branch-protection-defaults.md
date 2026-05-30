# Branch Protection Defaults

A protoLabs convention for branch protection rulesets on GitHub. Codified as
`bin/apply-branch-protection.mjs` so any repo in the org can adopt it with one
command. Pairs with the existing release-notes generator — same package, same
install, same versioning.

## The three rules

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

### 3. `required_approving_review_count: 0` — approvals advisory, CHANGES_REQUESTED is the veto

This rule only tunes a pull_request rule that **already exists** — it never
adds a PR requirement to a repo that lacks one.

The fleet runs on an automation identity (the same account that opens every
PR). GitHub **forbids approving your own pull request**, so a
`required_approving_review_count` of 1 is permanently unsatisfiable: every PR
sits at `reviewDecision: REVIEW_REQUIRED` with green CI and cannot merge.
Admins can bypass, but `--admin` is (correctly) blocked in our automation
harness, and toggling the ruleset for each merge is a band-aid.

The fix is to make the policy match what rule 1 already implies: **approvals
are advisory; a `CHANGES_REQUESTED` review is the explicit veto** (it blocks
via `reviewDecision` regardless of the count). So:

- `required_approving_review_count` → **0**. CI (rule 1) is the correctness
  gate. A reviewer — human or bot — who wants to stop a merge submits
  `CHANGES_REQUESTED`; that still blocks.
- `required_review_thread_resolution` → **false**. Leaving it on re-creates the
  exact bot-stall from rule 1: an unresolved CodeRabbit/SonarCloud review
  thread blocks merge indefinitely, even with zero required approvals.

| Want to merge                | Want to block a merge                     |
| ---------------------------- | ----------------------------------------- |
| Green CI (build/test/checks) | `CHANGES_REQUESTED` review (any reviewer) |
| —                            | A failing required status check           |

**Opt out** on repos with a real human-review workflow that can actually
supply approvals: `--required-reviews 1` (and `--require-thread-resolution`
if you want it). Those repos have a second human who can approve; the fleet
default assumes they don't.

## What this PRESERVES

Even with `strict: false`:

- PR required before merging to `main` ✓ (rule 3 tunes review count; it never
  removes the PR requirement)
- All required status checks must pass on the PR's last CI run ✓
- A `CHANGES_REQUESTED` review still blocks merge ✓ (the explicit veto)
- Force-push to `main` blocked ✓
- Branch deletion blocked ✓
- Auto-delete head branch on merge ✓

What changes:

- `mergeState: BEHIND` no longer blocks merge.
- The PR can merge whenever its **own** CI is green, regardless of how far
  `main` has advanced since the PR opened.
- A PR no longer needs an explicit **approval** to merge (rule 3) — green CI is
  enough, unless a reviewer actively requests changes.

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

### Require human approvals (opt-out of the 0-review default)

For a repo with a real second reviewer who can actually approve PRs:

```bash
apply-branch-protection --branch main --required-reviews 1 --require-thread-resolution --apply
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
- **Repos with a human review workflow.** If a real second reviewer approves
  PRs, keep a positive review count via `--required-reviews 1` rather than
  taking the 0-review fleet default.

## Related issues

- [release-tools#6](https://github.com/protoLabsAI/release-tools/issues/6) — original strict/loose recommendation
- [release-tools#10](https://github.com/protoLabsAI/release-tools/issues/10) — bot-checks exclusion
- [protoMaker#3745](https://github.com/protoLabsAI/protoMaker/issues/3745) — first applied case (CodeRabbit dropped from `Protect main`)
- [protoMaker#3985](https://github.com/protoLabsAI/protoMaker/issues/3985) — review-count stance (rule 3): automation-authored PRs can't self-approve
