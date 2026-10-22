// Get started: four numbered steps from a fresh laptop to installing and publishing a skill, with
// THIS registry's real URL in every command. Each step is one action and says what you see when it
// worked. The install card (the one beam on the page) carries the three ways to set up a machine.
import { Link } from "react-router";
import { api } from "../api";
import { useAuth, useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { useRegistryMeta } from "../lib/meta";
import { agentPrompt, bootstrapCommand, installCommand, mcpClaudeCommand, runCommand } from "../lib/commands";
import { CopyCommand } from "../components/ui";
import { DottedRule, SectionHeading } from "../components/fx";
import { InstallCard } from "../components/InstallCard";
import { Page, Step } from "../components/admin/Page";
import { GitIdentityForm, identitiesText } from "../components/admin/GitIdentities";
import { useDocTitle } from "./admin/parts";

const LINK = "text-fg underline decoration-line-control underline-offset-4 hover:decoration-current";

export function GetStarted() {
  useDocTitle("Get started");
  const me = useMe();
  const { setUser } = useAuth();
  const meta = useRegistryMeta();
  // A real skill name for the example commands: the most installed one this week.
  const top = useAsync(() => api.listSkills({ sort: "trending" }), []);
  const url = meta?.publicUrl ?? window.location.origin;
  const pr = meta?.publishMode === "pull-request";
  const example = top.data?.skills[0]?.name ?? "<skill-name>";
  const team = me.teams[0]?.slug ?? "<your-team>";
  const linked = identitiesText(me.gitIdentities ?? []);

  return (
    <Page width="narrow">
      <header className="pt-10 pb-9 md:pt-14 md:pb-11">
        <SectionHeading as="h1" size="xl" cursor>
          {`${meta?.name ?? "Skills"} in four steps`}
        </SectionHeading>
        <p className="mt-4 max-w-[60ch] text-base text-fg-muted">
          Set up this laptop once, then find, try and install skills into Claude Code, Codex and Cursor from <span className="font-mono text-[0.93em] text-fg">{url}</span>.
          Your coding agent can do every step for you.
        </p>
      </header>
      <DottedRule />

      <ol className="flex flex-col gap-14 pt-10 md:pt-12">
        <Step
          n={1}
          id="gs-1"
          title="Set up your machine"
          expect={
            <>
              A browser tab opens on this site and asks you to approve a sign-in code. After you approve it, <code className="font-mono text-[0.93em] text-fg">intra setup</code>{" "}
              installs the registry's own skill into your agents and ends with a check of every folder it uses.
            </>
          }
        >
          <div className="min-w-0">
            <InstallCard
              tabs={[
                {
                  id: "terminal",
                  label: "Terminal",
                  command: bootstrapCommand(url),
                  note: "Needs Node 20 or newer. Installs the intra CLI into ~/.intra-skills without sudo, then signs you in.",
                },
                {
                  id: "agent",
                  label: "Ask your agent",
                  command: agentPrompt(url),
                  prose: true,
                  note: "Paste this into Claude Code or Codex. The agent reads the setup steps and asks you before it runs anything.",
                },
                {
                  id: "mcp",
                  label: "MCP",
                  command: mcpClaudeCommand(meta?.mcpUrl ?? `${url}/api/mcp`),
                  note: (
                    <>
                      For tools without a shell. Replace the token placeholder with one from{" "}
                      <Link to="/settings?create=token" className={LINK}>
                        Settings
                      </Link>
                      .
                    </>
                  ),
                },
              ]}
            />
          </div>
        </Step>

        <Step
          n={2}
          id="gs-2"
          title="Link your git username"
          expect={linked ? <>Linked: <span className="font-mono text-[0.93em] text-fg">{linked}</span>. You can change it later in Settings.</> : "The page says Saved, and your username shows under Settings."}
        >
          <p className="mb-5 max-w-[62ch] text-sm text-fg-muted">
            {pr ? "Every new skill and update here arrives as a pull request." : "When an admin connects a repository, every publish becomes a pull request."} The registry needs
            your username on the git host to make sure a pull request you proposed is approved by someone else, never by you. Without it,{" "}
            <code className="font-mono text-[0.93em] text-fg">intra publish</code> {pr ? "refuses to open one" : "will refuse to open one"}.
          </p>
          <div className="rounded-lg border border-line bg-surface p-4 md:p-5">
            <GitIdentityForm idBase="gs-git" user={me} save={(ids) => api.setMyGitIdentities(ids)} onSaved={setUser} compact />
          </div>
          <p className="mt-3 text-sm text-fg-subtle">
            Or from a terminal: <code className="font-mono text-[0.93em] text-fg-muted">intra identity set github &lt;username&gt;</code>
          </p>
        </Step>

        <Step
          n={3}
          id="gs-3"
          title="Find and install a skill"
          expect={
            <>
              <code className="font-mono text-[0.93em] text-fg">intra install</code> writes the skill into{" "}
              <code className="font-mono text-[0.93em] text-fg">~/.claude/skills/{example}</code> and <code className="font-mono text-[0.93em] text-fg">~/.agents/skills/{example}</code>,
              and your agent picks it up in its next session.
            </>
          }
        >
          <dl className="flex flex-col gap-4">
            <CommandItem label="Search by word or stack" command="intra search terraform" />
            <CommandItem label="See what fits the repo you are in (sends file and package names only)" command="intra suggest" />
            <CommandItem label="Try one for a single task, without installing" command={runCommand(example)} />
            <CommandItem label="Install it for Claude Code and Codex" command={installCommand(example)} />
          </dl>
          <p className="mt-4 text-sm text-fg-muted">
            Or browse{" "}
            <Link to="/skills" className={LINK}>
              Skills
            </Link>{" "}
            and copy the install line from any row.
          </p>
        </Step>

        <Step
          n={4}
          id="gs-4"
          title="Publish a skill"
          expect={
            pr ? (
              <>
                <code className="font-mono text-[0.93em] text-fg">intra publish</code> opens a pull request and prints its link. The version goes live after someone else
                approves it and it merges. Follow it on{" "}
                <Link to="/proposals" className={LINK}>
                  Proposals
                </Link>
                .
              </>
            ) : (
              <>The version is live at once, and teammates can install it with the line on its page.</>
            )
          }
        >
          <dl className="flex flex-col gap-4">
            <CommandItem label="Create a folder with a valid SKILL.md" command={`intra init my-skill --team ${team}`} />
            <CommandItem label="Check it locally: files, sizes, frontmatter and secrets" command="intra validate my-skill" />
            <CommandItem label={pr ? "Propose it as a pull request" : "Publish it"} command="intra publish my-skill" />
          </dl>
        </Step>
      </ol>
    </Page>
  );
}

function CommandItem({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd>
        <CopyCommand command={command} label={`Copy: ${command}`} />
      </dd>
    </div>
  );
}
