// Owns everything that talks to git hosts: provider clients (with decrypted credentials), syncs
// (never two of one source at once), the poller, webhooks and the proposal flow.
import type { GitCredentialInput, Proposal, SourceCheck, SyncStatus } from "@intra-skills/shared";
import type { Db } from "../db.js";
import type { Actor } from "../access.js";
import { notFound } from "../http.js";
import type { PublishBody } from "../routes/versions.js";
import { getSettings } from "../settings.js";
import { BitbucketProvider } from "./bitbucket.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { GitHubProvider } from "./github.js";
import type { GitProvider, ProviderFactory, ProviderSource } from "./provider.js";
import { propose } from "./propose.js";
import { type SourceRow, proposalRow, sourceRow, sourceRows, toProposal } from "./store.js";
import { refreshProposal, runSync } from "./sync.js";

export interface GitServiceOptions {
  /** 32-byte key that encrypts stored git credentials and webhook secrets. */
  secretKey: Buffer;
  /** Builds a provider client for a source; tests inject a fake. */
  providerFactory?: ProviderFactory;
}

export const defaultProviderFactory: ProviderFactory = (src) =>
  src.provider === "github" ? new GitHubProvider(src) : new BitbucketProvider(src);

export class GitService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** sourceId -> the sync running now. */
  private readonly running = new Map<string, Promise<SyncStatus>>();
  /** sourceId -> a sync queued behind the running one (at most one; later requests join it). */
  private readonly queued = new Map<string, Promise<SyncStatus>>();
  /** Sources whose queued run must re-read every folder (a manual sync joined it). */
  private readonly queuedFull = new Set<string>();
  /** Provider clients keyed by source id + updated_at, so a changed credential gets a fresh client. */
  private readonly providers = new Map<string, { key: string; provider: GitProvider }>();
  /** skill name -> tail of the proposal chain, so two proposals for one skill never race. */
  private readonly skillLocks = new Map<string, Promise<unknown>>();

  constructor(
    readonly db: Db,
    readonly opts: GitServiceOptions,
  ) {}

  // ---------- secrets ----------

  encryptCredential(sourceId: string, c: GitCredentialInput): string {
    return encryptSecret(this.opts.secretKey, JSON.stringify(c), `credential:${sourceId}`);
  }

  encryptWebhookSecret(sourceId: string, secret: string): string {
    return encryptSecret(this.opts.secretKey, secret, `webhook:${sourceId}`);
  }

  webhookSecret(row: SourceRow): string | null {
    if (!row.webhook_secret_enc) return null;
    try {
      return decryptSecret(this.opts.secretKey, row.webhook_secret_enc, `webhook:${row.id}`);
    } catch {
      return null; // a different server key: treat as unset, so the endpoint refuses
    }
  }

  private credential(row: SourceRow): GitCredentialInput {
    if (!row.credential_enc) throw notFound("this source has no credential");
    try {
      return JSON.parse(decryptSecret(this.opts.secretKey, row.credential_enc, `credential:${row.id}`)) as GitCredentialInput;
    } catch {
      throw new Error(`the credential of git source ${row.id} cannot be decrypted with this server's key; enter it again`);
    }
  }

  // ---------- providers ----------

  providerForRow(row: SourceRow): GitProvider {
    const key = `${row.updated_at}\n${row.credential_enc ?? ""}`;
    const hit = this.providers.get(row.id);
    if (hit && hit.key === key) return hit.provider;
    const src: ProviderSource = {
      id: row.id,
      provider: row.provider,
      repo: row.repo,
      baseBranch: row.base_branch,
      apiUrl: row.api_url,
      credential: this.credential(row),
    };
    const provider = (this.opts.providerFactory ?? defaultProviderFactory)(src);
    this.providers.set(row.id, { key, provider });
    return provider;
  }

  providerFor(sourceId: string): GitProvider {
    const row = sourceRow(this.db, sourceId);
    if (!row) throw notFound("git source not found");
    return this.providerForRow(row);
  }

  forget(sourceId: string): void {
    this.providers.delete(sourceId);
  }

  async test(sourceId: string): Promise<{ ok: boolean; checks: SourceCheck[] }> {
    let checks: SourceCheck[];
    try {
      checks = await this.providerFor(sourceId).checkAccess();
    } catch (e) {
      checks = [{ name: "credential", ok: false, message: (e as Error).message }];
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  // ---------- sync ----------

  /**
   * Sync one source and wait for it. A sync already running is never overlapped: the request
   * queues one follow-up run (so changes that landed meanwhile are seen) and every later request
   * joins that follow-up. `full` re-reads the folders even when the base branch did not move.
   */
  sync(sourceId: string, full = false): Promise<SyncStatus> {
    const running = this.running.get(sourceId);
    if (!running) return this.start1(sourceId, full);
    if (full) this.queuedFull.add(sourceId);
    const waiting = this.queued.get(sourceId);
    if (waiting) return waiting;
    const next = running
      .catch(() => undefined)
      .then(() => {
        this.queued.delete(sourceId);
        const asFull = this.queuedFull.delete(sourceId);
        return this.start1(sourceId, asFull);
      });
    this.queued.set(sourceId, next);
    return next;
  }

  private start1(sourceId: string, full: boolean): Promise<SyncStatus> {
    const p = this.doSync(sourceId, full).finally(() => {
      if (this.running.get(sourceId) === p) this.running.delete(sourceId);
    });
    this.running.set(sourceId, p);
    return p;
  }

  private async doSync(sourceId: string, full: boolean): Promise<SyncStatus> {
    const row = sourceRow(this.db, sourceId);
    if (!row) throw notFound("git source not found");
    let status: SyncStatus;
    try {
      status = await runSync(this.db, full ? { ...row, last_sync: null } : row, this.providerForRow(row));
    } catch (e) {
      status = {
        at: new Date().toISOString(),
        ok: false,
        message: (e as Error).message,
        ingested: [],
        skipped: [],
        headCommit: null,
      };
    }
    // The source may have been deleted while the sync ran; UPDATE then touches nothing.
    this.db.prepare("UPDATE git_sources SET last_sync = ? WHERE id = ?").run(JSON.stringify(status), sourceId);
    return status;
  }

  /** Fire-and-forget sync, used by webhooks and the poller. Failures land in last_sync. */
  trigger(sourceId: string): void {
    if (this.stopped) return;
    this.sync(sourceId).catch((e: Error) => console.error(`[intra-skills] git sync ${sourceId} failed: ${e.message}`));
  }

  /** Start polling every enabled source at the configured interval. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.stopped) return;
      for (const r of sourceRows(this.db, "WHERE enabled = 1")) if (!this.running.has(r.id)) this.trigger(r.id);
      // Re-read pollSeconds every round, so a settings change applies without a restart.
      this.timer = setTimeout(tick, getSettings(this.db).pollSeconds * 1000);
    };
    this.timer = setTimeout(tick, getSettings(this.db).pollSeconds * 1000);
  }

  /** Stop polling; resolves when no sync is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running.size > 0 || this.queued.size > 0)
      await Promise.allSettled([...this.running.values(), ...this.queued.values()]);
  }

  // ---------- proposals ----------

  private withSkillLock<T>(skill: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.skillLocks.get(skill) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.skillLocks.set(skill, tail);
    void tail.then(() => {
      if (this.skillLocks.get(skill) === tail) this.skillLocks.delete(skill);
    });
    return run;
  }

  propose(actor: Actor, name: string, body: PublishBody, sourceId: string | undefined): Promise<{ proposal: Proposal; updated: boolean }> {
    return this.withSkillLock(name, () =>
      propose({ db: this.db, providerFor: (row) => this.providerForRow(row) }, { actor, name, body, sourceId }),
    );
  }

  async refreshProposal(id: string): Promise<Proposal> {
    const row = proposalRow(this.db, id);
    if (!row) throw notFound("proposal not found");
    const src = sourceRow(this.db, row.source_id);
    if (!src) throw notFound("git source not found");
    const provider = this.providerForRow(src);
    let login: string | null = null;
    try {
      login = await provider.whoAmI();
    } catch {
      login = null;
    }
    return toProposal(await refreshProposal(this.db, provider, src, row, login));
  }
}
