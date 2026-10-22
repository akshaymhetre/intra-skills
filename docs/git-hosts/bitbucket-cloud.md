# Connect a Bitbucket Cloud repository

With a repository connected, every new skill, plugin and rule, and every update to one, arrives as a pull request.
The registry publishes the version once the pull request is merged with enough approvals from people other than its proposer.

The Bitbucket Cloud connector is built from Atlassian's published API specification and tested against recorded request shapes only.
Run **Test** and one real proposal before you rely on it, and please open an issue if anything differs.

## How it works

1. A teammate runs `intra publish <folder>`, or proposes from the console.
2. The registry pushes a branch and opens the pull request with its own credential, so the teammate needs no Bitbucket access on their laptop.
3. Reviewers approve and merge it on Bitbucket as usual.
4. The registry notices the merge, by webhook or on its poll interval, checks the approvals, and publishes the version from the merged files.

The registry never pushes to the base branch, never merges, and never changes repository settings.
An approval only counts when it comes from someone other than the proposer, the pull request's author and the registry's own account.

## 1. Create the repository

Create a private repository with one folder per kind:

```
skills/<name>/SKILL.md
plugins/<name>/.claude-plugin/plugin.json
rules/<name>/RULE.md
```

The folder names are configurable when you connect it.

Protect the base branch (**Repository settings, Branch restrictions**): allow changes only through pull requests, and require at least one approval to merge.

## 2. Give the registry a credential

Choose one.

### A repository access token (recommended)

1. In the repository, go to **Repository settings, Security, Access tokens, Create access token**.
2. Grant **Repositories: Write** and **Pull requests: Write**.
3. Create it and copy it.

The token acts as its own bot user, which is never one of your reviewers.
A workspace access token with the same permissions works too.

### A username and API token

Use an account that is **not** one of your reviewers, because the registry never counts its own account's approval.
Create an API token for that account in its Atlassian account settings, with permission to write to repositories and pull requests, and enter the account's username or email with it.

Atlassian renames scopes from time to time, so check the names against Atlassian's own documentation if one is missing.

## 3. Connect it in the console

1. Go to **Admin, Repositories, Connect a repository** and choose **Bitbucket Cloud**.
2. Enter the repository as `workspace/repo-slug`, or paste its URL.
3. Set the base branch, the three folders, and how many approvals a merge needs (default 1).
4. Paste the access token, or the username and API token.
5. Save, then press **Test**.

**Test** checks that the credential is accepted, the repository is readable, the base branch exists, and the credential can push and open pull requests.
For an access token the last check cannot be verified ahead of time, so the result says which permissions to confirm.
Press **Sync now** to import what is already in the repository.

## 4. Add a webhook (optional)

Without a webhook, the registry checks for merged pull requests every 60 seconds.
With one, a merge publishes within seconds.

1. Edit the repository in the console, open **Webhook and default**, press **Generate** for a secret, and save. The webhook URL appears on the repository's row.
2. On Bitbucket, go to **Repository settings, Webhooks, Add webhook**.
3. Paste the URL and the same secret.
4. Under triggers, select **Repository: Push** and **Pull request: Merged**.

The registry checks the `X-Hub-Signature` header on every delivery and refuses any it cannot verify.

## 5. Ask everyone to link their Bitbucket username

Each person links their username once, in **Settings** or with:

```sh
intra identity set bitbucket-cloud <username>
```

Use the Bitbucket username from personal Bitbucket settings, not an email address.
The registry uses it to make sure nobody approves their own proposal, so `intra publish` refuses to open a pull request until it is set.
