// Pure helpers for release-note generation (testable; the bin wires them up).

/**
 * Plain, un-themed notes from commit blocks — used when the LLM rewrite can't be
 * reached (e.g. a gateway outage). Better a raw changelog in Discord than no
 * announcement at all.
 *
 * @param {string} version       The release tag / version label.
 * @param {string[]} commits     Commit blocks (subject line + optional body).
 * @returns {string} Markdown: a bolded version header + one bullet per subject.
 */
export function buildFallbackNotes(version, commits) {
  const bullets = (commits || [])
    .map((c) => String(c).split('\n')[0].trim())
    .filter(Boolean)
    .map((s) => `• ${s}`)
    .join('\n');
  return `**${version}**\n\n${bullets || '_See the GitHub release for details._'}`;
}
