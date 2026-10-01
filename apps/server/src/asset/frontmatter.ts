import matter from "gray-matter";

/** Shared data-only Frontmatter boundary for formal, targeted and Inbox scans. */
export function parseYamlFrontmatter(source: string): matter.GrayMatterFile<string> | undefined {
  if (!matter.test(source)) {
    return undefined;
  }
  // gray-matter 4.0.3 lets the opening line override options.language, including
  // JavaScript aliases. Require the bare YAML delimiter BEFORE invoking it.
  // LF and CRLF make matter.language() return an empty name; no file-selected
  // engine is reachable. Do not normalize or rewrite the supplied Markdown.
  if (!/^---\r?\n/u.test(source)) {
    throw new Error("YAML frontmatter must begin with a bare --- line; language headers are not allowed");
  }
  // In 4.0.3, any explicit options bypass both cached-result reuse and cache
  // insertion (index.js:35–50). There is no cache:false option. The fixed YAML
  // engine uses js-yaml.safeLoad; executable YAML tags are rejected as data.
  return matter(source, { language: "yaml" });
}
