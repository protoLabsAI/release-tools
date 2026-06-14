import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFallbackNotes } from '../lib/release-notes.mjs';

test('buildFallbackNotes lists one bullet per commit subject', () => {
  const out = buildFallbackNotes('@protolabsai/ui@0.35.0', [
    'fix(app-shell): let the left column shrink to minLeftWidth\n\nbody text here',
    'feat(ui): something else',
  ]);
  assert.match(out, /\*\*@protolabsai\/ui@0\.35\.0\*\*/);
  assert.match(out, /• fix\(app-shell\): let the left column shrink to minLeftWidth/);
  assert.match(out, /• feat\(ui\): something else/);
  // Only the subject line — the commit body is dropped.
  assert.doesNotMatch(out, /body text here/);
});

test('buildFallbackNotes degrades gracefully with no commits', () => {
  const out = buildFallbackNotes('v1.2.3', []);
  assert.match(out, /\*\*v1\.2\.3\*\*/);
  assert.match(out, /See the GitHub release for details/);
});

test('buildFallbackNotes tolerates a nullish commit list', () => {
  assert.match(buildFallbackNotes('v9', undefined), /See the GitHub release/);
});
