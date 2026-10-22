// Trust: what teammates say after using the skill. The caller's own vote first (works or broken, with
// an optional note), then every vote, newest first.
import { useEffect, useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import type { SkillDetail, Trust, Vote } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useMe } from "../../auth";
import { useAsync } from "../../lib/useAsync";
import { formatDateTime, relativeTime } from "../../lib/format";
import { PersonMark, TrustBar } from "../../components/fx";
import { Button, EmptyState, ErrorState, InlineError, Input, Skeleton, cx, useToast } from "../../components/ui";

const NOTE_MAX = 280;

export function TrustTab({ skill, latest, onTrust }: { skill: SkillDetail; latest: string | null; onTrust: (t: Trust) => void }) {
  const me = useMe();
  const toast = useToast();
  const votes = useAsync(() => api.votes(skill.name), [skill.name]);
  const mineVote = votes.data?.find((v) => v.user.handle === me.handle) ?? null;
  const mine = skill.trust.mine;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"works" | "broken" | "remove" | null>(null);
  const [err, setErr] = useState<unknown>();
  useEffect(() => setNote(mineVote?.note ?? ""), [mineVote?.note]);

  const cast = async (works: boolean) => {
    setBusy(works ? "works" : "broken");
    setErr(undefined);
    try {
      onTrust(await api.vote(skill.name, { works, note: note.trim() || undefined }));
      votes.reload();
      toast({ message: works ? "Recorded: works for you" : "Recorded: broken for you" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    setErr(undefined);
    try {
      onTrust(await api.unvote(skill.name));
      votes.reload();
      setNote("");
      toast({ message: "Removed your vote" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const total = skill.trust.works + skill.trust.broken;
  const noteChanged = mine !== null && note.trim() !== (mineVote?.note ?? "");

  return (
    <div className="flex max-w-[760px] flex-col gap-8">
      <section aria-labelledby="trust-mine" className="rounded-lg border border-line bg-surface p-4">
        <h2 id="trust-mine" className="text-base font-semibold text-fg">
          {mine === null ? "Did it work for you?" : "Your vote"}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {mine === null ? (
            <>Your vote counts against {latest ? <span className="font-mono text-[0.93em] text-fg">{latest}</span> : "the latest version"} and helps teammates decide.</>
          ) : (
            <>
              You said it is <span className={cx("font-medium", mine === "works" ? "text-ok-text" : "text-danger-text")}>{mine === "works" ? "working" : "broken"}</span>
              {mineVote?.version && (
                <>
                  {" "}
                  on <span className="font-mono text-[0.93em] text-fg">{mineVote.version}</span>
                </>
              )}
              . Vote again to change it.
            </>
          )}
        </p>
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor="trust-note" className="text-sm font-medium text-fg">
            Note <span className="font-normal text-fg-subtle">(optional)</span>
          </label>
          <Input
            id="trust-note"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Fails when the workspace has no backend configured"
          />
          {note.length > NOTE_MAX - 40 && <p className="text-xs text-fg-subtle tabular">{NOTE_MAX - note.length} characters left</p>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            aria-pressed={mine === "works"}
            loading={busy === "works"}
            disabled={busy !== null}
            onClick={() => void cast(true)}
            icon={<CircleCheck className="size-3.5 text-ok-text" aria-hidden />}
            className={cx(mine === "works" && "border-ok-line! bg-ok-soft! text-ok-text!")}
          >
            {mine === "works" && noteChanged ? "Save note" : "Works for me"}
          </Button>
          <Button
            aria-pressed={mine === "broken"}
            loading={busy === "broken"}
            disabled={busy !== null}
            onClick={() => void cast(false)}
            icon={<CircleX className="size-3.5 text-danger-text" aria-hidden />}
            className={cx(mine === "broken" && "border-danger-line! bg-danger-soft! text-danger-text!")}
          >
            {mine === "broken" && noteChanged ? "Save note" : "Broken for me"}
          </Button>
          {mine !== null && (
            <Button variant="ghost" loading={busy === "remove"} disabled={busy !== null} onClick={() => void remove()}>
              Remove my vote
            </Button>
          )}
        </div>
        {!!err && (
          <div className="mt-3">
            <InlineError error={err} />
          </div>
        )}
      </section>

      <section aria-labelledby="trust-all">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="trust-all" className="text-base font-semibold text-fg">
            What teammates say
          </h2>
          {total > 0 && <TrustBar trust={skill.trust} />}
        </div>
        {votes.error ? (
          <ErrorState error={votes.error} onRetry={votes.reload} title="Could not load the votes" align="start" className="px-0" />
        ) : !votes.data ? (
          <div className="mt-4 flex flex-col gap-4" aria-busy="true" aria-label="Loading votes">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-6 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : votes.data.length === 0 ? (
          <EmptyState title="No votes yet" align="start" className="px-0 py-6">
            After you use it, say whether it worked. The first vote shows up here and on every list that shows this skill.
          </EmptyState>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {votes.data.map((v) => (
              <VoteRow key={v.user.handle} v={v} you={v.user.handle === me.handle} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function VoteRow({ v, you }: { v: Vote; you: boolean }) {
  return (
    <li className="flex gap-3 py-3.5">
      <PersonMark handle={v.user.handle} name={v.user.displayName} size={24} className="mt-px" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium text-fg">{v.user.displayName}</span>
          {you && <span className="text-xs text-fg-subtle">you</span>}
          <span className={cx("inline-flex items-center gap-1 self-center text-sm font-medium", v.works ? "text-ok-text" : "text-danger-text")}>
            {v.works ? <CircleCheck className="size-3.5" aria-hidden /> : <CircleX className="size-3.5" aria-hidden />}
            {v.works ? "Works" : "Broken"}
          </span>
          <span className="text-fg-subtle">
            {v.version && (
              <>
                on <span className="font-mono text-xs">{v.version}</span>
                {" · "}
              </>
            )}
            <time dateTime={v.at} title={formatDateTime(v.at)}>
              {relativeTime(v.at)}
            </time>
          </span>
        </p>
        {v.note && <p className="mt-1 max-w-[68ch] text-sm text-fg-muted">{v.note}</p>}
      </div>
    </li>
  );
}
