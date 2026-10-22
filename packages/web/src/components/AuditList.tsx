// The audit trail, rendered for people. One source of truth for how an entry reads:
// `auditParts` turns a raw entry into a plain verb ("published", "yanked", "changed access"), a linked
// target, and detail facts printed as `key value` text (version, reason, grants), never raw JSON.
// Two renderers share it: AuditTable (the Activity page) and AuditRow (a dense sentence, for lists
// inside other pages). AuditRow / AuditSkeleton / AUDIT_ACTIONS keep their original props.
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AuditEntry } from "@intra-skills/shared/types";
import { formatDateTime, relativeTime } from "../lib/format";
import { MetaKey, Skeleton, cx } from "./ui";
import { PersonMark } from "./fx";

export interface AuditActionOption {
  value: string;
  label: string;
  group: "Skills" | "Proposals" | "Teams" | "People" | "Tokens" | "Repositories" | "Registry";
}

/** Filter options, in plain words. `label` reads as the verb a row shows. */
export const AUDIT_ACTIONS: AuditActionOption[] = [
  { value: "skill.publish", label: "Published", group: "Skills" },
  { value: "skill.patch", label: "Edited or deprecated", group: "Skills" },
  { value: "version.yank", label: "Yanked", group: "Skills" },
  { value: "version.unyank", label: "Restored", group: "Skills" },
  { value: "grants.set", label: "Changed access", group: "Skills" },
  { value: "skill.delete", label: "Deleted", group: "Skills" },
  { value: "skill.verify", label: "Verified", group: "Skills" },
  { value: "skill.unverify", label: "Removed verification", group: "Skills" },
  { value: "proposal.create", label: "Proposed", group: "Proposals" },
  { value: "proposal.update", label: "Updated proposal", group: "Proposals" },
  { value: "team.create", label: "Created team", group: "Teams" },
  { value: "team.update", label: "Edited team", group: "Teams" },
  { value: "team.member.set", label: "Set member role", group: "Teams" },
  { value: "team.member.remove", label: "Removed member", group: "Teams" },
  { value: "collection.put", label: "Saved collection", group: "Teams" },
  { value: "collection.delete", label: "Deleted collection", group: "Teams" },
  { value: "user.create", label: "Added person", group: "People" },
  { value: "user.update", label: "Changed person", group: "People" },
  { value: "token.create", label: "Created token", group: "Tokens" },
  { value: "token.revoke", label: "Revoked token", group: "Tokens" },
  { value: "source.create", label: "Connected repository", group: "Repositories" },
  { value: "source.update", label: "Edited repository", group: "Repositories" },
  { value: "source.delete", label: "Disconnected repository", group: "Repositories" },
  { value: "source.sync", label: "Synced repository", group: "Repositories" },
  { value: "settings.update", label: "Changed registry settings", group: "Registry" },
];

const SETTING_LABEL: Record<string, string> = { name: "name", publicUrl: "public URL", staleDays: "stale after", pollSeconds: "poll every" };

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

const LINK = "rounded-sm text-fg underline decoration-transparent underline-offset-[0.18em] hover:decoration-line-control";

function SkillTarget({ name }: { name: string }) {
  return (
    <Link to={`/skills/${encodeURIComponent(name)}`} className={cx(LINK, "font-mono text-[0.93em] font-medium")}>
      {name}
    </Link>
  );
}
function TeamTarget({ slug, name }: { slug: string; name?: string | null }) {
  return (
    <Link to={`/teams/${encodeURIComponent(slug)}`} className={cx(LINK, "font-medium")}>
      {name ?? slug}
    </Link>
  );
}
function Handle({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.93em] text-fg">{children}</span>;
}

interface Fact {
  k: string;
  v: ReactNode;
  mono?: boolean;
  /** The key is a real SKILL.md frontmatter key (areas, tags, tools): it prints in mono. Other keys are sans labels. */
  fm?: boolean;
}
export interface AuditParts {
  verb: string;
  /** True for actions that change what installs (yank, delete): the verb takes the danger colour. */
  severe?: boolean;
  target: ReactNode;
  facts: Fact[];
}

