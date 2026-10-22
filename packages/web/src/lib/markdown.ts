import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Render untrusted SKILL.md markdown to sanitized HTML. Links open in a new tab without opener access.
 * `shiftHeadings` demotes every heading one level (h1 -> h2 ...) so a readme never adds a second h1 to the page;
 * each demoted heading keeps its source level in `data-md` for styling.
 */
export function renderMarkdown(md: string, opts: { shiftHeadings?: boolean } = {}): string {
  const html = marked.parse(md, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });
  if (opts.shiftHeadings) {
    doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const level = Number(h.tagName[1]);
      const next = doc.createElement(`h${Math.min(level + 1, 6)}`);
      next.setAttribute("data-md", String(level));
      for (const a of Array.from(h.attributes)) next.setAttribute(a.name, a.value);
      next.append(...Array.from(h.childNodes));
      h.replaceWith(next);
    });
  }
  return doc.body.innerHTML;
}
