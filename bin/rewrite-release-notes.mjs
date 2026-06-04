#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rewrites raw git commits into themed release notes via an OpenAI-compatible
 * LLM gateway, and (optionally) posts a Discord embed.
 *
 * Designed to run from a release CI job after a version tag has been created.
 *
 * Usage:
 *   rewrite-release-notes [version] [prev-version] [flags]
 *
 * Flags:
 *   --post-discord    Post the generated notes to DISCORD_RELEASE_WEBHOOK.
 *   --dry-run         Print the prompt that would be sent and exit.
 *   --help            Show this help and exit.
 *
 * Environment:
 *   GATEWAY_API_KEY            (required for non-dry-run) Bearer token for the gateway.
 *   OPENAI_BASE_URL           Override the gateway base URL.
 *                             Default: https://api.proto-labs.ai/v1
 *   RELEASE_NOTES_MODEL       Override the model alias.
 *                             Default: protolabs/fast
 *   DISCORD_RELEASE_WEBHOOK   (required with --post-discord) Discord webhook URL.
 *   RELEASE_NOTES_REPO        owner/name used to build the release link in
 *                             Discord embeds and the footer.
 *                             Default: derived from `git remote get-url origin`.
 *   RELEASE_NOTES_FOOTER      Override the Discord embed footer text.
 *                             Default: "protoLabs · <repo-name>"
 *   RELEASE_NOTES_TITLE       Override the Discord embed title text.
 *                             Default: "<repo-name> <version>"
 *
 * When called with no positional args, auto-detects the two most recent
 * semver-sorted tags (latest as `version`, previous as `prev-version`).
 */

import { execSync } from 'node:child_process';

// ─── Help ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  // The header comment block above is the help text. Emit lines 4–34 of this
  // file so `--help` mirrors the source documentation exactly.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const self = url.fileURLToPath(import.meta.url);
  const src = fs.readFileSync(self, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith(' * Rewrites'));
  const end = src.findIndex((l, i) => i > start && l.startsWith(' */'));
  const help = src
    .slice(start, end)
    .map((l) => l.replace(/^ \* ?/, ''))
    .join('\n');
  console.log(help);
  process.exit(0);
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getTags() {
  const tags = run('git tag --sort=-v:refname').split('\n').filter(Boolean);
  return { latest: tags[0], previous: tags[1] };
}

/**
 * The repo's root commit — the range start for a first release (no prior tag).
 * `--max-parents=0` can list more than one root for grafted/merged histories;
 * the last entry is the earliest, so the range covers the whole history.
 */
function getRootCommit() {
  try {
    const roots = run('git rev-list --max-parents=0 HEAD').split('\n').filter(Boolean);
    return roots[roots.length - 1] ?? null;
  } catch {
    return null;
  }
}

function getCommitsBetween(fromTag, toTag) {
  const SEPARATOR = '<<<COMMIT>>>';
  const log = run(
    `git log ${fromTag}..${toTag} --pretty=format:"${SEPARATOR}%s%n%b"`,
  );
  return log
    .split(SEPARATOR)
    .map((block) => block.trim())
    .filter(Boolean);
}

/**
 * Fallback: fetch commits from origin/dev that are reachable from fromTag but
 * not yet on main. Used when dev→main is squash-merged (collapsing individual
 * commits into a single "chore: release" commit that gets filtered out).
 */
