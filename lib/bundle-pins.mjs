// Pure helpers for archetype (bundle) release notes: what moved in the member pins
// of a `protoagent.bundle.yaml` between two tags.
//
// In an archetype repo the pin bumps ARE the release — a `chore(pins): …` or
// `chore: bump …` commit is the change, not noise. Commit subjects also lie about
// the final state: a release range can carry several bumps of the same member, and
// a model summarising subjects will happily name an intermediate one. The manifest
// diff between the two tags is the ground truth, so it is computed here, fed to the
// model as authoritative, and appended verbatim to the notes.
//
// No YAML dependency (the package has no runtime deps): bundle manifests keep each
// member on one flow-style line (`- { id: x, url: …, ref: v1.2.3 }`, which
// check_bundle_updates.py rewrites in place), and the parser also accepts the
// block-style list form. Only the top-level `plugins:` list and a few top-level
// scalars are read.

const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(.*)$/;

function scalar(raw) {
  return String(raw ?? '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function field(text, key) {
  const m = text.match(new RegExp(`(?:^|[{,\\s])${key}:\\s*([^,}#\\s]+)`));
  return m ? scalar(m[1]) : undefined;
}

/**
 * Parse a bundle manifest into its member pins and the scalars that matter for notes.
 *
 * @param {string} yamlText  manifest contents ('' or null when the file is absent)
 * @returns {{ plugins: Map<string, {ref?: string, url?: string, builtin: boolean}>,
 *             version?: string, verifiedAgainst?: string }}
 */
export function parseBundleManifest(yamlText) {
  const plugins = new Map();
  const out = { plugins, version: undefined, verifiedAgainst: undefined };
  if (!yamlText) return out;

  let inPlugins = false;
  let item = null; // accumulated text of the current list item
  const flush = () => {
    if (item === null) return;
    const id = field(item, 'id');
    if (id) {
      plugins.set(id, {
        ref: field(item, 'ref'),
        url: field(item, 'url'),
        builtin: field(item, 'builtin') === 'true',
      });
    }
    item = null;
  };

  for (const rawLine of String(yamlText).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*(#.*)?$/.test(line)) continue; // blank / comment
    const top = line.match(TOP_LEVEL_KEY);
    if (top) {
      flush();
      const [, key, rest] = top;
      inPlugins = key === 'plugins';
      if (key === 'version') out.version = scalar(rest);
      if (key === 'verified_against') out.verifiedAgainst = scalar(rest);
      continue;
    }
    if (!inPlugins) continue;
    const start = line.match(/^\s*-\s+(.*)$/);
    if (start) {
      flush();
      item = start[1];
    } else if (item !== null) {
      item += `\n${line.trim()}`;
    }
  }
  flush();
  return out;
}

/**
 * Diff two manifests' member pins.
 *
 * @returns {{ changed: {id: string, from?: string, to?: string}[],
 *             added: {id: string, ref?: string, builtin: boolean}[],
 *             removed: {id: string, ref?: string, builtin: boolean}[],
 *             verifiedAgainst: {from?: string, to?: string} | null }}
 */
export function diffBundlePins(oldText, newText) {
  const a = parseBundleManifest(oldText);
  const b = parseBundleManifest(newText);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [id, pin] of b.plugins) {
    const prev = a.plugins.get(id);
    if (!prev) added.push({ id, ref: pin.ref, builtin: pin.builtin });
    else if (prev.ref !== pin.ref) changed.push({ id, from: prev.ref, to: pin.ref });
  }
  for (const [id, pin] of a.plugins) {
    if (!b.plugins.has(id)) removed.push({ id, ref: pin.ref, builtin: pin.builtin });
  }
  const verifiedAgainst =
    a.verifiedAgainst !== b.verifiedAgainst && b.verifiedAgainst
      ? { from: a.verifiedAgainst, to: b.verifiedAgainst }
      : null;
  return { changed, added, removed, verifiedAgainst };
}

export function hasPinChanges(diff) {
  return Boolean(
    diff &&
      (diff.changed.length || diff.added.length || diff.removed.length || diff.verifiedAgainst),
  );
}

const pinLabel = (p) => (p.builtin ? 'built-in' : p.ref || 'unpinned');

/**
 * Render the diff as a markdown section (bold header + `- ` bullets, the shape the
 * rest of the notes use). Returns '' when nothing moved.
 */
export function formatPinChanges(diff) {
  if (!hasPinChanges(diff)) return '';
  const lines = [];
  for (const c of diff.changed) lines.push(`- \`${c.id}\` ${c.from || 'unpinned'} → ${c.to || 'unpinned'}`);
  for (const p of diff.added) lines.push(`- \`${p.id}\` added (${pinLabel(p)})`);
  for (const p of diff.removed) lines.push(`- \`${p.id}\` removed (was ${pinLabel(p)})`);
  if (diff.verifiedAgainst) {
    const { from, to } = diff.verifiedAgainst;
    lines.push(
      from
        ? `- Verified against protoAgent ${from} → ${to}`
        : `- Verified against protoAgent ${to}`,
    );
  }
  return `**Member pins**\n\n${lines.join('\n')}`;
}
