# Security policy

intra-skills hands out files that coding agents read and run, and it stores git credentials, so security reports matter.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
open the repository's **Security** tab and choose **Report a vulnerability**.
Do not open a public issue.

Include what you found, the steps to reproduce it, and the version or commit you tested.
You will get an acknowledgement within a few days.

## Supported versions

intra-skills is young and has no long-term support branches yet.
Fixes land on the `main` branch, so keep your install up to date (see [Upgrade](docs/install.md#upgrades)).

## Hardening your install

- Open the one-time setup link as soon as the server first starts, because whoever completes it becomes the first admin.
- Serve the registry only over HTTPS, and set `INTRA_SKILLS_PUBLIC_URL` to that address.
- Keep the data directory private and backed up. `secret.key` (or `INTRA_SKILLS_SECRET_KEY`) encrypts the stored git credentials.
- Give the registry a git credential scoped to the one skills repository, from an account that is not one of your reviewers.
- Protect the base branch on your git host, so nobody can publish by pushing straight to it.
