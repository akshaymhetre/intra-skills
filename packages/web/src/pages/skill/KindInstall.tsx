// Install cards for the two non-skill kinds. Same beam card as a skill, different lines:
// - a plugin is installed by Claude Code itself, from this registry's marketplace, after a one-time
//   `intra plugins connect`;
// - a rule is written into the project, one file per tool, by `intra install <name> --project`.
import { Link } from "react-router";
import type { RuleSpec, VersionMeta } from "@intra-skills/shared/types";
import {
  agentPrompt,
  pluginInstallCommand,
  pluginSlashCommand,
  pluginsConnectCommand,
  ruleInstallCommand,
  rulePaths,
} from "../../lib/commands";
import { InstallCard } from "../../components/InstallCard";
import { CopyCommand } from "../../components/CopyCommand";
import { TriangleAlert } from "lucide-react";
import { WarningLine } from "../../components/ui";

/** Claude Code refuses plugin archives that are not https or that point at a loopback host. */
export const servesPlugins = (publicUrl: string) => /^https:\/\//i.test(publicUrl) && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(publicUrl);

/** Why Claude Code will not install from this registry yet: a neutral note with one amber mark. */
export function HttpsNote({ publicUrl, className }: { publicUrl: string; className?: string }) {
  return (
    <p className={`flex items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-sm text-fg-muted ${className ?? ""}`}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
      <span>
        <span className="font-medium text-fg">Claude Code will not install from this registry yet.</span> It is served at{" "}
        <span className="font-mono text-[0.93em] [overflow-wrap:anywhere]">{publicUrl}</span>, and Claude Code downloads plugins only over https from a host that is not this
        machine. An admin needs to put it behind https.
      </span>
    </p>
  );
}

const Path = ({ children }: { children: string }) => <span className="font-mono text-[0.92em] whitespace-nowrap text-fg">{children}</span>;
const link = "text-fg underline decoration-line-control underline-offset-[0.2em] hover:decoration-current";

function YankedLine({ version, meta }: { version: string | null; meta: VersionMeta | null }) {
  if (!meta?.yanked) return null;
  return (
    <WarningLine>
      <span className="font-mono text-[0.93em]">{version}</span> is yanked: {meta.yanked.replace(/[.\s]+$/, "")}.
    </WarningLine>
  );
}

// ---------- plugin ----------

export function PluginInstall({
  name,
  version,
  meta,
  publicUrl,
  marketplace,
  deprecated = false,
}: {
  name: string;
  version: string | null;
  meta: VersionMeta | null;
  publicUrl: string;
  marketplace: string;
  deprecated?: boolean;
}) {
  // Until it can install, the card does not invite anyone: no beam, the reason first.
  const insecure = !servesPlugins(publicUrl);
  return (
    <div className="flex flex-col gap-3">
      <InstallCard
        title={deprecated ? "Still installs" : "Install"}
        beam={!deprecated && !insecure}
        tabs={[
          {
            id: "terminal",
            label: "Terminal",
            command: pluginInstallCommand(name, marketplace),
            note: "Claude Code downloads the latest version from this registry, installs it for you on this machine, and updates it from here.",
          },
          {
            id: "project",
            label: "Project",
            command: pluginInstallCommand(name, marketplace, { project: true }),
            note: (
              <>
                Turns it on for everyone in this repository: Claude Code records it in <Path>.claude/settings.json</Path>, so commit that file. Each teammate runs{" "}
                <Path>{pluginsConnectCommand()}</Path> once, so their Claude Code can reach this registry.
              </>
            ),
          },
          {
            id: "inside",
            label: "In Claude Code",
            command: pluginSlashCommand(name, marketplace),
            note: "Type this in a Claude Code session instead of a shell. Claude Code asks where to install it.",
          },
          {
            id: "agent",
            label: "Agent",
            command: agentPrompt(publicUrl, name, "plugin"),
            prose: true,
            note: "Paste this into Claude Code. It reads the registry's instructions, shows you what the plugin runs, then installs it.",
          },
        ]}
        lead={
          <div className="flex flex-col gap-1.5">
            {insecure && <HttpsNote publicUrl={publicUrl} className="mb-2" />}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-sm font-semibold text-fg">1. Connect once per machine</h3>
              <span className="text-sm text-fg-subtle">Adds this registry's plugins to Claude Code.</span>
            </div>
            <CopyCommand command={pluginsConnectCommand()} label="Copy connect command" size="sm" />
            <p className="text-sm text-fg-muted">
              No CLI? Make a plugin key in{" "}
              <Link to="/settings#plugins-h" className={link}>
                Settings
              </Link>{" "}
              and add the marketplace by hand.
            </p>
            <h3 className="mt-4 -mb-2 border-t border-line pt-4 text-sm font-semibold text-fg">2. Install</h3>
          </div>
        }
      />
      <YankedLine version={version} meta={meta} />
    </div>
  );
}

// ---------- rule ----------

/** One sentence: when an agent reads this rule. */
export function ruleWhen(rule: RuleSpec | null): { short: string; detail: React.ReactNode } {
  if (!rule) return { short: "Unknown", detail: "This version was published before the registry read when rules apply." };
  if (rule.mode === "always") return { short: "Always", detail: "In every session, for every file." };
  if (rule.mode === "globs")
    return {
      short: "For matching files",
      detail: (
        <>
          When the agent works on files matching{" "}
          {rule.globs.map((g, i) => (
            <span key={g}>
              {i > 0 && (i === rule.globs.length - 1 ? " or " : ", ")}
              <Path>{g}</Path>
            </span>
          ))}
          .
        </>
      ),
    };
  return { short: "When the agent decides", detail: "When the agent decides it is relevant, from the description. No file patterns are set." };
}

export function RuleInstall({
  name,
  version,
  meta,
  publicUrl,
  deprecated = false,
}: {
  name: string;
  version: string | null;
  meta: VersionMeta | null;
  publicUrl: string;
  deprecated?: boolean;
}) {
  const p = rulePaths(name);
  const when = ruleWhen(meta?.rule ?? null);
  return (
    <div className="flex flex-col gap-3">
      <InstallCard
        title={deprecated ? "Still installs" : "Install"}
        beam={!deprecated}
        tabs={[
          {
            id: "project",
            label: "Project",
            command: ruleInstallCommand(name),
            note: (
              <>
                Run it in the repository. It writes a rule file for Cursor and one for Claude Code, a block in <Path>{p.codex}</Path> for Codex, and records the version in{" "}
                <Path>skills.lock.json</Path>. Commit them so teammates get the same rule. The Renders as tab shows each file.
              </>
            ),
          },
          {
            id: "agent",
            label: "Agent",
            command: agentPrompt(publicUrl, name, "rule"),
            prose: true,
            note: "Paste this into Claude Code or Codex inside the repository. The agent reads the registry's instructions, then installs the rule.",
          },
        ]}
        footer={
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-fg">When it applies</h3>
            <p className="text-sm text-fg-muted">
              <span className="font-medium text-fg">{when.short}.</span> {when.detail}
            </p>
          </div>
        }
      />
      <YankedLine version={version} meta={meta} />
    </div>
  );
}