function grantFacts(g: unknown): Fact[] {
  if (typeof g === "number") return [{ k: "grants", v: g === 0 ? "none (org default)" : `${g} ${g === 1 ? "grant" : "grants"}` }];
  if (!Array.isArray(g)) return [];
  if (!g.length) return [{ k: "grants", v: "none (org default)" }];
  const parts = g.slice(0, 3).map((x: { principalType?: string; principal?: string; permission?: string }) => `${x.principal ?? "?"} ${x.permission ?? ""}`.trim());
  return [{ k: "grants", v: parts.join(", ") + (g.length > 3 ? ` +${g.length - 3}` : ""), mono: true }];
}

/** How one entry reads. Unknown actions fall back to the raw action name, so nothing is ever hidden. */
export function auditParts(e: AuditEntry): AuditParts {
  const d = e.detail ?? {};
  const version = str(d.version);
  const vFact: Fact[] = version ? [{ k: "version", v: version, mono: true }] : [];
  switch (e.action) {
    case "skill.publish":
      return { verb: "published", target: <SkillTarget name={e.target} />, facts: vFact };
    case "skill.patch": {
      if ("deprecated" in d) {
        const reason = str(d.deprecated);
        return d.deprecated
          ? { verb: "deprecated", target: <SkillTarget name={e.target} />, facts: reason && reason !== "true" ? [{ k: "reason", v: reason }] : [] }
          : { verb: "undeprecated", target: <SkillTarget name={e.target} />, facts: [] };
      }
      const keys = Object.keys(d);
      const facts: Fact[] = keys
        .filter((k) => str(d[k]) !== null)
        .slice(0, 3)
        .map((k) => ({ k, v: str(d[k])!, mono: k !== "description", fm: true }));
      if (!facts.length && keys.length) facts.push({ k: "changed", v: keys.join(", "), mono: true });
      return { verb: "edited", target: <SkillTarget name={e.target} />, facts };
    }
    case "skill.delete":
      return { verb: "deleted", severe: true, target: <Handle>{e.target}</Handle>, facts: [] };
    case "version.yank":
      return {
        verb: "yanked",
        severe: true,
        target: <SkillTarget name={e.target} />,
        facts: [...vFact, ...(str(d.reason) ? [{ k: "reason", v: str(d.reason)! }] : [])],
      };
    case "version.unyank":
      return { verb: "restored", target: <SkillTarget name={e.target} />, facts: vFact };
    case "grants.set":
      return { verb: "changed access", target: <SkillTarget name={e.target} />, facts: grantFacts(d.grants) };
    case "team.create":
      return { verb: "created team", target: <TeamTarget slug={e.target} name={str(d.name)} />, facts: [] };
    case "team.update":
      return {
        verb: "edited team",
        target: <TeamTarget slug={e.target} />,
        facts: [
          ...(str(d.name) ? [{ k: "name", v: str(d.name)! }] : []),
          ...(str(d.description) !== null ? [{ k: "description", v: str(d.description) || "cleared" }] : []),
        ],
      };
    case "team.member.set":
      return {
        verb: "set member role",
        target: <TeamTarget slug={e.target} />,
        facts: [
          { k: "member", v: str(d.handle) ?? "?", mono: true },
          { k: "role", v: str(d.role) ?? "member" },
        ],
      };
    case "team.member.remove":
      return { verb: "removed member", target: <TeamTarget slug={e.target} />, facts: [{ k: "member", v: str(d.handle) ?? "?", mono: true }] };
    case "user.create":
      return { verb: "added person", target: <Handle>{e.target}</Handle>, facts: str(d.role) ? [{ k: "role", v: str(d.role)! }] : [] };
    case "user.update":
      return {
        verb: str(d.role) ? "changed role of" : "edited",
        target: <Handle>{e.target}</Handle>,
        facts: [
          ...(str(d.role) ? [{ k: "role", v: str(d.role)! }] : []),
          ...(str(d.displayName) ? [{ k: "name", v: str(d.displayName)! }] : []),
        ],
      };
    case "token.create":
      return {
        verb: "created token",
        target: <span className="text-fg">{str(d.name) ?? "a token"}</span>,
        facts: str(d.prefix) ? [{ k: "prefix", v: `${str(d.prefix)}…`, mono: true }] : [],
      };
    case "token.revoke":
      return { verb: "revoked token", target: <span className="text-fg">{str(d.name) ?? "a token"}</span>, facts: [] };
    case "skill.verify":
      return { verb: "verified", target: <SkillTarget name={e.target} />, facts: vFact };
    case "skill.unverify":
      return { verb: "removed verification of", target: <SkillTarget name={e.target} />, facts: vFact };
    case "proposal.create":
    case "proposal.update": {
      const skill = str(d.skill);
      return {
        verb: e.action === "proposal.create" ? "proposed" : "updated the proposal for",
        target: skill ? <SkillTarget name={skill} /> : <Handle>{e.target}</Handle>,
        facts: vFact,
      };
    }
    case "collection.put":
    case "collection.delete": {
      const [team, slug] = e.target.split("/");
      const skills = Array.isArray(d.skills) ? (d.skills as unknown[]).filter((x): x is string => typeof x === "string") : [];
      return {
        verb: e.action === "collection.put" ? "saved collection" : "deleted collection",
        severe: e.action === "collection.delete",
        target:
          e.action === "collection.put" && team && slug ? (
            <Link to={`/collections/${encodeURIComponent(team)}/${encodeURIComponent(slug)}`} className={cx(LINK, "font-mono text-[0.93em] font-medium")}>
              @{e.target}
            </Link>
          ) : (
            <Handle>@{e.target}</Handle>
          ),
        facts: skills.length ? [{ k: "skills", v: `${skills.slice(0, 3).join(", ")}${skills.length > 3 ? ` +${skills.length - 3}` : ""}`, mono: true }] : [],
      };
    }
    case "source.create":
    case "source.update":
    case "source.delete":
    case "source.sync": {
      const repo = str(d.repo);
      const target = repo ? <Handle>{repo}</Handle> : <Handle>{e.target}</Handle>;
      if (e.action === "source.sync") {
        const ingested = Array.isArray(d.ingested) ? (d.ingested as unknown[]).filter((x): x is string => typeof x === "string") : [];
        return {
          verb: "published from repository",
          target,
          facts: [
            ...(ingested.length ? [{ k: "versions", v: ingested.slice(0, 3).join(", ") + (ingested.length > 3 ? ` +${ingested.length - 3}` : ""), mono: true }] : []),
            ...(typeof d.skipped === "number" && d.skipped > 0 ? [{ k: "skipped", v: String(d.skipped) }] : []),
          ],
        };
      }
      const changed = Array.isArray(d.changed) ? (d.changed as unknown[]).filter((x): x is string => typeof x === "string") : [];
      return {
        verb: e.action === "source.create" ? "connected repository" : e.action === "source.delete" ? "disconnected repository" : "edited repository",
        severe: e.action === "source.delete",
        target,
        facts: [
          ...(str(d.provider) ? [{ k: "host", v: str(d.provider) === "github" ? "GitHub" : "Bitbucket Cloud" }] : []),
          ...(changed.length ? [{ k: "changed", v: changed.join(", "), mono: true }] : []),
        ],
      };
    }
    case "settings.update": {
      const keys = Object.keys(d).filter((k) => str(d[k]) !== null);
      return {
        verb: "changed registry settings",
        target: <span className="text-fg">{keys.length ? keys.map((k) => SETTING_LABEL[k] ?? k).join(", ") : "settings"}</span>,
        facts: keys.slice(0, 2).map((k) => ({ k: SETTING_LABEL[k] ?? k, v: str(d[k])!, mono: k === "publicUrl" })),
      };
    }
    default:
      return { verb: e.action, target: <Handle>{e.target}</Handle>, facts: [] };
  }
}

