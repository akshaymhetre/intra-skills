// Which package folders a git source holds (docs/API.md "Git sources"): each kind lives under its
// own root and is recognised by its marker. Skills and rules may sit up to 3 folders deep; a
// plugin is exactly <pluginsRoot>/<name>/. A folder whose marker belongs to another kind is
// reported with a reason instead of being read.
import { KIND_MARKER, KINDS, type PackageKind } from "@intra-skills/shared";
import type { RepoFile } from "./provider.js";

export interface KindRoots {
  root: string;
  plugins_root: string;
  rules_root: string;
}

export function rootFor(source: KindRoots, kind: PackageKind): string {
  return kind === "plugin" ? source.plugins_root : kind === "rule" ? source.rules_root : source.root;
}

const ROOT_LABEL: Record<PackageKind, string> = { skill: "root", plugin: "pluginsRoot", rule: "rulesRoot" };

/** Directory levels a provider must list under each root to see every marker. */
export const LIST_DEPTH: Record<PackageKind, number> = { skill: 5, plugin: 3, rule: 5 };

export interface DiscoveredFolders {
  folders: string[];
  skipped: { path: string; reason: string }[];
}

/** Package folders under `root` for `kind`, given every file below it. */
export function discoverFolders(files: RepoFile[], root: string, kind: PackageKind, source: KindRoots): DiscoveredFolders {
  const prefix = root.replace(/\/+$/, "") + "/";
  const maxDepth = kind === "plugin" ? 1 : 3;
  const minDepth = 1;
  const found = new Map<string, Set<PackageKind>>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    for (const k of KINDS) {
      const marker = `/${KIND_MARKER[k]}`;
      if (!f.path.endsWith(marker)) continue;
      const folder = f.path.slice(0, -marker.length);
      if (!folder.startsWith(prefix)) continue;
      const depth = folder.slice(prefix.length).split("/").length;
      if (depth < minDepth || depth > maxDepth) continue;
      const set = found.get(folder) ?? new Set<PackageKind>();
      set.add(k);
      found.set(folder, set);
    }
  }
  const all = [...found.keys()].sort();
  // A package's own subfolders (a plugin's skills/, a skill's examples) are not packages.
  const top = all.filter((d) => !all.some((o) => o !== d && d.startsWith(o + "/")));
  const out: DiscoveredFolders = { folders: [], skipped: [] };
  for (const folder of top) {
    const kinds = found.get(folder)!;
    if (kinds.has(kind)) {
      out.folders.push(folder);
      continue;
    }
    const other = [...kinds][0]!;
    out.skipped.push({
      path: folder,
      reason: `has ${KIND_MARKER[other]}, which makes it a ${other}, but ${root}/ holds ${kind}s; move it under ${rootFor(source, other)}/ (the source's ${ROOT_LABEL[other]})`,
    });
  }
  return out;
}
