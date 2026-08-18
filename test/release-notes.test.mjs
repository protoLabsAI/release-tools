import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFallbackNotes,
  extractHighlights,
  normalizeListMarkers,
} from '../lib/release-notes.mjs';

test('buildFallbackNotes lists one bullet per commit subject', () => {
  const out = buildFallbackNotes('@protolabsai/ui@0.35.0', [
    'fix(app-shell): let the left column shrink to minLeftWidth\n\nbody text here',
    'feat(ui): something else',
  ]);
  assert.match(out, /\*\*@protolabsai\/ui@0\.35\.0\*\*/);
  assert.match(out, /- fix\(app-shell\): let the left column shrink to minLeftWidth/);
  assert.match(out, /- feat\(ui\): something else/);
  // Only the subject line — the commit body is dropped.
  assert.doesNotMatch(out, /body text here/);
});

test('buildFallbackNotes uses `- ` (a real markdown list marker), never `•`', () => {
  // `•` is not a list marker to GitHub — a `•` block renders as one run-on
  // paragraph in a PR body or CHANGELOG.md, and extractHighlights would skip it.
  const out = buildFallbackNotes('v1.0.0', ['fix: a', 'feat: b']);
  assert.doesNotMatch(out, /•/);
  assert.deepEqual(extractHighlights(out), ['fix: a', 'feat: b']);
});

test('buildFallbackNotes degrades gracefully with no commits', () => {
  const out = buildFallbackNotes('v1.2.3', []);
  assert.match(out, /\*\*v1\.2\.3\*\*/);
  assert.match(out, /See the GitHub release for details/);
});

test('buildFallbackNotes tolerates a nullish commit list', () => {
  assert.match(buildFallbackNotes('v9', undefined), /See the GitHub release/);
});

// ── extractHighlights ──────────────────────────────────────────────────────────

test('extractHighlights takes bullet lines and drops intro + headers', () => {
  const notes =
    'Sharpens the first-run flow.\n\n**Setup**\n- remembers you are set up\n- downloads voice models\n';
  assert.deepEqual(extractHighlights(notes), [
    'remembers you are set up',
    'downloads voice models',
  ]);
});

test('extractHighlights accepts every marker a model has emitted', () => {
  // The model behind the gateway alias changes under us (2026-08-15 cutover);
  // a marker drift must degrade styling, not empty the changelog data.
  const notes = ['- dash', '* star', '+ plus', '• dot', '1. one', '2) two'].join('\n');
  assert.deepEqual(extractHighlights(notes), [
    'dash',
    'star',
    'plus',
    'dot',
    'one',
    'two',
  ]);
});

test('extractHighlights does not mistake prose, headers, or rules for bullets', () => {
  const notes = [
    'Intro sentence with 3. numbers inside.',
    '**Performance**',
    '---',
    'A paragraph under the header, not a bullet.',
    '- the only real bullet',
  ].join('\n');
  assert.deepEqual(extractHighlights(notes), ['the only real bullet']);
});

test('extractHighlights skips every horizontal-rule spelling', () => {
  // `- - -` and `* * *` are rules, not a bullet whose text is "- -".
  const notes = '- - -\n* * *\n___\n- a real bullet';
  assert.deepEqual(extractHighlights(notes), ['a real bullet']);
});

// ── normalizeListMarkers ───────────────────────────────────────────────────────

test('normalizeListMarkers rewrites •/*/+ bullets to `- `', () => {
  const out = normalizeListMarkers('• dot\n* star\n+ plus\n- already fine');
  assert.equal(out, '- dot\n- star\n- plus\n- already fine');
});

test('normalizeListMarkers keeps indentation on nested bullets', () => {
  assert.equal(normalizeListMarkers('- top\n  • nested'), '- top\n  - nested');
});

test('normalizeListMarkers leaves headers, bold, rules, and prose untouched', () => {
  const notes =
    '**Performance**\n*emphasis* stays\n---\nPlain prose line.\n1. numbered stays numbered';
  assert.equal(normalizeListMarkers(notes), notes);
});

test('normalizeListMarkers does not break spaced horizontal rules into bullets', () => {
  // `* * *` starts with a `* ` marker shape but is a rule — rewriting it to
  // `- * *` would turn it into a bogus bullet.
  const notes = '* * *\n- - -\n_ _ _';
  assert.equal(normalizeListMarkers(notes), notes);
});
