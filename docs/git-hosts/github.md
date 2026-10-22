# Connect a GitHub repository

With a repository connected, every new skill, plugin and rule, and every update to one, arrives as a pull request.
The registry publishes the version once the pull request is merged with enough approvals from people other than its proposer.
This guide also covers GitHub Enterprise Server.

## How it works

1. A teammate runs `intra publish <folder>`, or proposes from the console.
2. The registry pushes a branch and opens the pull request with its own credential, so the teammate needs no GitHub access on their laptop.
3. Reviewers review and merge it on GitHub as usual.
4. The registry notices the merge, by webhook or on its poll interval, checks the approvals, and publishes the version from the merged files.

The registry never pushes to the base branch, never merges, and never changes repository settings.
An approval only counts when it comes from someone other than the proposer, the pull request's author and the registry's own account.

## 1. Create the repository

Create a repository, private or internal, with one folder per kind:

```
skills/<name>/SKILL.md
plugins/<name>/.claude-plugin/plugin.json
rules/<name>/RULE.md
```

The folder names are configurable when you connect it.
An existing repository works too: the registry reads only those folders.

Protect the base branch (**Settings, Branches** or **Rules**): require a pull request and at least one approving review before merging.
Without it, someone with write access could push straight to the branch, and the registry would see a merge with no approvals and refuse to publish it, which leaves the repository and the registry out of step.

## 2. Give the registry a credential

Choose one.

### A fine-grained personal access token

Quickest to set up.
Create it from a GitHub account that is **not** one of your reviewers, such as a bot account, because the registry never counts its own account's approval.

1. Go to **Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token**.
2. Set **Resource owner** to the organization that owns the repository, and **Repository access** to **Only select repositories**, with just the skills repository.
3. Under **Repository permissions**, grant **Contents: Read and write** and **Pull requests: Read and write**. **Metadata: Read** is added automatically.
4. Generate it and copy it. It starts with `github_pat_`.

The organization may need to approve fine-grained tokens before they work.

### A GitHub App

Best for an organization: pull requests come from the App's own bot account, and no person's token is involved.

1. Go to the organization's **Settings, Developer settings, GitHub Apps, New GitHub App**.
2. Give it a name such as `acme-skills-registry` and any homepage URL. Turn off **Webhook, Active** here; you can add a repository webhook later.
3. Under **Repository permissions**, grant **Contents: Read and write** and **Pull requests: Read and write**.
4. Create it, note the **App ID**, and under **Private keys** generate a key. GitHub downloads a `.pem` file.
5. Choose **Install App**, install it on the organization, and select only the skills repository. The **Installation ID** is the number at the end of the installation page's URL.

GitHub renames permissions from time to time, so check the names against GitHub's own documentation if one is missing.

## 3. Connect it in the console

1. Go to **Admin, Repositories, Connect a repository** and choose **GitHub**.
2. Enter the repository as `owner/name`, or paste its URL.
3. For GitHub Enterprise Server, enter the **API address**, usually `https://<your-server>/api/v3`.
4. Set the base branch, the three folders, and how many approvals a merge needs (default 1).
5. Paste the token, or the App ID, Installation ID and private key.
6. Save, then press **Test**.

**Test** checks four things in order: the credential is accepted, the repository is readable, the base branch exists, and the credential can push a branch and open pull requests.
Every check must pass before you rely on it.
Press **Sync now** to import what is already in the repository.

## 4. Add a webhook (optional)

Without a webhook, the registry checks for merged pull requests every 60 seconds.
With one, a merge publishes within seconds.

1. Edit the repository in the console, open **Webhook and default**, press **Generate** for a secret, and save. The webhook URL appears on the repository's row.
2. On GitHub, go to the repository's **Settings, Webhooks, Add webhook**.
3. Paste the URL, set **Content type** to `application/json`, and paste the same secret.
4. Choose **Let me select individual events**, then select **Pushes** and **Pull requests**.

The registry checks the `X-Hub-Signature-256` header on every delivery and refuses any it cannot verify.
A webhook only tells the registry to sync; it never carries the files.

## 5. Ask everyone to link their GitHub username

Each person links their username once, in **Settings** or with:

```sh
intra identity set github <username>
```

The registry uses it to make sure nobody approves their own proposal, so `intra publish` refuses to open a pull request until it is set.