function When({ at, className }: { at: string; className?: string }) {
  return (
    <time dateTime={at} title={formatDateTime(at)} className={cx("text-sm whitespace-nowrap text-fg-muted tabular", className)}>
      {relativeTime(at)}
    </time>
  );
}

function Facts({ facts, className }: { facts: Fact[]; className?: string }) {
  if (!facts.length) return null;
  return (
    <span className={cx("flex min-w-0 flex-wrap gap-x-4 gap-y-0.5", className)}>
      {facts.map((f) => (
        <MetaKey
          key={f.k}
          k={f.fm ? f.k : f.k.charAt(0).toUpperCase() + f.k.slice(1)}
          keys={f.fm ? "frontmatter" : "label"}
          mono={f.mono}
          className="max-w-full [&>span:last-child]:break-words"
        >
          {f.v}
        </MetaKey>
      ))}
    </span>
  );
}

const actorName = (e: AuditEntry, people?: Map<string, string>) => (e.actor ? (people?.get(e.actor) ?? e.actor) : "System");

// ---------- table (Activity page) ----------

const CELL = "px-3 first:pl-1 last:pr-1 md:first:pl-3 md:last:pr-3";

/**
 * The audit trail as a table: When, Who, Action, Target, Details. On phones each row becomes one
 * sentence ("Maya Chen yanked pr-review") with its details underneath and the time on the right.
 */
