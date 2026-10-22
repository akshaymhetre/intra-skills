# intra-skills console - design direction v2

Replaces v1 (Swiss utilitarian, cold neutrals, selection blue), which read as a flat admin table.
Every line is a decision with a reason.
Anything not decided here follows ordinary application-UI conventions.

## The brief that pins it

The console should feel like a developer tool people already trust, show why a skill is safe to install, group skills by team and tech stack, and use border-beam or glow effects only where they earn a place.
So the feel is pinned: warm near-black ground, Plus Jakarta Sans for prose and headings, IBM Plex Mono for identifiers and commands, dotted rules, ranked rows, people next to the work.
The identity: the signal colour, the wordmark, the information architecture, and the two effects.

## Card

- **Subject inventory:** the `SKILL.md` file and its frontmatter; `metadata.team / areas / stacks / tags / tools`; semver versions and `latest`; sha256 bundle hashes; yanked versions; `skills.lock.json`; the `intra install` line and the terminal it runs in; the three landing folders (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`); pull requests, approvals and merges; teammates' works / broken votes; the behaviors scan (what a skill tells an agent to do); token cost.
- **Audience scene:** engineers mid-task, usually in dark mode, fluent in npm, GitHub and a terminal; also their coding agents, which read the same commands. Three intents: find a skill for what I am doing, install it in one line, check it is trustworthy. Admins come rarely: connect a repo, review, add people.
- **Mode:** Operate on every app screen. Home and Get started are Operate pages with one display-size heading each, not marketing pages.
- **Idea:** "On this console, every skill is one terminal line away: the install command is the hero of every surface, and the amber block cursor marks where you are."
- **Style family:** editorial dark utility: type-led hierarchy, hairlines and dotted rules, ranked lists, no card grids for lists, people and teams as small marks.
- **Theme:** both, designed separately. Dark is a terminal at night (warm graphite, hue about 60); light is warm paper. Neither is an inversion.
- **Colour strategy:** Restrained.
  - Ink-filled primary buttons.
  - ONE signal colour: amber, the block cursor of a terminal. It marks the current nav item, the selected tab, focus, the `latest` marker, the install card's beam and ring, and a still block cursor after the two hero titles (Home, Get started). Nothing else: not row sparklines, not heading words.
  - Changed 2026-10-16 after two blind critiques: the v2 draft underlined one word per heading in amber, and it read as a link.
  - Semantic: success green (verified, active, copied), danger red (yanked, broken, delete), warning yellow-olive (deprecated), kept apart from amber on purpose.
  - Every text pair measured AA in both themes (styles.css header).
- **Type:**
  - Plus Jakarta Sans (variable) for UI, prose and display; display steps tracked -0.032em at 650 weight.
  - IBM Plex Mono for every identifier and command: skill names, versions, hashes, paths, frontmatter keys, `intra ...` lines.
  - Self-hosted with fontsource: the registry runs inside a company network and must not call Google.
  - Scale (px): 12 / 13 / 14 / 16 / 20 / 28, plus 36 / 52 for the one display heading on Home and Get started. Body 14. Tabular figures for every count.
- **Density:** compact. 4 px base, ranked rows about 64 px (two lines), tables 40 px, inputs 36 px desktop, 44 px touch.
- **Signature move:** the install line. It is the hero of every skill page (inside the beam card), the setup card on Home, an action on every row (on hover and focus with a pointer, always visible on touch), and the closing line of every collection and suggestion. Copying turns its `$` into a check for 1.5 s.
- **Motion budget:**
  - The one authored moment: the border beam on the install card (5.5 s loop, one 1px amber arc). Also on the open command palette, because that is where an install starts from the keyboard.
  - The wordmark cursor blinks three times on load, then holds.
  - Spotlight glow follows the pointer on team and stack tiles only.
  - Response motion: 120 ms colour transitions, 2 px lift on hover for tiles and rows, floating layers fade and lift 4 px in 160 ms.
  - `prefers-reduced-motion`: the beam becomes a static amber ring, no blink, no lift.
- **Depth / 3D:** none. Ground, panel and raised surfaces separated by lightness and hairlines; shadow only on floating layers.
- **Refusing:**
  - an indigo or violet accent, or a red signal colour;
  - identical rounded cards in a three-column grid for lists;
  - a coloured pill for every tag;
  - uppercase tracked eyebrow labels;
  - glow or beam on anything other than the named surfaces;
  - decorative tool logos on rows when a skill supports every tool.

## The four tests

1. **Competitor test.** "Every skill is one terminal line away" also fits other skill directories. Accepted: the subject is the same. What keeps it distinct is the cursor mark, the PR-and-approval surfaces, and team and stack as first-class places.
2. **Category guess.** "Dev tool, so near-black with a neon accent and mono everywhere." Amber is a warm cursor, not neon; mono is for identifiers only; light theme is first-class.
3. **One material.** The terminal: amber cursor, mono commands, warm phosphor-dark ground, the `$` prompt that becomes a check.
4. **Own prior.** Moved off "technical = near-black + acid accent + glowing edges" by keeping glow to two named surfaces and the ground warm, and off v1's cold Swiss table.

## Information architecture

- Rail: Home, Skills, Stacks, Teams, Proposals, Activity; You: Get started, Settings; Admin: Review, Repositories, Members, Registry.
- Home: display heading with the search, one install line for the bootstrap, then "For your team", "Trending this week" (ranked, sparkline), "Stacks" tiles, "Collections", "Recently published", and for admins a review count.
- Skill page: header (name, version, owner team, author, health, verified, trust), the install card with tabs Terminal / Agent / MCP / Project and a Run once line, then Readme / Files / Versions / Trust / Access tabs, and a right rail with the registry's facts, behaviors, token cost and provenance (git commit and pull request).
- Team page: team header, members, its skills, its collections with one-line installs.
- Stack pages: `/stacks` tiles, `/stacks/:stack` ranked list.
- Proposals: the caller's and everyone's open pull requests with status in plain words.
- Admin: Review queue (verify), Repositories (connect GitHub or Bitbucket Cloud, test, sync status), Members (with git identities), Registry (org name, public URL, stale window, poll interval).
- Get started: install the CLI, sign in by code, the agent prompt, the MCP line, all with this registry's real URL.
- Setup (first run) and Device approval are full-screen, outside the shell.
