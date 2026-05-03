#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the JSON manifest the Tauri auto-updater pulls from to learn about
 * a new release. Walks a directory of release artifacts (the output of a
 * tauri-action build), finds each platform's bundle + matching .sig file,
 * and emits a `latest.json` shaped exactly the way Tauri's updater expects.
 *
 * Designed to run in CI between artifact assembly and uploading the manifest
 * to a public bucket (R2, S3, etc.) that the in-app updater fetches.
 *
 * Usage:
 *   build-updater-manifest --version <v> --dist <dir> --base-url <url> [flags]
 *
 * Required flags:
 *   --version <v>      Semver being released (e.g. 0.2.1). Strip any leading "v".
 *   --dist <dir>       Directory containing the downloaded artifacts.
 *                      Walked recursively for *.dmg, *.app.tar.gz, *.nsis.zip,
 *                      *.exe, *.AppImage, plus matching .sig files.
 *   --base-url <url>   Public-read base URL where the binaries land
 *                      (e.g. https://dl.example.com/0.2.1).
 *
 * Optional flags:
 *   --out <path>       Where to write the manifest. Default: ./latest.json.
 *   --notes <text>     Release-notes text embedded in the manifest.
 *                      Default: "See the GitHub Release for details."
 *   --pub-date <iso>   Override the pub_date timestamp. Default: now (UTC ISO).
 *   --help             Show this help and exit.
 *
 * Platform detection (filename-based, conservative):
 *   darwin-aarch64   *.app.tar.gz   built for aarch64-apple-darwin
 *   darwin-x86_64    *.app.tar.gz   built for x86_64-apple-darwin
 *   darwin-universal *.app.tar.gz   built for universal-apple-darwin
 *                                   (emitted as both darwin-aarch64 and darwin-x86_64)
 *   windows-x86_64   *-setup.nsis.zip OR *.msi.zip
 *   linux-x86_64     *.AppImage.tar.gz
 *
 * The script ignores .dmg / .exe / .AppImage on their own — the updater
 * downloads the .tar.gz / .zip equivalents because they're seekable +
 * signature-verifiable. Make sure tauri-action emitted those (it does by
 * default when the updater plugin is enabled).
 *
 * Exits non-zero if any platform that has a binary is missing its signature.
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

// ─── Help ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const url = await import('node:url');
  const self = url.fileURLToPath(import.meta.url);
  const src = readFileSync(self, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith(' * Builds'));
  const end = src.findIndex((l, i) => i > start && l.startsWith(' */'));
  const help = src
    .slice(start, end)
    .map((l) => l.replace(/^ \* ?/, ''))
    .join('\n');
  console.log(help);
  process.exit(0);
}

// ─── Arg parsing (no deps) ───────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const version = String(args.version || '').replace(/^v/, '');
const distDir = args.dist;
const baseUrl = String(args['base-url'] || '').replace(/\/+$/, '');
const outPath = args.out || './latest.json';
const notes = args.notes || 'See the GitHub Release for details.';
const pubDate = args['pub-date'] || new Date().toISOString();

if (!version || !distDir || !baseUrl) {
  console.error(
    'Error: --version, --dist, and --base-url are required. Run with --help for usage.',
  );
  process.exit(2);
}

// ─── Walk the dist directory ─────────────────────────────────────────────────

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const name of entries) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const files = walk(distDir);

// ─── Classify each binary by platform ────────────────────────────────────────

/**
 * Returns the list of (platform-key, binary-path) tuples for a given file.
 * A universal mac bundle expands to two platform keys.
 */
function platformsFor(filePath) {
  const name = basename(filePath);
  // macOS .app bundle
  if (name.endsWith('.app.tar.gz')) {
    if (filePath.includes('universal-apple-darwin') || /universal/i.test(name)) {
      return ['darwin-aarch64', 'darwin-x86_64'];
    }
    if (filePath.includes('aarch64-apple-darwin') || /aarch64|arm64/i.test(name)) {
      return ['darwin-aarch64'];
    }
    if (filePath.includes('x86_64-apple-darwin') || /x86_64|x64/i.test(name)) {
      return ['darwin-x86_64'];
    }
    return ['darwin-aarch64']; // safe default for native runner builds
  }
  // Windows NSIS installer (zipped for the updater)
  if (name.endsWith('-setup.nsis.zip') || name.endsWith('.msi.zip')) {
    return ['windows-x86_64'];
  }
  // Linux AppImage
  if (name.endsWith('.AppImage.tar.gz')) {
    return ['linux-x86_64'];
  }
  return [];
}

const platforms = {};
const missingSigs = [];

for (const f of files) {
  const keys = platformsFor(f);
  if (keys.length === 0) continue;
  const sigPath = `${f}.sig`;
  let signature;
  try {
    signature = readFileSync(sigPath, 'utf8').trim();
  } catch {
    missingSigs.push(relative(distDir, f));
    continue;
  }
  const url = `${baseUrl}/${basename(f)}`;
  for (const key of keys) {
    if (platforms[key]) {
      console.warn(
        `Warning: duplicate binary for ${key}: ${relative(distDir, f)} (keeping first)`,
      );
      continue;
    }
    platforms[key] = { signature, url };
  }
}

if (missingSigs.length > 0) {
  console.error(
    `Error: ${missingSigs.length} binary file(s) have no matching .sig:\n  ${missingSigs.join('\n  ')}\n` +
      'tauri-action emits .sig files when TAURI_SIGNING_PRIVATE_KEY is set on the build job. ' +
      'Confirm the secret is wired and the bundle.targets list includes the updater format ' +
      '(.app.tar.gz on macOS, *-setup.nsis.zip on Windows, *.AppImage.tar.gz on Linux).',
  );
  process.exit(3);
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `Error: no recognized platform binaries found under ${distDir}. ` +
      'The script looks for *.app.tar.gz, *-setup.nsis.zip, *.msi.zip, *.AppImage.tar.gz.',
  );
  process.exit(3);
}

// ─── Emit the manifest ───────────────────────────────────────────────────────

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `Wrote ${outPath} for v${version} (${Object.keys(platforms).length} platform(s): ${Object.keys(
    platforms,
  )
    .sort()
    .join(', ')})`,
);
