# The demo

The demo is a real registry, seeded through its own API with a fictional company called acme-skills.
Every name, person and repository in it is invented.

## Start it

You need Node 24 and pnpm.

```sh
pnpm install
pnpm demo
```

`pnpm demo` builds everything, starts a fresh registry on port 7720 and seeds it.
The expected output ends with the console address and a sign-in token:

```
console:  http://localhost:7720   (sign in by pasting the token below)
sign in as maya (admin) with: isk_...
```

Open http://localhost:7720, paste the token, and you are Maya Chen, an administrator.
Every run starts from an empty database, so the demo is always the same.
Stop it with `scripts/dev/down.sh`.

## Who is in it

The other people's tokens are in `.data/dev/seed.log`.
Sign out (bottom of the left rail) and paste one to see the console as that person.

| Person | Handle | Role | Teams |
|---|---|---|---|
| Maya Chen | `maya` | Admin | Platform (maintainer), Security |
| Noor Haddad | `noor` | Admin | Security (maintainer), Data |
| Ravi Iyer | `ravi` | Member | Platform (maintainer) |
| Lena Ortiz | `lena` | Member | Frontend (maintainer) |
| Sam Okafor | `sam` | Member | Data (maintainer) |
| Jonas Berg | `jonas` | Member | Platform, Security |
| Kim Tran | `kim` | Member | Frontend |
| Dev Patel | `dev` | Member | Frontend |

Kim is the one to try for a plain member's view: no admin pages, and private skills of other teams are simply absent.

## A short tour

1. **Home.** The setup line for a new machine, the skills owned by your teams, what is trending this week, the stacks and the collections.
2. **Skills.** Type `stack:terraform`, `kind:plugin` or `is:verified` in the search, or use the filters on the left. `Ctrl K` / `⌘ K` opens the command palette from anywhere.
3. **A skill:** open `terraform-module-review`. The install card has a tab for each way to install it. The right rail shows the behaviors found at publish, what it costs in an agent's context, and where each version came from. **Versions** compares any two versions file by file.
4. **A plugin:** open `deploy-tools`. **Components** lists its command, agent, hook, MCP server and executables, and **Behaviors** explains what will run without asking.
5. **A rule:** open `backend-logging` and choose **Renders as** to see the Cursor, Claude Code and Codex files it becomes.
6. **Stacks and Teams.** Skills ranked per technology, and each team's skills and collections, such as `@platform/starter`, which installs in one line.
7. **Proposals.** Three open pull requests, each with its status in plain words.
8. **Admin.** **Review** is the queue of versions waiting for an admin to verify them. **Repositories** shows a connected GitHub repository; it has no credential on purpose, so **Test** and **Sync now** explain what is missing rather than reaching GitHub.

## Try the CLI against it

In another terminal, from the repository:

```sh
export INTRA_SKILLS_HOME="$PWD/.data/demo-cli"     # keep the demo out of your real ~/.intra-skills
node packages/cli/dist/bin.js login --registry http://localhost:7720 --token "$(cat .data/dev/admin-token)"
node packages/cli/dist/bin.js search review
node packages/cli/dist/bin.js run terraform-module-review
```

`run` prints the skill for one session and writes nothing to disk.
`install` would write into your real `~/.claude/skills` and `~/.agents/skills`, so add `--project` and run it in a scratch folder if you want to see an install.
