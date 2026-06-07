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
 *   --post-discord            Post the generated notes to DISCORD_RELEASE_WEBHOOK.
 *   --out <file>              Write the notes (markdown) to <file>.
 *   --changelog <file>        Prepend a dated entry to a changelog file.
 *   --changelog-format <fmt>  md (default) | json. md prepends a
 *                             "## <version> — <date>" section; json prepends
 *                             { version, date, notes, highlights } to a JSON array.
 *   --date <YYYY-MM-DD>       Changelog entry date. Default: today (UTC).
 *   --notes-file <file>       Use notes from <file> instead of calling the LLM
 *                             (reuse a prior job's notes; also makes the file
 *                             outputs runnable without a gateway key).
 *   --dry-run                 Print the prompt that would be sent and exit.
 *   --help                    Show this help and exit.
 *
 * GitHub Actions: when $GITHUB_OUTPUT is set, the generated `notes` (markdown)
 * and `highlights` (JSON array of the bullet lines) are exposed as step outputs.
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
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

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

// ─── Changelog + Action outputs ───────────────────────────────────────────────
//
// The notes the LLM produces are useful beyond Discord: a repo's GitHub release
// body, a CHANGELOG.md, or a marketing changelog all want the same polished
// text. These helpers expose it (as Action outputs + optional files) so a single
// generation drives every changelog surface — see docs/how-to/generate-release-notes.md.

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Flatten the generated markdown into a list of user-facing change lines — the
 * bullet items, with the `- `/`* ` marker stripped. Section headers + the intro
 * sentence are dropped. Repos that keep a structured changelog (one entry = an
 * array of change strings) build their entry from this.
 */
function extractHighlights(notes) {
  return notes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

/** Prepend a dated section, keeping a leading `# H1` title at the very top. */
function prependMarkdownChangelog(existing, version, date, notes) {
  const entry = `## ${version} — ${date}\n\n${notes.trim()}\n`;
  const text = existing ?? '';
  const head = text.match(/^(#[^\n]*\n+)/); // a leading "# Changelog" title
  if (head) {
    return `${head[1]}${entry}\n${text.slice(head[1].length)}`;
  }
  return text.trim() ? `${entry}\n${text}` : `# Changelog\n\n${entry}`;
}

/** Prepend (or replace the same version) in a JSON-array changelog file. */
function upsertJsonChangelog(existingText, entry) {
  let arr = [];
  if (existingText?.trim()) {
    try {
      const parsed = JSON.parse(existingText);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // Malformed — start fresh rather than drop the release; the caller commits
      // the result, so a bad file surfaces in review instead of silently losing.
    }
  }
  const rest = arr.filter((e) => e?.version !== entry.version);
  return `${JSON.stringify([entry, ...rest], null, 2)}\n`;
}

/** Expose the notes + highlights as GitHub Actions step outputs, if running there. */
function writeGithubOutputs(notes, highlights) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const D = 'RELNOTES_EOF';
  appendFileSync(
    out,
    `notes<<${D}\n${notes}\n${D}\nhighlights=${JSON.stringify(highlights)}\n`,
  );
  console.log('Wrote `notes` + `highlights` to $GITHUB_OUTPUT');
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
// Flags that take a value (the next token), so it isn't mistaken for a
// positional version arg.
const VALUE_FLAGS = new Set([
  '--out',
  '--changelog',
  '--changelog-format',
  '--notes-file',
  '--date',
]);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) opts[a] = args[++i];
  else if (a.startsWith('--')) opts[a] = true;
  else positional.push(a);
}
const postDiscord = !!opts['--post-discord'];
const dryRun = !!opts['--dry-run'];
const outFile = opts['--out'];
const changelogFile = opts['--changelog'];
const changelogFormat = opts['--changelog-format'] || 'md';
const notesFile = opts['--notes-file'];
const entryDate = opts['--date'] || today();

let version = positional[0];
let previousVersion = positional[1];

// Version is always needed; the commit range (previousVersion) only when we
// generate from git. Resolve from tags lazily so the --notes-file path works in
// a plain (non-git) checkout too.
if (!version) {
  version = getTags().latest;
}
if (!version) {
  console.error('Could not determine the release version. Pass it explicitly.');
  process.exit(1);
}

const repoSlug = process.env.RELEASE_NOTES_REPO || detectRepoSlug();
if (postDiscord && !repoSlug) {
  console.error(
    'Could not determine repo owner/name. Set RELEASE_NOTES_REPO=owner/name.',
  );
  process.exit(1);
}

// Emit the notes to every requested sink: stdout, Action outputs, a notes file,
// a changelog file, and/or Discord. Shared by the reuse path and the LLM path.
async function emitNotes(notes) {
  console.log('\n── Release Notes ──\n');
  console.log(notes);

  const highlights = extractHighlights(notes);
  writeGithubOutputs(notes, highlights);

  if (outFile) {
    writeFileSync(outFile, `${notes.trim()}\n`);
    console.log(`Wrote notes → ${outFile}`);
  }

  if (changelogFile) {
    const existing = existsSync(changelogFile)
      ? readFileSync(changelogFile, 'utf8')
      : '';
    const updated =
      changelogFormat === 'json'
        ? upsertJsonChangelog(existing, {
            version,
            date: entryDate,
            notes: notes.trim(),
            highlights,
          })
        : prependMarkdownChangelog(existing, version, entryDate, notes);
    writeFileSync(changelogFile, updated);
    console.log(`Updated changelog → ${changelogFile} (${changelogFormat})`);
  }

  if (postDiscord) {
    await postToDiscord(repoSlug, version, notes);
  }
}

// Reuse pre-generated notes (a prior job's output; also lets the file/changelog
// paths run without a gateway key) — no git range or LLM call needed.
if (notesFile) {
  console.log(`Using notes from ${notesFile}`);
  await emitNotes(readFileSync(notesFile, 'utf8').trim());
  process.exit(0);
}

if (!previousVersion) {
  previousVersion = getTags().previous;
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

// Skip when every commit was filtered out (maintenance / CI-only releases).
if (filteredCount === 0) {
  console.log('No user-facing commits — nothing to generate.');
  process.exit(0);
}

await emitNotes(await callLLM(userPrompt));
