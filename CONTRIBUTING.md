# Contributing to intra-skills

Thanks for helping.
Bug reports, documentation fixes, git-host connectors and pull requests are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it, what you expected and what happened.
  Screenshots help for anything visual.
- For a larger change, open an issue first so we can agree on the shape before you write the code.

## Set up

You need Node 24 and pnpm.

```sh
pnpm install
scripts/dev/up.sh                          # a real registry on :7720, seeded with a fictional org
pnpm --filter @intra-skills/web dev        # the console on http://localhost:5173
```

`scripts/dev/up.sh` prints an admin sign-in token and also writes it to `.data/dev/admin-token`.
Stop everything with `scripts/dev/down.sh`.

## Before you open a pull request

1. Run the checks and make sure they pass with no failures:
   ```sh
   pnpm check
   ```
2. If you changed the server or the CLI, run the end-to-end script, which drives the real server and CLI in a sandbox home directory:
   ```sh
   scripts/e2e.sh
   ```
3. If you changed the API, update [docs/API.md](docs/API.md) and the shared types in `packages/shared/src/types.ts` in the same pull request.
4. If you changed the UI, check it in both the light and dark themes, and at desktop and phone widths.
   Include before and after screenshots in the pull request.

## Conventions

- The wire contract lives in `packages/shared`; the server, the CLI and the console all import it, so they cannot drift.
- Every published version goes through one path (`packages/server/src/publish.ts`), whether it came from the CLI or a merged pull request.
- Versions are immutable and verified by sha256.
- Permissions are decided in one place (`packages/server/src/access.ts`).
- The console uses the tokens in `packages/web/src/styles.css`, not raw colours. The design spec is [packages/web/design/DIRECTION.md](packages/web/design/DIRECTION.md).
- Copy is plain, specific and in sentence case.

## Reporting a security problem

Please do not open a public issue.
See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
