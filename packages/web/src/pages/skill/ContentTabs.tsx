// Readme and Files: what one version of a skill contains.
import { useMemo, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, ExternalLink, WrapText } from "lucide-react";
import type { FileEntry, PackageKind, VersionDetail } from "@intra-skills/shared/types";
import { api } from "../../api";
import { readFrontmatter } from "../../lib/frontmatter";
import { renderMarkdown } from "../../lib/markdown";
import { useAsync } from "../../lib/useAsync";
import { formatBytes, plural } from "../../lib/format";
import { CopyButton, Disclosure, ErrorState, Select, Skeleton, cx } from "../../components/ui";

// ---------- Readme ----------

/** The plugin's README.md at the package root, whatever its case. */
export const pluginReadmePath = (v: VersionDetail) => v.files.find((f) => /^readme\.md$/i.test(f.path))?.path ?? null;

/**
 * The markdown a version's Readme tab shows: SKILL.md for a skill, RULE.md for a rule, README.md for a
 * plugin. A plugin's README (and a rule's RULE.md, when the server leaves skillMd empty) is fetched
 * through the files API. `text` is null while loading, "" when there is nothing to show.
 */
export function useReadmeText(name: string, version: VersionDetail | null, kind: PackageKind) {
  const path = !version ? null : kind === "plugin" ? pluginReadmePath(version) : kind === "rule" && !version.skillMd.trim() && version.files.some((f) => f.path === "RULE.md") ? "RULE.md" : null;
  const file = useAsync(() => (version && path ? api.getFile(name, version.version, path) : Promise.resolve(null)), [name, version?.version, path]);
  if (!version) return { text: null, file: null, error: null, reload: file.reload };
  if (!path) return { text: kind === "plugin" ? "" : version.skillMd, file: kind === "plugin" ? null : kind === "rule" ? "RULE.md" : "SKILL.md", error: null, reload: file.reload };
  return { text: typeof file.data === "string" ? file.data : null, file: path, error: file.error ?? null, reload: file.reload };
}

