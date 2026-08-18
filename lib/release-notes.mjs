// Pure helpers for release-note generation (testable; the bin wires them up).

/**
 * Plain, un-themed notes from commit blocks — used when the LLM rewrite can't be
 * reached (e.g. a gateway outage). Better a raw changelog in Discord than no
 * announcement at all.
 *
 * Bullets use `- ` (a real markdown list marker), not `•`: GitHub renders a
 * `•`-prefixed block as one run-on paragraph (PR bodies, CHANGELOG.md), and
 * extractHighlights builds the `highlights` output from the list lines.
 *
 * @param {string} version       The release tag / version label.
 * @param {string[]} commits     Commit blocks (subject line + optional body).
 * @returns {string} Markdown: a bolded version header + one bullet per subject.
 */
export function buildFallbackNotes(version, commits) {
  const bullets = (commits || [])
    .map((c) => String(c).split('\n')[0].trim())
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');
  return `**${version}**\n\n${bullets || '_See the GitHub release for details._'}`;
}

// One definition of "a list marker", shared by the helpers below so a future
// marker can't be added to one and silently missed by the other.
// - LIST_MARKER is the superset extractHighlights accepts.
// - NORMALIZABLE_MARKERS is the subset normalizeListMarkers rewrites: not `-`
//   (already canonical) and not numbers (valid markdown that keeps its order).
// - HORIZONTAL_RULE catches `---` / `* * *` / `- - -` style rules, which look
//   marker-shaped but are neither bullets nor normalizable.
const LIST_MARKER = /^([-*+•]|\d{1,3}[.)])\s+/;
const NORMALIZABLE_MARKERS = /^(\s*)[•*+]\s+/;
const HORIZONTAL_RULE = /^\s*([*_-])(?:\s*\1){2,}\s*$/;

/**
 * Standardize list markers to `- ` so every sink renders a real markdown list.
 * Models drift on the marker (the 2026-08-15 gateway cutover changed the model
 * behind `protolabs/fast`): `•`, `*`, and `+` all read as bullets to a human,
 * but GitHub only treats `-`/`*`/`+` as list markers and `•` as plain text.
 * Only the marker is touched — indentation (nested lists) and every non-list
 * line (bold headers, prose, horizontal rules) pass through unchanged.
 * Numbered lists are already valid markdown and keep their numbers.
 */
export function normalizeListMarkers(notes) {
  return String(notes)
    .split('\n')
    .map((l) =>
      HORIZONTAL_RULE.test(l) ? l : l.replace(NORMALIZABLE_MARKERS, '$1- '),
    )
    .join('\n');
}

/**
 * Flatten notes markdown into a list of user-facing change lines — the bullet
 * items, with the list marker stripped. Section headers + the intro sentence
 * are dropped. Repos that keep a structured changelog (one entry = an array of
 * change strings) build their entry from this.
 *
 * Accepts every marker a model has been seen to emit — `-`, `*`, `+`, `•`, and
 * numbered `1.` / `1)` — so a formatting drift degrades the notes' styling, not
 * the changelog data.
 */
export function extractHighlights(notes) {
  return String(notes)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => LIST_MARKER.test(l) && !HORIZONTAL_RULE.test(l))
    .map((l) => l.replace(LIST_MARKER, '').trim())
    .filter(Boolean);
}