export function AuditTable({ entries, people, label = "Activity" }: { entries: AuditEntry[]; people?: Map<string, string>; label?: string }) {
  return (
    <table aria-label={label} className="w-full border-collapse text-sm">
      <thead className="max-md:hidden">
        <tr className="border-b border-line">
          {["When", "Who", "Action", "Target", "Details"].map((h) => (
            <th key={h} scope="col" className={cx(CELL, "h-8 text-left text-xs font-medium text-fg-subtle")}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const p = auditParts(e);
          const who = actorName(e, people);
          return (
            <tr key={e.id} className="border-b border-line align-top transition-colors duration-[120ms] last:border-b-0 hover:bg-surface-2/60">
              {/* phone composition */}
              <td className="px-1 py-3 md:hidden">
                <div className="flex items-start gap-3">
                  <p className="min-w-0 flex-1 leading-5 text-fg-muted">
                    <span className="font-medium text-fg">{who}</span> <span className={cx(p.severe && "text-danger-text")}>{p.verb}</span> {p.target}
                  </p>
                  <When at={e.at} className="text-xs text-fg-subtle" />
                </div>
                <Facts facts={p.facts} className="mt-1" />
              </td>
              {/* desktop cells */}
              <td className="w-[8.5rem] py-2.5 pr-3 pl-3 max-md:hidden">
                <When at={e.at} />
              </td>
              <td className="w-[11rem] px-3 py-2.5 max-md:hidden">
                <span className="flex min-w-0 items-center gap-2" title={e.actor ?? undefined}>
                  {e.actor ? <PersonMark handle={e.actor} name={who} size={18} /> : <span aria-hidden className="size-[18px] shrink-0 rounded-full border border-dashed border-line-strong" />}
                  <span className="truncate text-fg">{who}</span>
                </span>
              </td>
              <td className={cx("w-[10rem] px-3 py-2.5 whitespace-nowrap max-md:hidden", p.severe ? "text-danger-text" : "text-fg-muted")}>{p.verb}</td>
              <td className="px-3 py-2.5 break-words max-md:hidden xl:whitespace-nowrap">{p.target}</td>
              <td className="py-2.5 pr-3 pl-3 max-md:hidden">
                {p.facts.length ? <Facts facts={p.facts} /> : <span className="text-fg-subtle" aria-label="No details">-</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AuditTableSkeleton({ rows = 8 }: { rows?: number }) {
  const w = ["w-16", "w-24", "w-20", "w-28", "w-40"];
  return (
    <table aria-busy="true" aria-label="Loading activity" className="w-full border-collapse text-sm">
      <thead className="max-md:hidden">
        <tr className="border-b border-line">
          {["When", "Who", "Action", "Target", "Details"].map((h) => (
            <th key={h} scope="col" className={cx(CELL, "h-8 text-left text-xs font-medium text-fg-subtle")}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i} aria-hidden className="border-b border-line last:border-b-0">
            <td className="px-1 py-3.5 md:hidden">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </td>
            {w.map((x, c) => (
              <td key={c} className={cx("h-10 px-3 max-md:hidden", c === 0 && "pl-3", c === w.length - 1 && "pr-3")}>
                <Skeleton className={cx("h-3", x)} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- dense sentence rows (lists inside other pages) ----------

export function AuditRow({ e, dense }: { e: AuditEntry; dense?: boolean }) {
  const p = auditParts(e);
  return (
    <li className={cx("flex items-start gap-3", dense ? "px-4 py-2.5" : "px-5 py-3 md:px-8")}>
      <div className="min-w-0 flex-1 text-sm leading-5 text-fg-muted">
        <p>
          <span className="font-medium text-fg">{actorName(e)}</span> <span className={cx(p.severe && "text-danger-text")}>{p.verb}</span> {p.target}
        </p>
        <Facts facts={p.facts} className="mt-0.5" />
      </div>
      <When at={e.at} className="shrink-0 text-xs text-fg-subtle" />
    </li>
  );
}

export function AuditSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-busy="true" aria-label="Loading activity" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3.5 md:px-8">
          <Skeleton className="h-3 max-w-md flex-1" />
          <Skeleton className="h-3 w-14" />
        </li>
      ))}
    </ul>
  );
}
