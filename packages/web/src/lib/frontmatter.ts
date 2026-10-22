// Display-only frontmatter rows. Parsing lives in shared (real YAML parser with a lenient fallback),
// so the console shows exactly what the registry and CLI read.
export { frontmatterRows as readFrontmatter } from "@intra-skills/shared/skill";
