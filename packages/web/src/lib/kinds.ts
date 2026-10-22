// Package kinds in the console: a skill (the default), a Claude Code plugin, or a rule. One place that
// answers "which kind is this" and "what is its one install line", so a row, the palette and the
// skill page never disagree about a plugin's command.
import type { PackageKind, RegistryMeta } from "@intra-skills/shared/types";
import { KIND_LABELS } from "@intra-skills/shared/kinds";
import { installCommand, pluginInstallCommand, ruleInstallCommand } from "./commands";

export { KIND_LABELS };

/** Summaries from a registry older than v3 carry no kind: they are skills. */
export const kindOf = (s: { kind?: PackageKind | null }): PackageKind => s.kind ?? "skill";

/** The marketplace name Claude Code installs plugins from (`<plugin>@<name>`). */
export const marketplaceOf = (meta: RegistryMeta | null): string => meta?.marketplaceName || "intra-skills";

/** The one line a row or the palette copies for a package. */
export function primaryInstallCommand(name: string, kind: PackageKind, marketplace: string): string {
  if (kind === "plugin") return pluginInstallCommand(name, marketplace);
  if (kind === "rule") return ruleInstallCommand(name);
  return installCommand(name);
}

/** Lowercase noun for counts: "3 plugins". */
export const kindNoun = (kind: PackageKind) => KIND_LABELS[kind].toLowerCase();

/** The file that defines each kind, as people write it. */
export const KIND_FILE: Record<PackageKind, string> = { skill: "SKILL.md", plugin: "plugin.json", rule: "RULE.md" };