export function ReadmeTab({
  version,
  text,
  kind = "skill",
  onOpenFile,
}: {
  version: VersionDetail;
  /** Markdown to render; defaults to the version's SKILL.md. */
  text?: string;
  kind?: PackageKind;
  onOpenFile: (path: string) => void;
}) {
  const source = text ?? version.skillMd;
  const fm = useMemo(() => readFrontmatter(source), [source]);
  const html = useMemo(() => renderMarkdown(fm.body, { shiftHeadings: true }), [fm.body]);
  const paths = useMemo(() => new Set(version.files.map((f) => f.path)), [version.files]);

  // Relative links to files in the bundle open the Files tab instead of a dead URL.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href || /^[a-z]+:/i.test(href) || href.startsWith("#")) return;
    const p = href.replace(/^\.\//, "");
    if (paths.has(p)) {
      e.preventDefault();
      onOpenFile(p);
    }
  };

  return (
    <div className="flex max-w-[72ch] flex-col gap-6">
      {fm.rows.length > 0 && (
        <Disclosure summary={<span className="font-mono text-[13px]">Frontmatter</span>} meta={`${fm.rows.length} keys`} className="bg-panel">
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 font-mono text-[13px] leading-5">
            {fm.rows.map((r) => (
              <div key={r.key} className="contents">
                <dt className="text-fg-subtle">{r.key}</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{r.value}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
      {fm.body.trim() ? (
        <article
          // Headings are demoted one level (one h1 per page); restore the look of their source level.
          className={cx(
            "prose-skill",
            "[&_[data-md='1']]:border-0! [&_[data-md='1']]:pb-0! [&_[data-md='1']]:text-xl!",
            "[&_[data-md='2']]:border-b [&_[data-md='2']]:border-line [&_[data-md='2']]:pb-[0.35em] [&_[data-md='2']]:text-lg!",
            "[&_[data-md='3']]:text-base! [&_[data-md='3']]:text-fg!",
          )}
          onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      ) : kind === "plugin" ? (
        <div className="rounded-lg border border-dashed border-line-strong px-4 py-6">
          <h3 className="text-base font-semibold text-fg">No README in this plugin</h3>
          <p className="mt-1 text-sm text-fg-muted">
            Its authors did not include a <span className="font-mono whitespace-nowrap text-fg">README.md</span>. The Components tab lists what it adds to Claude Code, and the Files tab
            has everything it ships.
          </p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          This version's <span className="font-mono whitespace-nowrap">{kind === "rule" ? "RULE.md" : "SKILL.md"}</span> has frontmatter and no body.
        </p>
      )}
    </div>
  );
}

export function ReadmeSkeleton() {
  return (
    <div className="flex max-w-[72ch] flex-col gap-3" aria-busy="true" aria-label="Loading readme">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-3.5" />
      <Skeleton className="h-3.5 w-11/12" />
      <Skeleton className="mt-3 h-4 w-1/4" />
      <Skeleton className="h-3.5" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-3/5" />
    </div>
  );
}

// ---------- Files ----------

const FIRST = new Set(["SKILL.md", "RULE.md", "README.md"]);

interface Node {
  name: string;
  path: string;
  file?: FileEntry;
  children: Node[];
}

function buildTree(files: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path, children: [] };
        cur.children.push(next);
      }
      if (i === parts.length - 1) next.file = f;
      cur = next;
    });
  }
  const sort = (n: Node[]) => {
    n.sort((a, b) => {
      if (FIRST.has(a.path) !== FIRST.has(b.path)) return FIRST.has(a.path) ? -1 : 1;
      const ad = !a.file;
      const bd = !b.file;
      if (ad !== bd) return ad ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    n.forEach((c) => sort(c.children));
  };
  sort(root.children);
  return root.children;
}

/** The marker file first (SKILL.md, RULE.md, a plugin's README.md), then by path, so a flat list reads like `ls -R`. */
const orderFiles = (files: FileEntry[]) =>
  [...files].sort((a, b) => (FIRST.has(a.path) !== FIRST.has(b.path) ? (FIRST.has(a.path) ? -1 : 1) : a.path.localeCompare(b.path)));

function FileRow({ path, label, depth, size, active, onSelect, showSize = true }: { path: string; label: string; depth: number; size: number; active: boolean; onSelect: (p: string) => void; showSize?: boolean }) {
  return (
    <li role="treeitem" aria-selected={active} aria-level={depth + 1}>
      <button
        type="button"
        onClick={() => onSelect(path)}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={`${path}, ${formatBytes(size)}`}
        className={cx(
          "flex h-7 w-full items-center gap-2 rounded-[4px] pr-2 text-left transition-colors duration-[120ms]",
          active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
        {showSize && <span className={cx("shrink-0 text-xs tabular", active ? "text-fg-muted" : "text-fg-subtle")}>{formatBytes(size)}</span>}
      </button>
    </li>
  );
}

function TreeNode({ node, depth, selected, onSelect }: { node: Node; depth: number; selected: string; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(true);
  if (node.file) return <FileRow path={node.path} label={node.name} depth={depth} size={node.file.size} active={selected === node.path} onSelect={onSelect} />;
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false} aria-level={depth + 1}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: 4 + depth * 12 }}
        className="flex h-7 w-full items-center gap-1 rounded-[4px] pr-2 text-left text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        {open ? <ChevronDown className="size-3 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-3 text-fg-subtle" aria-hidden />}
        <span className="truncate font-mono text-xs">{node.name}/</span>
      </button>
      {open && (
        <ul role="group">
          {node.children.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

const WRAP_KEY = "isk-files-wrap";
function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Up to this many files the tree is a flat list of paths; beyond it, folders collapse. */
const FLAT_LIMIT = 8;

export function FilesTab({ name, version, path, onSelect }: { name: string; version: VersionDetail; path: string | null; onSelect: (p: string) => void }) {
  const flat = version.files.length <= FLAT_LIMIT;
  const tree = useMemo(() => buildTree(version.files), [version.files]);
  const ordered = useMemo(() => orderFiles(version.files), [version.files]);
  const selected = path && version.files.some((f) => f.path === path) ? path : (ordered[0]?.path ?? "SKILL.md");
  const entry = version.files.find((f) => f.path === selected);
  const content = useAsync(() => api.getFile(name, version.version, selected), [name, version.version, selected]);
  const text = typeof content.data === "string" ? content.data : null;
  const lines = text !== null ? text.replace(/\n$/, "").split("\n") : [];
  const [wrap, setWrap] = useState(readWrap);
  const toggleWrap = () => {
    setWrap((w) => {
      try {
        localStorage.setItem(WRAP_KEY, w ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !w;
    });
  };

  // Raw: the server serves the file as text with a sandboxing CSP.
  const rawHref = `/api/skills/${encodeURIComponent(name)}/versions/${encodeURIComponent(version.version)}/files/${selected.split("/").map(encodeURIComponent).join("/")}`;

  const gutter = String(Math.max(lines.length, 1)).length;

  return (
    <div className="grid overflow-hidden rounded-lg border border-line bg-surface md:grid-cols-[232px_minmax(0,1fr)]">
      <nav aria-label="Files in this version" className="border-line bg-panel max-md:hidden md:border-r">
        <p className="flex h-10 items-center border-b border-line px-3 text-sm text-fg-muted tabular">{plural(version.files.length, "file")}</p>
        <ul role="tree" aria-label="Files" className="p-1">
          {flat
            ? ordered.map((f) => <FileRow key={f.path} path={f.path} label={f.path} depth={0} size={f.size} active={selected === f.path} onSelect={onSelect} />)
            : tree.map((n) => <TreeNode key={n.path} node={n} depth={0} selected={selected} onSelect={onSelect} />)}
        </ul>
      </nav>
      <div className="min-w-0">
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1 max-md:py-2">
          <div className="min-w-0 flex-1 md:hidden">
            <Select aria-label="File" value={selected} onChange={(e) => onSelect(e.target.value)} className="w-full font-mono [&_select]:font-mono">
              {ordered.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </Select>
          </div>
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium max-md:hidden">{selected}</span>
          {entry && (
            <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle tabular max-sm:hidden">
              {text !== null && <span>{plural(lines.length, "line")}</span>}
              {(entry.mode & 0o111) !== 0 && (
                <span title={`File mode ${(entry.mode & 0o777).toString(8)}`} className="rounded-sm border border-line px-1 leading-4">
                  executable
                </span>
              )}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-pressed={wrap}
              aria-label="Wrap long lines"
              onClick={toggleWrap}
              title={wrap ? "Long lines wrap. Turn off to scroll sideways" : "Long lines scroll. Turn on to wrap them"}
              className={cx(
                "inline-flex size-7 items-center justify-center rounded-md transition-colors duration-[120ms] max-md:size-11",
                wrap ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
              )}
            >
              <WrapText className="size-3.5" aria-hidden />
            </button>
            {text !== null && <CopyButton text={text} label={`Copy ${selected}`} />}
            {rawHref && (
              <a
                href={rawHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${selected} raw (opens in a new tab)`}
                title="Open the raw file"
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg max-md:min-h-11"
              >
                Raw
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </span>
        </div>
        {content.error ? (
          <ErrorState error={content.error} onRetry={content.reload} title={`Could not load ${selected}`} />
        ) : text === null ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading file">
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="h-3" />
            ))}
          </div>
        ) : (
          <div className={cx("overflow-x-auto py-2", content.loading && "opacity-60")}>
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td
                      className="w-px pr-3 pl-3 text-right align-top text-fg-subtle tabular select-none"
                      style={{ minWidth: `${gutter + 3}ch` }}
                      aria-hidden
                    >
                      {i + 1}
                    </td>
                    <td className={cx("pr-4 align-top text-fg", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>{l || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function FilesSkeleton() {
  return (
    <div className="grid overflow-hidden rounded-lg border border-line md:grid-cols-[232px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading files">
      <div className="flex flex-col gap-2 border-line bg-panel p-3 max-md:hidden md:border-r">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-4" />
        ))}
      </div>
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-3" />
        ))}
      </div>
    </div>
  );
}