function getCommitsFromDev(fromTag) {
  const SEPARATOR = '<<<COMMIT>>>';
  try {
    const log = run(
      `git log ${fromTag}..origin/dev --pretty=format:"${SEPARATOR}%s%n%b"`,
    );
    return log
      .split(SEPARATOR)
      .map((block) => block.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Derive owner/name from `git remote get-url origin` so callers don't have to
 * pass it explicitly. Supports both ssh (`git@github.com:o/r.git`) and https
 * (`https://github.com/o/r.git` or `.../o/r`) forms.
 */
function detectRepoSlug() {
  try {
    const url = run('git remote get-url origin');
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer for protoLabs, a developer tools company.
Your job is to transform raw git commit messages into polished release notes.

Voice: technical, direct, pragmatic. Speak to builders — assume they understand code.

Rules:
- Group into 2–4 themed sections with bold markdown headers (e.g. **Performance**, **Developer Experience**)
- One sentence per bullet, present tense, user-facing impact only
- Skip: merge commits, version bumps, CI config, internal chores, "promote" commits
- No marketing language, no AI hype words ("revolutionary", "game-changing", "powerful")
- No emojis anywhere
- Max 300 words total
- Output: one-line intro sentence, then the sections with bullets
- Do not include a version number in the output
- Always write the release notes — never ask clarifying questions or say you need more information
- If commits are sparse, infer user impact from what is present`;

function buildUserPrompt(version, previousVersion, commits) {
  const filtered = commits.filter((c) => {
    const subject = c.split('\n')[0].toLowerCase();
    return (
      !subject.startsWith('merge ') &&
      !subject.startsWith('chore: release') &&
      !subject.startsWith('promote') &&
      !subject.startsWith('chore: bump') &&
      c.length > 0
    );
  });

  const commitBlocks = filtered.join('\n---\n');

  return {
    prompt: `Write release notes for ${version} (previous: ${previousVersion}).

Each commit below includes the subject line and, where available, the commit body:

${commitBlocks}`,
    filteredCount: filtered.length,
  };
}

// ─── LLM call (protoLabs LiteLLM gateway, OpenAI-compatible) ─────────────────

const LLM_BASE_URL =
  process.env.OPENAI_BASE_URL || 'https://api.proto-labs.ai/v1';
// protolabs/fast is the default. The gateway separates the model's
// reasoning trace into `reasoning_content` and emits the polished
// answer in `content` — but only if `max_tokens` is high enough for
// the model to finish reasoning AND produce the final answer in the
// same call. Capping max_tokens too low truncates mid-reasoning and
// leaks unfinished thinking into `content`.
const LLM_MODEL = process.env.RELEASE_NOTES_MODEL || 'protolabs/fast';

async function callLLM(userPrompt) {
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!apiKey) throw new Error('GATEWAY_API_KEY is not set');

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      // Set high enough to fit reasoning + the final answer; capping
      // too low truncates mid-reasoning and leaks unfinished thinking
      // into `content` (see comment on LLM_MODEL above).
      max_tokens: 8192,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Discord ──────────────────────────────────────────────────────────────────

async function postToDiscord(repoSlug, version, notes) {
  const webhook = process.env.DISCORD_RELEASE_WEBHOOK;
  if (!webhook) throw new Error('DISCORD_RELEASE_WEBHOOK is not set');

  const releaseUrl = `https://github.com/${repoSlug}/releases/tag/${version}`;
  const truncated = notes.length > 3900 ? `${notes.slice(0, 3900)}\n...` : notes;
  const repoName = repoSlug.split('/').pop();
  const footer =
    process.env.RELEASE_NOTES_FOOTER || `protoLabs · ${repoName}`;
  // Lead the embed with the repo name alongside the version. With many repos'
  // releases flowing into one channel, version-only titles are ambiguous and
  // the footer alone isn't enough to tell them apart at a glance.
  const title = process.env.RELEASE_NOTES_TITLE || `${repoName} ${version}`;

  const payload = {
    embeds: [
      {
        title,
        url: releaseUrl,
        description: truncated,
        color: 5763719, // #5865F2 blurple
        footer: { text: footer },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const delays = [0, 3000, 10000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
      console.log(`Retrying Discord post (attempt ${attempt + 1})...`);
    }
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`Posted to Discord: ${version}`);
      return;
    }
    const err = await res.text();
    if (attempt === delays.length - 1) {
      throw new Error(`Discord webhook error ${res.status}: ${err}`);
    }
    console.warn(`Discord post failed (${res.status}), retrying...`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const postDiscord = args.includes('--post-discord');
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));

let version = positional[0];
let previousVersion = positional[1];

if (!version || !previousVersion) {
  const tags = getTags();
  version = version ?? tags.latest;
  previousVersion = previousVersion ?? tags.previous;
}

if (!version) {
  console.error('Could not determine the release version. Pass it explicitly.');
  process.exit(1);
}

// First release: there's no previous tag, so diff from the repo's root commit
// (the whole history is the range) instead of erroring out. Every consuming
// repo's first `v*` tag would otherwise fail here.
if (!previousVersion) {
  previousVersion = getRootCommit();
  if (previousVersion) {
    console.log(
      `No previous tag — first release; diffing from root commit ${previousVersion}.`,
    );
  }
}

if (!previousVersion) {
  console.error('Could not determine version tags. Pass them explicitly.');
  process.exit(1);
}

const repoSlug = process.env.RELEASE_NOTES_REPO || detectRepoSlug();
if (postDiscord && !repoSlug) {
  console.error(
    'Could not determine repo owner/name. Set RELEASE_NOTES_REPO=owner/name.',
  );
  process.exit(1);
}

console.log(`Generating release notes: ${previousVersion} → ${version}`);

const commits = getCommitsBetween(previousVersion, version);
console.log(`Found ${commits.length} commits`);

let { prompt: userPrompt, filteredCount } = buildUserPrompt(
  version,
  previousVersion,
  commits,
);

// Fallback: when dev→main is squash-merged, the tag-to-tag range only contains
// "chore: release" commits. Try origin/dev which preserves the individual
// commits.
if (filteredCount === 0) {
  console.log(
    'No user-facing commits in tag range — checking origin/dev for squash-merged commits...',
  );
  const devCommits = getCommitsFromDev(previousVersion);
  if (devCommits.length > 0) {
    const devResult = buildUserPrompt(version, previousVersion, devCommits);
    if (devResult.filteredCount > 0) {
      console.log(
        `Found ${devResult.filteredCount} user-facing commits on origin/dev.`,
      );
      userPrompt = devResult.prompt;
      filteredCount = devResult.filteredCount;
    }
  }
}

if (dryRun) {
  console.log('\n── System Prompt ──\n', SYSTEM_PROMPT);
  console.log('\n── User Prompt ──\n', userPrompt);
  process.exit(0);
}

// Skip if all commits were filtered out (maintenance releases, CI-only changes)
if (filteredCount === 0) {
  console.log('No user-facing commits — skipping Discord post.');
  process.exit(0);
}

const notes = await callLLM(userPrompt);
console.log('\n── Release Notes ──\n');
console.log(notes);

if (postDiscord) {
  await postToDiscord(repoSlug, version, notes);
}
