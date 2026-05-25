# Onboard a repo into the fleet

By the end of this tutorial you'll have taken a brand-new GitHub repo and made
it a fully fleet-managed protoLabs project: registered with the agent fleet,
reviewed by Quinn, protected, and conformant to the workspace-config standard.
It takes about five minutes.

This is the manual walk-through so you understand each piece. In practice the
protoMaker `onboard_project` skill runs all of this for you — but knowing what
it does makes the automation legible.

## Prerequisites

- `gh` CLI authenticated with repo admin on the target repo
- Node 20+
- The repo exists on GitHub (we'll use `protoLabsAI/example-repo` as a stand-in)

## 1. Scaffold the workspace-config baseline

Clone the repo and scaffold its `.beads/` + `.automaker/` baseline:

```bash
git clone https://github.com/protoLabsAI/example-repo
cd example-repo
npx -y @protolabsai/release-tools init-workspace-config
```

You'll see it create `.beads/issues.jsonl`, `.automaker/settings.json`, and
patch `.gitignore`. Commit them:

```bash
git add .beads/issues.jsonl .automaker/settings.json .gitignore
git commit -m "chore: scaffold workspace-config standard"
git push
```

## 2. Apply branch protection

```bash
npx -y @protolabsai/release-tools apply-branch-protection \
  --repo protoLabsAI/example-repo --branch main --apply
```

If it reports "No ruleset found", create a `Protect main` ruleset in the repo's
GitHub settings (Settings → Rules) first, then re-run. Defaults: loose policy,
required checks `build`/`test`/`checks`, bot reviewers excluded.

## 3. Register with the fleet

Fleet registration (the Quinn webhook + the `workspace/projects.yaml` entry) is
handled by protoWorkstacean's onboarding pipeline. Trigger it:

```bash
curl -sS -X POST "$WORKSTACEAN_PUBLIC_URL/api/onboard" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"protolabsai-example-repo","title":"example-repo","github":"protoLabsAI/example-repo"}'
```

This registers the GitHub webhook (so Quinn reviews every PR) and upserts the
project into the routing index — both idempotent.

## 4. Verify it's conformant

```bash
npx -y @protolabsai/release-tools verify-workspace-config --repo protoLabsAI/example-repo
```

Expect `✅ conformant`. If you see a `workflows-use-owned-runners` error, one of
the repo's workflows uses a GitHub-hosted runner — change its `runs-on:` to
`namespace-profile-protolabs-linux` and push.

## What you built

The repo now has: a committed issue tracker (`.beads/`), a committed agent
baseline (`.automaker/settings.json`), correct `.gitignore`, branch protection,
a Quinn review webhook, and a fleet registry entry. The daily
[fleet audit](../how-to/audit-the-fleet.md) will keep it honest.

## Next steps

- [Verify & fix workspace config](../how-to/verify-and-fix-workspace-config.md) — for repos that drift later
- [Proto release conventions](../explanation/proto-release-conventions.md) — why the standard is shaped this way
