import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffBundlePins,
  formatPinChanges,
  hasPinChanges,
  parseBundleManifest,
} from '../lib/bundle-pins.mjs';

const OLD = `# PIN LIFECYCLE: keep member entries on ONE line — ref: v9.9.9 in a comment is ignored
id: project-manager-archetype
version: 0.6.0
verified_against: 0.145.0  # bump on re-verify

plugins:
  - { id: delegates, builtin: true }                                                  # spine
  - { id: project_board, url: https://github.com/protoLabsAI/projectBoard-plugin,  ref: v0.42.0 }
  - { id: agent_browser, url: https://github.com/protoLabsAI/agent-browser-plugin, ref: v0.6.4 }
  - { id: social, url: https://github.com/protoLabsAI/social-plugin, ref: "v0.4.2" }

enabled: [delegates, project_board]
config:
  project_board:
    ref: not-a-pin
`;

const NEW = `id: project-manager-archetype
version: 0.7.0
verified_against: 0.200.0

plugins:
  - { id: delegates, builtin: true }
  - { id: project_board, url: https://github.com/protoLabsAI/projectBoard-plugin,  ref: v0.65.0 }
  - { id: agent_browser, url: https://github.com/protoLabsAI/agent-browser-plugin, ref: v0.6.4 }
  - id: github
    url: https://github.com/protoLabsAI/github-plugin
    ref: v0.9.1
`;

test('parses flow- and block-style members, ignoring comments and non-plugin keys', () => {
  const m = parseBundleManifest(NEW);
  assert.equal(m.version, '0.7.0');
  assert.equal(m.verifiedAgainst, '0.200.0');
  assert.deepEqual([...m.plugins.keys()], ['delegates', 'project_board', 'agent_browser', 'github']);
  assert.equal(m.plugins.get('github').ref, 'v0.9.1');
  assert.equal(m.plugins.get('delegates').builtin, true);
  const o = parseBundleManifest(OLD);
  assert.equal(o.verifiedAgainst, '0.145.0'); // trailing comment stripped
  assert.equal(o.plugins.get('social').ref, 'v0.4.2'); // quotes stripped
  assert.equal(o.plugins.size, 4); // config.project_board.ref is not a member
});

test('diff names the FINAL pin of each moved member, plus adds/removes and verified_against', () => {
  const d = diffBundlePins(OLD, NEW);
  assert.deepEqual(d.changed, [{ id: 'project_board', from: 'v0.42.0', to: 'v0.65.0' }]);
  assert.deepEqual(d.added.map((p) => [p.id, p.ref]), [['github', 'v0.9.1']]);
  assert.deepEqual(d.removed.map((p) => [p.id, p.ref]), [['social', 'v0.4.2']]);
  assert.deepEqual(d.verifiedAgainst, { from: '0.145.0', to: '0.200.0' });
  const md = formatPinChanges(d);
  assert.match(md, /^\*\*Member pins\*\*/);
  assert.match(md, /- `project_board` v0\.42\.0 → v0\.65\.0/);
  assert.match(md, /- `github` added \(v0\.9\.1\)/);
  assert.match(md, /- `social` removed \(was v0\.4\.2\)/);
  assert.match(md, /- Verified against protoAgent 0\.145\.0 → 0\.200\.0/);
  assert.doesNotMatch(md, /agent_browser|delegates/); // unchanged members aren't listed
});

test('no movement → empty section; a manifest new in this release lists every member as added', () => {
  assert.equal(hasPinChanges(diffBundlePins(NEW, NEW)), false);
  assert.equal(formatPinChanges(diffBundlePins(NEW, NEW)), '');
  const first = diffBundlePins('', NEW);
  assert.equal(first.added.length, 4);
  assert.match(formatPinChanges(first), /`delegates` added \(built-in\)/);
});
